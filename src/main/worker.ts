import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ItickProvider } from '../providers/itick';
import { ReplayProvider } from '../providers/replay';
import { FinamProvider } from '../providers/finam';
import { descriptors, type DataProvider } from '../providers/contracts';
import { TerminalService } from '../service/terminal';
import { SqliteStore } from './storage';
import { commandSchema, isMainCommand, telegramCredentialsSchema, telegramBindingSchema, type AppSnapshot, type TelegramBinding, type TelegramCredentials, type TelegramChat } from '../shared/model';
import { NotificationDispatcher, TelegramChannel, telegramConnection } from '../service/telegram';
import { telegramFetch, desktopFetch } from './telegram-network';
import { TelegramBotController } from '../service/telegram-bot';

const port = process.parentPort;
if (!port) throw new Error('Worker must be launched by Electron utilityProcess');
let terminal: TerminalService | undefined;
let store: SqliteStore | undefined;
let dataDirectory = '';
let sourceTokens: Record<string, string> = {};
let telegram: TelegramCredentials | undefined;
let dispatcher: NotificationDispatcher | undefined;
let closing = false;
let binding: TelegramBinding | undefined;
let bot: TelegramBotController | undefined;
let botStatus = '';
let pairSequence = 0;
const pairRequests = new Map<number, { resolve: (binding: TelegramBinding) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>();
function configureBot(): void {
  if (!binding) { bot?.close(); bot = undefined; botStatus = ''; return; }
  if (bot?.token === binding.token) { bot.update(binding); return; }
  bot?.close();
  bot = new TelegramBotController(binding, telegramFetch, {
    enabled: async enabled => { const result = await terminal!.command({ type: 'setTelegramEnabled', enabled }); if (!result.ok) throw new Error('Не удалось изменить подписку'); configureNotifications(); },
    status: status => { if (botStatus !== status) { botStatus = status; terminal?.publish(); } },
    pair: (chat: TelegramChat, code: string) => new Promise((resolve, reject) => {
      const id = ++pairSequence;
      const timer = setTimeout(() => { pairRequests.delete(id); reject(new Error('Привязка не завершена')); }, 10000);
      pairRequests.set(id, { resolve, reject: () => reject(new Error('Привязка отклонена')), timer });
      port!.postMessage({ kind: 'telegramPair', id, chat, code });
    }),
  });
  bot.start();
}
function configureNotifications(): void {
  dispatcher?.close(); dispatcher = undefined;
  const connection = telegramConnection(telegram);
  if (telegram && connection && store) {
    dispatcher = new NotificationDispatcher(store, connection, new TelegramChannel(telegram, telegramFetch), () => terminal?.publish());
    dispatcher.start();
  }
  terminal?.publish();
}

function initialize(): void {
  dispatcher?.close(); terminal?.close('Подключение перезапущено'); store?.close();
  mkdirSync(dataDirectory, { recursive: true });
  store = new SqliteStore(join(dataDirectory, 'trademaster.sqlite'));
  const providers = new Map<string, DataProvider>([
    ['replay', new ReplayProvider()], ['itick', new ItickProvider(sourceTokens.itick ?? '')], ['itick-trial', new ItickProvider(sourceTokens.itick ?? '', true)],
    ['finam', new FinamProvider(() => sourceTokens.finam ?? '', desktopFetch)],
  ]);
  terminal = new TerminalService(store, providers, id => {
    const descriptor = descriptors.find(provider => provider.id === id);
    return !descriptor?.requiresToken || Boolean(sourceTokens[descriptor.credentialId ?? id]);
  }, (state: AppSnapshot) => port!.postMessage({ kind: 'state', state }), sourceTokens.itick ? 'itick-trial' : 'replay', () => telegramConnection(telegram), () => botStatus,
    volume => port!.postMessage({ kind: 'signalSound', volume }));
  terminal.start();
  configureNotifications();
  configureBot();
}
port.on('message', async event => {
  const message = event.data;
  if (closing) return;
  if (message?.kind === 'resume') {
    terminal?.resume();
    // Reopen Telegram long polling and retry the durable queue after network wakeup.
    bot?.close(); bot = undefined;
    configureNotifications(); configureBot();
    return;
  }
  if (message?.kind === 'telegramPairResult') {
    const request = pairRequests.get(message.id); if (!request) return;
    clearTimeout(request.timer); pairRequests.delete(message.id);
    const parsed = telegramBindingSchema.safeParse(message.binding);
    if (!parsed.success || !parsed.data.chatId) { request.reject(); return; }
    const oldConnection = telegramConnection(telegram);
    binding = parsed.data; telegram = telegramCredentialsSchema.parse(binding);
    if (oldConnection && oldConnection !== telegramConnection(telegram)) store?.pauseNotifications(oldConnection);
    configureNotifications(); configureBot();
    await terminal?.command({ type: 'setTelegramEnabled', enabled: true });
    request.resolve(binding); return;
  }
  if (message?.kind === 'shutdown') {
    closing = true;
    bot?.close();
    terminal?.close('Приложение закрыто');
    try { await dispatcher?.flush(1600); } catch { /* Pending jobs remain durable. */ }
    dispatcher?.close(); store?.close();
    port.postMessage({ kind: 'result', id: message.id, result: { ok: true } }); return;
  }
  if (message?.kind === 'initialize') {
    try { dataDirectory = message.directory; sourceTokens = message.tokens ?? { itick: message.token ?? '' }; binding = telegramBindingSchema.safeParse(message.telegramBinding ?? message.telegram).data; telegram = telegramCredentialsSchema.safeParse(binding).data; initialize(); port.postMessage({ kind: 'ready' }); }
    catch (error) { console.error('Engine initialization:', error instanceof Error ? error.message : 'unknown error'); port.postMessage({ kind: 'fatal', error: 'Не удалось запустить хранилище или движок. Проверьте каталог данных.' }); }
    return;
  }
  if (message?.kind === 'credentials') {
    try {
      const source = message.source ?? 'itick'; sourceTokens[source] = message.token;
      // Storing a key for an unfinished adapter must not restart live monitoring.
      if (descriptors.some(provider => provider.credentialId === source && provider.available !== false)) initialize();
      else terminal?.publish();
      port.postMessage({ kind: 'result', id: message.id, result: { ok: true } });
    }
    catch { port.postMessage({ kind: 'result', id: message.id, result: { ok: false, error: 'Не удалось обновить подключение' } }); }
    return;
  }
  if (message?.kind === 'telegramCredentials') {
    const parsed = telegramBindingSchema.optional().safeParse(message.telegram);
    if (!parsed.success) { port.postMessage({ kind: 'result', id: message.id, result: { ok: false, error: 'Некорректные настройки Telegram' } }); return; }
    const previousConnection = telegramConnection(telegram);
    dispatcher?.close(); dispatcher = undefined;
    binding = parsed.data; telegram = telegramCredentialsSchema.safeParse(binding).data;
    if (previousConnection && previousConnection !== telegramConnection(telegram)) store?.pauseNotifications(previousConnection);
    if (!telegram || previousConnection !== telegramConnection(telegram)) await terminal?.command({ type: 'setTelegramEnabled', enabled: false });
    configureNotifications();
    configureBot();
    port.postMessage({ kind: 'result', id: message.id, result: { ok: true } }); return;
  }
  const parsed = commandSchema.safeParse(message?.command);
  if (!parsed.success || isMainCommand(parsed.data) || !terminal) {
    port.postMessage({ kind: 'result', id: message?.id, result: { ok: false, error: 'Недопустимая команда или движок ещё запускается' } }); return;
  }
  const result = await terminal.command(parsed.data);
  if (parsed.data.type === 'setTelegramEnabled') configureNotifications();
  port.postMessage({ kind: 'result', id: message.id, result });
});
process.on('SIGTERM', () => { bot?.close(); dispatcher?.close(); if (!closing) { terminal?.close('Приложение остановлено'); store?.close(); } process.exit(0); });
