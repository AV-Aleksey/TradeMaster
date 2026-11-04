import { createHash } from 'node:crypto';
import type { Explanation, SignalEvent, TelegramCredentials } from '../shared/model';
import { descriptors } from '../providers/contracts';
import { telegramDate, telegramEscape, telegramNotice } from './telegram-format';
import { displayNumber, indicatorDecimalPlaces } from '../shared/display-number';

export function telegramConnection(credentials?: TelegramCredentials): string | undefined {
  return credentials ? createHash('sha256').update(credentials.token + ':' + credentials.chatId).digest('hex') : undefined;
}
export interface NotificationJob { event: SignalEvent; attempts: number; createdAt: number }
export interface NotificationStore {
  nextNotification(connection: string, now: number): NotificationJob | undefined;
  finishNotification(id: string, update: { state: 'pending' | 'sent' | 'failed'; attempts: number; nextAt: number; error?: string; sentAt?: number }): void;
}
export class TelegramError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfter?: number) { super(message); }
}
export function telegramText(event: SignalEvent): string {
  const kind = event.kind ?? 'signal';
  const signal = kind === 'signal';
  const heading = kind === 'test' ? ['🧪', 'Проверка уведомлений']
    : kind === 'monitoring-started' ? ['▶️', 'Начат мониторинг по сигналу']
    : kind === 'monitoring-stopped' ? ['⏹', 'Мониторинг по сигналу остановлен'] : ['🔔', 'Сигнал сработал'];
  const source = descriptors.find(provider => provider.id === event.source)?.name ?? event.source;
  const pair = /^[A-Z]{6}$/.test(event.code) ? `${event.code.slice(0, 3)} / ${event.code.slice(3)}` : event.code;
  const blocks = [
    ...(kind === 'test' ? ['Проверка доставки Telegram — <b>не торговый сигнал</b>.'] : [`🎯 <b>${telegramEscape(event.signalName, 100)}</b>`]),
    `💱 <b>Пара:</b> ${telegramEscape(pair, 40)}\n📡 <b>Источник:</b> ${telegramEscape(source, 80)}`,
    `🕒 <b>${signal ? 'Свеча закрыта' : 'Время'}:</b> ${telegramDate(event.at)}`,
  ];
  if (signal && event.price && event.price !== '—') blocks.push(`💰 <b>Цена:</b> ${telegramEscape(event.price, 100)}`);
  if (signal && event.category) blocks.push(`🏷 <b>Метка:</b> ${telegramEscape(event.category, 100)}`);
  if (event.reason) blocks.push(`ℹ️ <b>Причина:</b> ${telegramEscape(event.reason)}`);
  if (signal && event.triggeredAt !== undefined && event.triggeredAt !== event.at) blocks.push(`⏱ <b>Начало сигнала:</b> ${telegramDate(event.triggeredAt)}`);
  const lines: string[] = [];
  const walk = (item: Explanation, depth = 0): void => {
    if (lines.length >= 14 || depth > 4) return;
    const labels: Record<string, string> = { ema: 'EMA', sma: 'SMA', wma: 'WMA', stochK: 'Стохастик', stochD: 'Сигнальная линия стохастика',
      macd: 'MACD', macdSignal: 'Сигнальная линия MACD', macdHist: 'Гистограмма MACD',
      crossUp: 'пересечение ↑', crossDown: 'пересечение ↓', crossUpTouch: 'пересечение ↑ с касанием', crossDownTouch: 'пересечение ↓ с касанием',
      gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', rising: 'рост', falling: 'снижение' };
    const label = item.label.replace(/\b(?:ema|sma|wma|stochK|stochD|macd|macdSignal|macdHist|crossUp|crossDown|crossUpTouch|crossDownTouch|gt|gte|lt|lte|eq|rising|falling)\b/g, key => labels[key]);
    const decimals = indicatorDecimalPlaces(item.label);
    const values = item.left !== undefined ? ` — <code>${telegramEscape(displayNumber(item.left, decimals), 80)}</code>${item.right !== undefined ? ` / <code>${telegramEscape(displayNumber(item.right, decimals), 80)}</code>` : ''}` : '';
    lines.push(`${'  '.repeat(depth)}${item.result === 'true' ? '✅' : item.result === 'false' ? '❌' : '⚪'} ${telegramEscape(label, 160)}${values}`);
    item.children?.forEach(child => walk(child, depth + 1));
  };
  if (signal) {
    walk(event.explanation);
    blocks.push('<b>📋 Условия сигнала</b>\n' + lines.join('\n'));
  } else if (kind === 'monitoring-started') blocks.push('✅ Условия отслеживаются. Сообщу, когда сигнал сработает.');
  else if (kind === 'test') blocks.push('✅ Доставка работает. Подключение к Telegram настроено.');
  return telegramNotice(heading[0], heading[1], blocks);
}
export class TelegramChannel {
  constructor(private readonly credentials: TelegramCredentials, private readonly fetcher: typeof fetch = fetch) {}
  async send(event: SignalEvent, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.credentials.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ chat_id: this.credentials.chatId, text: telegramText(event), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch { throw new TelegramError('Telegram: сеть недоступна или истекло время ожидания', true); }
    let body: { ok?: boolean; error_code?: number; parameters?: { retry_after?: number }; result?: { message_id?: number } };
    try { body = await response.json() as typeof body; }
    catch { throw new TelegramError('Telegram: некорректный ответ сервера', true); }
    const code = response.ok ? body.error_code : response.status;
    if (code === 429) {
      const delay = body.parameters?.retry_after;
      throw new TelegramError('Telegram: превышен лимит отправки, запланирован повтор', true,
        typeof delay === 'number' && Number.isSafeInteger(delay) && delay > 0 ? delay : 60);
    }
    if (code === 401) throw new TelegramError('Telegram: токен бота не принят', false);
    if (code === 403) throw new TelegramError('Telegram: бот заблокирован или нет доступа к чату', false);
    if (code === 400 || code === 404) throw new TelegramError('Telegram: проверьте Chat ID и отправьте боту /start', false);
    if (!response.ok || body.ok !== true || !Number.isSafeInteger(body.result?.message_id)) throw new TelegramError('Telegram: сообщение не подтверждено сервером', true);
  }
}
export class NotificationDispatcher {
  private busy = false;
  private disposed = false;
  private controller = new AbortController();
  private nextSendAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly store: NotificationStore, private readonly connection: string, private readonly channel: Pick<TelegramChannel, 'send'>,
    private readonly changed: () => void, private readonly now = Date.now) {}
  start(): void { this.timer = setInterval(() => { void this.tick(); }, 500); void this.tick(); }
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.disposed && Date.now() < deadline) {
      if (!this.busy) await this.tick();
      if (!this.busy && !this.store.nextNotification(this.connection, this.now())) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  close(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.controller.abort(); }
  async tick(): Promise<void> {
    if (this.disposed || this.busy || this.now() < this.nextSendAt) return;
    const job = this.store.nextNotification(this.connection, this.now());
    if (!job) return;
    this.busy = true;
    try {
      if (this.now() - job.createdAt > 86400000) throw new TelegramError('Telegram: срок доставки 24 часа истёк', false);
      await this.channel.send(job.event, this.controller.signal);
      if (!this.disposed) this.store.finishNotification(job.event.id, { state: 'sent', attempts: job.attempts + 1, nextAt: 0, sentAt: this.now() });
    } catch (error) {
      const failure = error instanceof TelegramError ? error : new TelegramError('Telegram: ошибка доставки', true);
      const attempts = job.attempts + 1;
      const retry = failure.retryable && attempts < 5;
      const delay = Math.max(failure.retryAfter ?? 0, Math.min(300, 2 ** attempts));
      if (!this.disposed) this.store.finishNotification(job.event.id, { state: retry ? 'pending' : 'failed', attempts,
        nextAt: this.now() + delay * 1000, error: failure.message });
    } finally {
      this.busy = false; this.nextSendAt = this.now() + 1100;
      if (!this.disposed) this.changed();
    }
  }
}
