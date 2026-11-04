import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess, shell, powerSaveBlocker, powerMonitor } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSchema, telegramCredentialsSchema, telegramBindingSchema, type TelegramBinding, type TelegramCredentials, type AppSnapshot, type CommandResult } from '../shared/model';
import { TelegramBindingClient } from '../service/telegram-binding';
import { telegramFetch } from './telegram-network';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.TRADEMASTER_DATA_DIR || (app.isPackaged ? app.getPath('userData') : resolve('.local/app-data'));
let window: BrowserWindow | null = null;
let worker: ReturnType<typeof utilityProcess.fork> | null = null;
let currentState: AppSnapshot | undefined;
let engineError: string | null = null;
let sequence = 0;
let monitoringPowerBlocker: number | undefined;
function updateMonitoringPower(state?: AppSnapshot): void {
  const active = Boolean(state?.settings.monitoring && state.signals.some(signal => signal.enabled));
  if (active && monitoringPowerBlocker === undefined) monitoringPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!active && monitoringPowerBlocker !== undefined) {
    powerSaveBlocker.stop(monitoringPowerBlocker); monitoringPowerBlocker = undefined;
  }
}
const pending = new Map<number, { resolve: (result: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();

function readToken(): string {
  const path = join(dataDirectory, 'credentials.enc');
  if (existsSync(path) && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(readFileSync(path)); } catch { /* show unconfigured, don't log secrets */ }
  }
  return '';
}
function saveToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование недоступно: ключ не сохранён');
  const path = join(dataDirectory, 'credentials.enc'), temporary = path + '.tmp';
  writeFileSync(temporary, safeStorage.encryptString(token), { mode: 0o600 });
  renameSync(temporary, path);
}
function readTelegramBinding(): TelegramBinding | undefined {
  const path = join(dataDirectory, 'telegram.enc');
  try {
    if (existsSync(path) && safeStorage.isEncryptionAvailable()) return telegramBindingSchema.safeParse(JSON.parse(safeStorage.decryptString(readFileSync(path)))).data;
  } catch { /* Do not expose secrets in parsing/decryption errors. */ }
}
function readTelegram(): TelegramCredentials | undefined { return telegramCredentialsSchema.safeParse(readTelegramBinding()).data; }
function saveTelegram(credentials: TelegramBinding): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование недоступно');
  const path = join(dataDirectory, 'telegram.enc'), temporary = path + '.tmp';
  writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 }); renameSync(temporary, path);
}
function send(payload: object): Promise<CommandResult> {
  if (!worker) return Promise.resolve({ ok: false, error: 'Движок недоступен' });
  const id = ++sequence;
  return new Promise(resolveResult => {
    const timer = setTimeout(() => { pending.delete(id); resolveResult({ ok: false, error: 'Превышено время ожидания ответа' }); }, 120000);
    pending.set(id, { resolve: resolveResult, timer });
    worker!.postMessage({ ...payload, id });
  });
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1100, minHeight: 720,
    backgroundColor: '#101014', title: 'TradeMaster', autoHideMenuBar: true,
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(here, '../renderer/index.html'));
  window.on('closed', () => { window = null; });
}

void app.whenReady().then(async () => {
  mkdirSync(dataDirectory, { recursive: true });
  worker = utilityProcess.fork(join(here, 'worker.js'), [], { serviceName: 'TradeMaster Engine' });
  worker.on('message', async message => {
    if (message.kind === 'telegramPair') {
      try {
        const current = readTelegramBinding();
        if (!current?.pairingCode || current.pairingCode !== message.code || (current.pairingExpiresAt ?? 0) <= Date.now() ||
          !message.chat || message.chat.type !== 'private' || !/^\d{1,20}$/.test(message.chat.id)) throw new Error('Ссылка устарела');
        const bound = telegramBindingSchema.parse({ token: current.token, botUsername: current.botUsername, chatId: message.chat.id, chatLabel: String(message.chat.label).slice(0, 200) });
        saveTelegram(bound);
        worker?.postMessage({ kind: 'telegramPairResult', id: message.id, binding: bound });
      } catch { worker?.postMessage({ kind: 'telegramPairResult', id: message.id }); }
      return;
    }
    if (message.kind === 'state') { currentState = message.state; updateMonitoringPower(currentState); window?.webContents.send('terminal:state', message.state); }
    if (message.kind === 'signalSound') window?.webContents.send('terminal:signal-sound', message.volume);
    if (message.kind === 'result') { const job = pending.get(message.id); if (job) { clearTimeout(job.timer); pending.delete(message.id); job.resolve(message.result); } }
    if (message.kind === 'fatal') { engineError = message.error; currentState = undefined; updateMonitoringPower(); window?.webContents.send('terminal:fatal', message.error); }
  });
  worker.on('exit', () => {
    worker = null;
    engineError = 'Движок остановлен. Перезапустите приложение.'; currentState = undefined;
    updateMonitoringPower();
    for (const job of pending.values()) { clearTimeout(job.timer); job.resolve({ ok: false, error: 'Движок остановлен' }); }
    pending.clear();
    window?.webContents.send('terminal:fatal', 'Движок остановлен. Перезапустите приложение.');
  });
  worker.postMessage({ kind: 'initialize', directory: dataDirectory, token: process.env.TRADEMASTER_REPLAY_ONLY === '1' ? '' : readToken(), telegramBinding: readTelegramBinding() });
  powerMonitor.on('resume', () => {
    updateMonitoringPower(currentState);
    worker?.postMessage({ kind: 'resume' });
  });
  ipcMain.handle('terminal:command', async (event, input): Promise<CommandResult> => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Недопустимый отправитель' };
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'Проверьте введённые параметры' };
    if (parsed.data.type === 'getTelegramSettings') {
      const config = readTelegramBinding(); return { ok: true, data: { configured: Boolean(config?.chatId), tokenStored: Boolean(config), chatId: config?.chatId ?? '', botUsername: config?.botUsername ?? '', chatLabel: config?.chatLabel ?? '' } };
    }
    if (parsed.data.type === 'getTelegramToken') {
      const config = readTelegramBinding(); return config ? { ok: true, data: { token: config.token } } : { ok: false, error: 'Сохранённый токен Telegram недоступен' };
    }
    if (['saveTelegramBot', 'findTelegramChats', 'bindTelegramChat', 'openTelegramBot', 'disconnectTelegram'].includes(parsed.data.type)) {
      try {
        const previous = readTelegramBinding();
        if (parsed.data.type === 'disconnectTelegram') {
          const result = await send({ kind: 'telegramCredentials', telegram: undefined });
          if (!result.ok) return result;
          const path = join(dataDirectory, 'telegram.enc'); if (existsSync(path)) unlinkSync(path);
          return { ok: true };
        }
        if (parsed.data.type === 'saveTelegramBot') {
          if (previous?.token === parsed.data.token) return { ok: true };
          saveTelegram({ token: parsed.data.token });
          return await send({ kind: 'telegramCredentials', telegram: { token: parsed.data.token } });
        }
        if (!previous) return { ok: false, error: 'Сначала сохраните токен бота' };
        const client = new TelegramBindingClient(previous.token, telegramFetch);
        if (parsed.data.type === 'findTelegramChats') {
          return { ok: false, error: 'Привяжите чат кнопкой «Привязать через бота». Ручной поиск Chat ID больше не требуется.' };
        }
        if (parsed.data.type === 'openTelegramBot') {
          const username = previous.botUsername ?? (await client.bot()).username;
          if (readTelegramBinding()?.token !== previous.token) return { ok: false, error: 'Бот изменён. Откройте ссылку заново.' };
          const updated = { ...readTelegramBinding()!, botUsername: username, pairingCode: randomBytes(16).toString('hex'), pairingExpiresAt: Date.now() + 15 * 60000 };
          saveTelegram(updated);
          const result = await send({ kind: 'telegramCredentials', telegram: updated });
          if (!result.ok) return result;
          await shell.openExternal(`https://t.me/${username}?start=tm_${updated.pairingCode}`); return { ok: true, data: { botUsername: username } };
        }
        if (parsed.data.type === 'bindTelegramChat') {
          const chat = await client.verifyChat(parsed.data.chatId);
          const updated = { ...previous, chatId: chat.id, chatLabel: chat.label };
          saveTelegram(updated);
          const result = await send({ kind: 'telegramCredentials', telegram: updated });
          return result.ok ? { ok: true, data: { chatId: chat.id, chatLabel: chat.label } } : result;
        }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось настроить Telegram' }; }
    }
    if (parsed.data.type === 'setTelegramSettings') {
      const previous = readTelegram();
      const credentials = telegramCredentialsSchema.safeParse({ token: parsed.data.token ?? previous?.token, chatId: parsed.data.chatId });
      if (!credentials.success) return { ok: false, error: 'Введите токен бота и корректный Chat ID' };
      if (previous?.token === credentials.data.token && previous.chatId === credentials.data.chatId) return { ok: true };
      try { saveTelegram(credentials.data); return await send({ kind: 'telegramCredentials', telegram: credentials.data }); }
      catch { return { ok: false, error: 'Не удалось сохранить настройки Telegram с системным шифрованием' }; }
    }
    if (parsed.data.type === 'getSourceToken') {
      if (!['itick', 'itick-trial'].includes(parsed.data.source)) return { ok: false, error: 'Для этого источника нет поля ключа' };
      try {
        const token = readToken();
        return token ? { ok: true, data: { token } } : { ok: false, error: 'Не удалось прочитать сохранённый ключ' };
      } catch { return { ok: false, error: 'Не удалось прочитать сохранённый ключ' }; }
    }
    if (engineError) return { ok: false, error: engineError };
    if (parsed.data.type === 'snapshot' && currentState && worker) return { ok: true, data: currentState };
    if (parsed.data.type === 'setSourceToken') {
      if (!['itick', 'itick-trial'].includes(parsed.data.source)) return { ok: false, error: 'Для этого источника нет поля ключа' };
      try { saveToken(parsed.data.token); return await send({ kind: 'credentials', token: parsed.data.token }); }
      catch { return { ok: false, error: 'Не удалось сохранить ключ в системном защищённом хранилище' }; }
    }
    return send({ kind: 'command', command: parsed.data });
  });
  await createWindow();
  app.on('activate', () => { if (!window) void createWindow(); });
});
let quitting = false;
app.on('before-quit', event => {
  if (!worker || quitting) return;
  event.preventDefault(); quitting = true;
  void Promise.race([send({ kind: 'shutdown' }), new Promise(resolve => setTimeout(resolve, 2500))]).finally(() => { worker?.kill(); app.quit(); });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => updateMonitoringPower());
