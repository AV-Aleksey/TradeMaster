import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess, shell, powerSaveBlocker, powerMonitor, nativeImage } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSchema, telegramCredentialsSchema, telegramBindingSchema, type TelegramBinding, type TelegramCredentials, type AppSnapshot, type CommandResult, isMainCommand } from '../shared/model';
import { TelegramBindingClient } from '../service/telegram-binding';
import { telegramFetch } from './telegram-network';
import { randomBytes } from 'node:crypto';
import { descriptors } from '../providers/contracts';
import { ConfigurationFiles } from '../service/configuration-files';

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

function credentialPath(source: string): string {
  const id = descriptors.find(provider => provider.id === source)?.credentialId;
  if (!id) throw new Error('Для этого источника нет поля ключа');
  return join(dataDirectory, id === 'itick' ? 'credentials.enc' : `credentials-${id}.enc`);
}
// Serialize complete credential actions, including Telegram read/modify/write flows.
// Async OS encryption must not allow an older action to overwrite a replacement.
let credentialOperations: Promise<unknown> = Promise.resolve();
function withCredentials<T>(action: () => Promise<T>): Promise<T> {
  const operation = credentialOperations.then(action);
  credentialOperations = operation.catch(() => {});
  return operation;
}
async function writeSecret(path: string, value: string): Promise<void> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Системное шифрование недоступно: ключ не сохранён');
  const encrypted = await safeStorage.encryptStringAsync(value);
  const temporary = path + '.tmp';
  writeFileSync(temporary, encrypted, { mode: 0o600 });
  renameSync(temporary, path);
}
async function readSecret(path: string): Promise<string | undefined> {
  try {
    if (!existsSync(path) || !await safeStorage.isAsyncEncryptionAvailable()) return;
    const decrypted = await safeStorage.decryptStringAsync(readFileSync(path));
    if (decrypted.shouldReEncrypt) {
      try { await writeSecret(path, decrypted.result); } catch { /* Keep the old file and readable value if rotation cannot be persisted. */ }
    }
    return decrypted.result;
  } catch { /* Leave unreadable files intact; never log their contents. */ }
}
async function readToken(source = 'itick'): Promise<string> {
  return await readSecret(credentialPath(source)) ?? '';
}
async function saveToken(token: string, source = 'itick'): Promise<void> {
  await writeSecret(credentialPath(source), token);
}
async function readTelegramBinding(): Promise<TelegramBinding | undefined> {
  try {
    const value = await readSecret(join(dataDirectory, 'telegram.enc'));
    if (value !== undefined) return telegramBindingSchema.safeParse(JSON.parse(value)).data;
  } catch { /* Do not expose secrets in parsing/decryption errors. */ }
}
async function readTelegram(): Promise<TelegramCredentials | undefined> { return telegramCredentialsSchema.safeParse(await readTelegramBinding()).data; }
async function saveTelegram(credentials: TelegramBinding): Promise<void> {
  await writeSecret(join(dataDirectory, 'telegram.enc'), JSON.stringify(credentials));
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
const configurationFiles = new ConfigurationFiles({
  save: async defaultPath => {
    if (!window) return;
    const result = await dialog.showSaveDialog(window, { title: 'Экспорт TradeMaster', defaultPath, filters: [{ name: 'TradeMaster JSON', extensions: ['json'] }] });
    return result.canceled ? undefined : result.filePath;
  },
  open: async () => {
    if (!window) return;
    const result = await dialog.showOpenDialog(window, { title: 'Импорт TradeMaster', properties: ['openFile'], filters: [{ name: 'TradeMaster JSON', extensions: ['json'] }] });
    return result.canceled ? undefined : result.filePaths[0];
  },
}, (scope, signalIds) => send({ kind: 'command', command: { type: 'exportConfiguration', scope, signalIds } }),
  (configuration, mode) => send({ kind: 'importConfiguration', configuration, mode }));
async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icon.png'));
  if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1100, minHeight: 720,
    backgroundColor: '#101014', title: 'TradeMaster', autoHideMenuBar: true, icon,
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
  if (process.env.TRADEMASTER_DATA_DIR) app.setPath('userData', resolve(dataDirectory));
  const credentialSources = new Map(descriptors.filter(provider => provider.credentialId).map(provider => [provider.credentialId!, provider.id]));
  const tokens: Record<string, string> = process.env.TRADEMASTER_REPLAY_ONLY === '1' ? {} : Object.fromEntries(await Promise.all(
    [...credentialSources].map(async ([id, source]) => [id, await readToken(source)])));
  const telegramBinding = await readTelegramBinding();
  worker = utilityProcess.fork(join(here, 'worker.js'), [], { serviceName: 'TradeMaster Engine' });
  worker.on('message', async message => {
    if (message.kind === 'telegramPair') {
      await withCredentials(async () => {
        try {
          const current = await readTelegramBinding();
          if (!current?.pairingCode || current.pairingCode !== message.code || (current.pairingExpiresAt ?? 0) <= Date.now() ||
            !message.chat || message.chat.type !== 'private' || !/^\d{1,20}$/.test(message.chat.id)) throw new Error('Ссылка устарела');
          const bound = telegramBindingSchema.parse({ token: current.token, botUsername: current.botUsername, chatId: message.chat.id, chatLabel: String(message.chat.label).slice(0, 200) });
          await saveTelegram(bound);
          worker?.postMessage({ kind: 'telegramPairResult', id: message.id, binding: bound });
        } catch { worker?.postMessage({ kind: 'telegramPairResult', id: message.id }); }
      });
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
  worker.postMessage({ kind: 'initialize', directory: dataDirectory, tokens, telegramBinding });
  powerMonitor.on('resume', () => {
    updateMonitoringPower(currentState);
    worker?.postMessage({ kind: 'resume' });
  });
  ipcMain.handle('terminal:command', async (event, input): Promise<CommandResult> => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Недопустимый отправитель' };
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'Проверьте введённые параметры' };
    const execute = async (): Promise<CommandResult> => {
      try {
        if (parsed.data.type === 'exportConfigurationFile') return await configurationFiles.export(parsed.data.scope, parsed.data.signalIds);
        if (parsed.data.type === 'previewConfigurationFile') return await configurationFiles.preview();
        if (parsed.data.type === 'applyConfigurationFile') return await configurationFiles.apply(parsed.data.importId, parsed.data.mode);
        if (parsed.data.type === 'cancelConfigurationFile') return configurationFiles.cancel(parsed.data.importId);
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось обработать файл конфигурации' }; }
      if (parsed.data.type === 'getTelegramSettings') {
        const config = await readTelegramBinding(); return { ok: true, data: { configured: Boolean(config?.chatId), tokenStored: Boolean(config), chatId: config?.chatId ?? '', botUsername: config?.botUsername ?? '', chatLabel: config?.chatLabel ?? '' } };
      }
      if (parsed.data.type === 'getTelegramToken') {
        const config = await readTelegramBinding(); return config ? { ok: true, data: { token: config.token } } : { ok: false, error: 'Сохранённый токен Telegram недоступен' };
      }
      if (['saveTelegramBot', 'findTelegramChats', 'bindTelegramChat', 'openTelegramBot', 'disconnectTelegram'].includes(parsed.data.type)) {
        try {
          const previous = await readTelegramBinding();
          if (parsed.data.type === 'disconnectTelegram') {
            const result = await send({ kind: 'telegramCredentials', telegram: undefined });
            if (!result.ok) return result;
            const path = join(dataDirectory, 'telegram.enc'); if (existsSync(path)) unlinkSync(path);
            return { ok: true };
          }
          if (parsed.data.type === 'saveTelegramBot') {
            if (previous?.token === parsed.data.token) return { ok: true };
            await saveTelegram({ token: parsed.data.token });
            return await send({ kind: 'telegramCredentials', telegram: { token: parsed.data.token } });
          }
          if (!previous) return { ok: false, error: 'Сначала сохраните токен бота' };
          const client = new TelegramBindingClient(previous.token, telegramFetch);
          if (parsed.data.type === 'findTelegramChats') {
            return { ok: false, error: 'Привяжите чат кнопкой «Привязать через бота». Ручной поиск Chat ID больше не требуется.' };
          }
          if (parsed.data.type === 'openTelegramBot') {
            const username = previous.botUsername ?? (await client.bot()).username;
            const current = await readTelegramBinding();
            if (current?.token !== previous.token) return { ok: false, error: 'Бот изменён. Откройте ссылку заново.' };
            const updated = { ...current!, botUsername: username, pairingCode: randomBytes(16).toString('hex'), pairingExpiresAt: Date.now() + 15 * 60000 };
            await saveTelegram(updated);
            const result = await send({ kind: 'telegramCredentials', telegram: updated });
            if (!result.ok) return result;
            await shell.openExternal(`https://t.me/${username}?start=tm_${updated.pairingCode}`); return { ok: true, data: { botUsername: username } };
          }
          if (parsed.data.type === 'bindTelegramChat') {
            const chat = await client.verifyChat(parsed.data.chatId);
            const updated = { ...previous, chatId: chat.id, chatLabel: chat.label };
            await saveTelegram(updated);
            const result = await send({ kind: 'telegramCredentials', telegram: updated });
            return result.ok ? { ok: true, data: { chatId: chat.id, chatLabel: chat.label } } : result;
          }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось настроить Telegram' }; }
      }
      if (parsed.data.type === 'setTelegramSettings') {
        const previous = await readTelegram();
        const credentials = telegramCredentialsSchema.safeParse({ token: parsed.data.token ?? previous?.token, chatId: parsed.data.chatId });
        if (!credentials.success) return { ok: false, error: 'Введите токен бота и корректный Chat ID' };
        if (previous?.token === credentials.data.token && previous.chatId === credentials.data.chatId) return { ok: true };
        try { await saveTelegram(credentials.data); return await send({ kind: 'telegramCredentials', telegram: credentials.data }); }
        catch { return { ok: false, error: 'Не удалось сохранить настройки Telegram с системным шифрованием' }; }
      }
      if (parsed.data.type === 'getSourceToken') {
        const source = parsed.data.source;
        if (!descriptors.find(provider => provider.id === source)?.credentialId) return { ok: false, error: 'Для этого источника нет поля ключа' };
        try {
          const token = await readToken(source);
          return token ? { ok: true, data: { token } } : { ok: false, error: 'Не удалось прочитать сохранённый ключ' };
        } catch { return { ok: false, error: 'Не удалось прочитать сохранённый ключ' }; }
      }
      if (engineError) return { ok: false, error: engineError };
      if (parsed.data.type === 'snapshot' && currentState && worker) return { ok: true, data: currentState };
      if (parsed.data.type === 'setSourceToken') {
        const source = parsed.data.source;
        const credentialId = descriptors.find(provider => provider.id === source)?.credentialId;
        if (!credentialId) return { ok: false, error: 'Для этого источника нет поля ключа' };
        try { await saveToken(parsed.data.token, source); return await send({ kind: 'credentials', source: credentialId, token: parsed.data.token }); }
        catch { return { ok: false, error: 'Не удалось сохранить ключ в системном защищённом хранилище' }; }
      }
      return send({ kind: 'command', command: parsed.data });
    };
    return isMainCommand(parsed.data) ? withCredentials(execute) : execute();
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
