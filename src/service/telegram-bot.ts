import { Bot, Context, GrammyError, InlineKeyboard, type ApiClientOptions } from 'grammy';
import type { TelegramBinding, TelegramChat } from '../shared/model';
import { telegramNotice } from './telegram-format';

interface Controls {
  pair: (chat: TelegramChat, code: string) => Promise<TelegramBinding>;
  enabled: (value: boolean) => Promise<void>;
  status: (message: string) => void;
}
/** grammY owns command parsing, callback acknowledgements and long polling. */
export class TelegramBotController {
  readonly token: string;
  private readonly bot: Bot;
  private readonly abort = new AbortController();
  private closed = false;
  constructor(private binding: TelegramBinding, fetcher: typeof fetch, private readonly controls: Controls) {
    this.token = binding.token;
    type ClientFetch = NonNullable<ApiClientOptions['fetch']>;
    // grammY's Node transport uses an AbortSignal shim; bridge it to Chromium's native signal.
    const clientFetch = (async (input: Parameters<ClientFetch>[0], init?: Parameters<ClientFetch>[1]) => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      if (init?.signal?.aborted) cancel(); else init?.signal?.addEventListener('abort', cancel);
      try {
        const response = await fetcher(String(input), { ...init as unknown as RequestInit, signal: AbortSignal.any([this.abort.signal, controller.signal]) });
        if (!this.closed && String(input).endsWith('/getUpdates') && response.ok) this.controls.status('Бот подключён · кнопки подписки доступны');
        return response;
      } catch {
        if (!this.closed) this.controls.status('Нет соединения с ботом. Переподключение автоматически; проверьте системный VPN/прокси.');
        throw new Error('Telegram connection unavailable');
      } finally { init?.signal?.removeEventListener('abort', cancel); }
    }) as unknown as ClientFetch;
    this.bot = new Bot(binding.token, { client: { timeoutSeconds: 35, fetch: clientFetch } });
    this.bot.command('start', async ctx => {
      if (this.closed) return;
      const code = String(ctx.match).replace(/^tm_/, '');
      if (ctx.chat.type === 'private' && this.validCode(code)) {
        await ctx.reply(telegramNotice('🔗', 'Подключение уведомлений', ['Нажмите <b>«Подписаться»</b>, чтобы привязать этот чат к приложению.', '🔔 После подключения сюда будут приходить запуск мониторинга, срабатывания сигналов и остановка мониторинга.']), {
          parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔔 Подписаться', `tm_bind:${code}`),
        });
      } else if (this.authorized(ctx)) {
        await ctx.reply(telegramNotice('🔔', 'Управление уведомлениями', ['✅ Этот чат привязан к TradeMaster.', 'Выберите действие кнопками ниже.']), { parse_mode: 'HTML', reply_markup: this.keyboard() });
      } else {
        await ctx.reply(telegramNotice('🔗', 'Привязка к приложению', ['Откройте <b>Настройки → Telegram</b> в TradeMaster и нажмите <b>«Привязать через бота»</b>.', 'Персональная ссылка позволит подключить этот чат без ручного ввода Chat ID.']), { parse_mode: 'HTML' });
      }
    });
    this.bot.callbackQuery(/^tm_bind:([a-f0-9]{32})$/, async ctx => {
      if (this.closed) return;
      const code = ctx.match[1];
      if (ctx.chat?.type !== 'private' || ctx.from.id !== ctx.chat.id || !this.validCode(code)) {
        await ctx.answerCallbackQuery({ text: 'Ссылка устарела. Откройте новую из TradeMaster.', show_alert: true }); return;
      }
      await ctx.answerCallbackQuery({ text: 'Подключаю уведомления…' }).catch(() => {});
      const chat: TelegramChat = { id: String(ctx.chat.id), label: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').slice(0, 200), type: 'private' };
      try {
        const binding = await this.controls.pair(chat, code);
        if (this.closed) return;
        this.binding = binding;
        await ctx.reply(telegramNotice('✅', 'Telegram подключён', ['🔔 <b>Подписка включена</b>', 'Буду сообщать:\n▶️ о начале мониторинга по имени сигнала;\n🔔 о срабатывании сигнала;\n⏹ об остановке мониторинга.', 'Управлять подпиской можно кнопками ниже.']), { parse_mode: 'HTML', reply_markup: this.keyboard() });
      } catch {
        if (!this.closed) await ctx.reply(telegramNotice('⚠️', 'Не удалось подключить чат', ['Откройте новую ссылку через <b>Настройки → Telegram → Привязать через бота</b> и повторите подключение.']), { parse_mode: 'HTML' });
      }
    });
    this.bot.callbackQuery(['tm_on', 'tm_off'], async ctx => {
      if (this.closed) return;
      if (!this.authorized(ctx)) { await ctx.answerCallbackQuery({ text: 'Этот чат не привязан к TradeMaster.', show_alert: true }); return; }
      const enabled = ctx.callbackQuery.data === 'tm_on';
      await ctx.answerCallbackQuery({ text: enabled ? 'Включаю подписку…' : 'Отключаю подписку…' }).catch(() => {});
      await this.controls.enabled(enabled);
      if (!this.closed) await ctx.reply(enabled
        ? telegramNotice('🔔', 'Подписка включена', ['✅ Новые уведомления будут приходить в этот чат.'])
        : telegramNotice('🔕', 'Подписка отключена', ['Новые уведомления в этот чат приостановлены.', 'Мониторинг в приложении продолжает работать. Чтобы снова получать сообщения, нажмите <b>«Подписаться»</b>.']),
      { parse_mode: 'HTML', reply_markup: this.keyboard() });
    });
    this.bot.catch(error => { if (!this.closed) this.controls.status(this.errorMessage(error.error)); });
  }
  update(binding: TelegramBinding): void { this.binding = binding; }
  private keyboard(): InlineKeyboard { return new InlineKeyboard().text('🔔 Подписаться', 'tm_on').text('🔕 Отписаться', 'tm_off'); }
  private authorized(ctx: Context): boolean { return ctx.chat?.type === 'private' && String(ctx.chat.id) === this.binding.chatId && ctx.from?.id === ctx.chat.id; }
  private validCode(code: string): boolean { return Boolean(code && code === this.binding.pairingCode && (this.binding.pairingExpiresAt ?? 0) > Date.now()); }
  private errorMessage(error: unknown): string {
    if (error instanceof GrammyError && error.error_code === 409) return 'Бот уже используется другим приложением. Остановите другой экземпляр или смените бота.';
    if (error instanceof GrammyError && error.error_code === 401) return 'Telegram не принял токен бота.';
    return 'Не удалось связаться с ботом. Проверьте интернет и системный VPN/прокси.';
  }
  start(): void {
    this.controls.status('Подключение к боту…');
    void (async () => {
      await this.bot.init(this.abort.signal as unknown as Parameters<Bot['init']>[0]);
      if (this.closed) return;
      const webhook = await this.bot.api.getWebhookInfo();
      if (this.closed) return;
      if (webhook.url) { this.controls.status('У бота настроен webhook другого сервиса. Для TradeMaster используйте отдельного бота.'); return; }
      await this.bot.start({ allowed_updates: ['message', 'callback_query'], timeout: 20, onStart: () => { if (!this.closed) this.controls.status('Бот подключён · кнопки подписки доступны'); } });
    })().catch(error => { if (!this.closed) this.controls.status(this.errorMessage(error)); });
  }
  close(): void { this.closed = true; if (this.bot.isRunning()) void this.bot.stop().catch(() => {}); this.abort.abort(); }
}
