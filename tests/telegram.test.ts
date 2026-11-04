import { describe, expect, it, vi } from 'vitest';
import { NotificationDispatcher, TelegramChannel, TelegramError, telegramConnection, telegramText, type NotificationJob, type NotificationStore } from '../src/service/telegram';
import { telegramCredentialsSchema, type SignalEvent } from '../src/shared/model';

const credentials = { token: '123456:fake_test_token_abcdefghijklmnopqrstuvwxyz', chatId: '-1001234567890' };
const event = (id = 'event-one'): SignalEvent => ({ id, signalId: 's', signalName: 'Разворот вверх', revision: 1, pairId: 'p', code: 'EURUSD', source: 'itick-trial',
  at: 300000, createdAt: 1000000, price: '1.125', category: 'Ранний', explanation: { id: 'root', result: 'true', label: 'Цепочка подтверждена' } });
const success = () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
class MemoryOutbox implements NotificationStore {
  update?: Parameters<NotificationStore['finishNotification']>[1];
  job: NotificationJob = { event: event(), attempts: 0, createdAt: 1000000 };
  nextNotification(_connection: string, now: number): NotificationJob | undefined {
    return (!this.update || this.update.state === 'pending') && now >= (this.update?.nextAt ?? 0)
      ? { ...this.job, attempts: this.update?.attempts ?? 0 } : undefined;
  }
  finishNotification(_id: string, update: Parameters<NotificationStore['finishNotification']>[1]): void { this.update = update; }
}

describe('Telegram payload and safe transport', () => {
  it.each([['monitoring-started', 'Начат мониторинг'], ['monitoring-stopped', 'остановлен'], ['test', 'не торговый сигнал'], ['signal', 'Сигнал сработал']] as const)('includes signal name and correct lifecycle heading for %s', (kind, text) => {
    const result = telegramText({ ...event(), kind, reason: 'Переключатель', triggeredAt: 0 });
    expect(result).toContain(text);
    if (kind !== 'test') expect(result).toContain('Разворот вверх');
    expect(result).not.toContain('event-one'); expect(result).toContain('EUR / USD'); expect(result).toContain('01.01.1970, 03:05:00 МСК');
  });
  it('bounds formatted message length without breaking the last surrogate', () => {
    const result = telegramText({ ...event(), signalName: '😀'.repeat(5000) });
    expect(result.length).toBeLessThanOrEqual(4000); expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
  });
  it('uses only the configured chat and does not put credentials in message text', async () => {
    const fetcher = vi.fn().mockResolvedValue(success());
    await new TelegramChannel(credentials, fetcher as typeof fetch).send(event(), new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${credentials.token}/sendMessage`);
    const request = fetcher.mock.calls[0][1]; const body = JSON.parse(request.body);
    expect(body.chat_id).toBe(credentials.chatId); expect(body.text).not.toContain(credentials.token);
    expect(body.parse_mode).toBe('HTML'); expect(request.redirect).toBe('error');
  });
  it.each([400, 401, 403, 404, 503])('sanitizes HTTP %s and external response descriptions', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: credentials.token }), { status }));
    const channel = new TelegramChannel(credentials, fetcher as typeof fetch);
    const failure = await channel.send(event(), new AbortController().signal).catch(e => e);
    expect(failure).toBeInstanceOf(TelegramError); expect(String(failure)).not.toContain(credentials.token);
    expect(failure.retryable).toBe(status === 503);
  });
  it('does not expose a token-bearing URL from network errors', async () => {
    const channel = new TelegramChannel(credentials, vi.fn().mockRejectedValue(new Error(`failed https://example/${credentials.token}`)) as typeof fetch);
    await expect(channel.send(event(), new AbortController().signal)).rejects.toThrow('Telegram: сеть недоступна');
  });
  it('honors Telegram retry_after and requires a confirmed message ID', async () => {
    const limited = new TelegramChannel(credentials, vi.fn().mockResolvedValue(new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":17}}', { status: 429 })) as typeof fetch);
    const failure = await limited.send(event(), new AbortController().signal).catch(e => e);
    expect(failure).toMatchObject({ retryable: true, retryAfter: 17 });
    const invalid = new TelegramChannel(credentials, vi.fn().mockResolvedValue(new Response('{"ok":true,"result":{}}')) as typeof fetch);
    await expect(invalid.send(event(), new AbortController().signal)).rejects.toThrow('не подтверждено');
  });
  it('validates credentials and isolates recipient/bot connections without storing raw tokens as IDs', () => {
    expect(telegramCredentialsSchema.safeParse(credentials).success).toBe(true);
    expect(telegramCredentialsSchema.safeParse({ ...credentials, token: 'bad' }).success).toBe(false);
    expect(telegramConnection(credentials)).not.toContain(credentials.token);
    expect(telegramConnection({ ...credentials, chatId: '2' })).not.toBe(telegramConnection(credentials));
    expect(telegramConnection({ ...credentials, token: credentials.token + 'x' })).not.toBe(telegramConnection(credentials));
  });
});

describe('notification dispatcher', () => {
  it('marks delivery once and never repeats a sent job', async () => {
    const store = new MemoryOutbox(), send = vi.fn().mockResolvedValue(undefined), changed = vi.fn();
    let now = 1000000;
    const dispatcher = new NotificationDispatcher(store, 'connection', { send }, changed, () => now);
    await dispatcher.tick(); now += 2000; await dispatcher.tick();
    expect(send).toHaveBeenCalledTimes(1); expect(store.update).toMatchObject({ state: 'sent', attempts: 1, sentAt: 1000000 }); dispatcher.close();
  });
  it('backs off without blocking signal execution and bounds automatic retry attempts', async () => {
    const store = new MemoryOutbox(), send = vi.fn().mockRejectedValue(new TelegramError('offline', true));
    let now = 1000000;
    const dispatcher = new NotificationDispatcher(store, 'connection', { send }, () => {}, () => now);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await dispatcher.tick(); expect(store.update?.attempts).toBe(attempt);
      if (attempt < 5) { await dispatcher.tick(); expect(send).toHaveBeenCalledTimes(attempt); now = store.update!.nextAt; }
    }
    expect(store.update?.state).toBe('failed'); dispatcher.close();
  });
  it('waits for retry_after and expires stale jobs without a network request', async () => {
    const store = new MemoryOutbox(), send = vi.fn().mockRejectedValue(new TelegramError('limit', true, 60));
    const dispatcher = new NotificationDispatcher(store, 'connection', { send }, () => {}, () => 1000000);
    await dispatcher.tick(); expect(store.update?.nextAt).toBe(1060000); dispatcher.close();
    const expired = new MemoryOutbox(), noSend = vi.fn();
    const old = new NotificationDispatcher(expired, 'connection', { send: noSend }, () => {}, () => 1000000 + 86400001);
    await old.tick(); expect(noSend).not.toHaveBeenCalled(); expect(expired.update?.state).toBe('failed'); old.close();
  });
  it('serializes concurrent ticks and ignores a late result after close', async () => {
    const store = new MemoryOutbox(); let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const dispatcher = new NotificationDispatcher(store, 'connection', { send }, () => {}, () => 1000000);
    const pending = dispatcher.tick(); await dispatcher.tick();
    expect(send).toHaveBeenCalledTimes(1); dispatcher.close(); finish(); await pending;
    expect(store.update).toBeUndefined();
  });
});
