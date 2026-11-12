import { ProviderError } from './contracts';
import type { SourceTestResult } from '../shared/model';

interface FinamSession { token: string; expiresAt: string; accounts: number; accountIds: string[] }
/** In-memory JWT session; credentials and session tokens are never returned to UI. */
export class FinamAuthClient {
  private readonly controller = new AbortController();
  private session?: FinamSession & { secret: string };
  private pending?: { secret: string; promise: Promise<FinamSession> };
  private serverClock?: { epoch: number; tick: number };
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  close(): void { this.session = undefined; this.controller.abort(); }
  invalidate(token: string): void { if (this.session?.token === token) this.session = undefined; }
  /** HTTP/server time plus monotonic elapsed time; independent of local date/time adjustments. */
  now(): number { return this.serverClock ? this.serverClock.epoch + (performance.now() - this.serverClock.tick) : Date.now(); }
  remaining(session: FinamSession): number { return Date.parse(session.expiresAt) - this.now(); }
  async request(path: string, parameters?: object, token?: string): Promise<Record<string, unknown>> {
    if (this.controller.signal.aborted) throw new ProviderError('unavailable', 'Finam: подключение закрыто');
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]);
    let response: Response;
    try {
      response = await this.fetcher(`https://api.finam.ru${path}`, { method: parameters ? 'POST' : 'GET', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { Authorization: token } : {}) }, body: parameters ? JSON.stringify(parameters) : undefined, signal });
    } catch { throw new ProviderError('unavailable', 'Finam: нет соединения или превышено время ожидания'); }
    if (response.status === 401 || (response.status === 400 && path.startsWith('/v1/sessions'))) throw new ProviderError('unauthorized', 'Finam: токен недействителен или срок его действия истёк');
    if (response.status === 400) throw new ProviderError('unsupported', 'Finam: проверьте код инструмента, площадку и интервал');
    if (response.status === 403) throw new ProviderError('forbidden', 'Finam: недостаточно прав у токена');
    if (response.status === 404) throw new ProviderError('forbidden', path.startsWith('/v1/sessions') ? 'Finam: счёт не найден в токене' : 'Finam: инструмент не найден');
    if (response.status === 429) throw new ProviderError('rateLimited', 'Finam: превышен лимит запросов, повторите Ping позже');
    if (!response.ok) throw new ProviderError('unavailable', `Finam: сервис недоступен (HTTP ${response.status})`);
    const receivedTick = performance.now();
    const serverDate = Date.parse(response.headers.get('date') ?? '');
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ProviderError(signal.aborted ? 'unavailable' : 'invalidData', signal.aborted ? 'Finam: превышено время ожидания' : 'Finam: некорректный ответ сервера'); }
    if (signal.aborted) throw new ProviderError('unavailable', 'Finam: запрос отменён или превышено время ожидания');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('invalidData', 'Finam: некорректный ответ сервера');
    if (path.startsWith('/v1/sessions') && Number.isFinite(serverDate)) this.serverClock = { epoch: serverDate, tick: receivedTick };
    return body as Record<string, unknown>;
  }
  async access(secret: string): Promise<FinamSession> {
    if (!secret) throw new ProviderError('unauthorized', 'Сохраните API-токен Finam в настройках');
    if (this.controller.signal.aborted) throw new ProviderError('unavailable', 'Finam: подключение закрыто');
    if (this.session?.secret === secret && this.remaining(this.session) > 60000) return this.session;
    if (this.pending?.secret === secret) return this.pending.promise;
    const promise = this.createSession(secret);
    this.pending = { secret, promise };
    try { return await promise; } finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
  private async createSession(secret: string, retryExpired = true): Promise<FinamSession> {
    const previousClock = this.serverClock;
    const session = await this.request('/v1/sessions', { secret });
    if (typeof session.token !== 'string' || !session.token.trim() || session.token.length > 8192) throw new ProviderError('invalidData', 'Finam: сервер не вернул токен сессии');
    const details = await this.request('/v1/sessions/details', { token: session.token });
    if (typeof details.expires_at !== 'string' || !Number.isFinite(Date.parse(details.expires_at))
      || (details.account_ids !== undefined && (!Array.isArray(details.account_ids) || !details.account_ids.every(id => typeof id === 'string')))) {
      throw new ProviderError('invalidData', 'Finam: сервер не подтвердил параметры сессии');
    }
    if (this.serverClock === previousClock) {
      // Clock is authenticated with the new JWT when a proxy omits HTTP Date.
      const clock = await this.request('/v1/assets/clock', undefined, session.token);
      const timestamp = typeof clock.timestamp === 'string' ? Date.parse(clock.timestamp) : NaN;
      if (!Number.isFinite(timestamp)) throw new ProviderError('invalidData', 'Finam: не удалось подтвердить серверное время сессии');
      this.serverClock = { epoch: timestamp, tick: performance.now() };
    }
    if (Date.parse(details.expires_at) <= this.now()) {
      if (retryExpired) return this.createSession(secret, false);
      throw new ProviderError('unauthorized', 'Finam: сервер дважды вернул истёкшую сессию. Повторите Ping позже');
    }
    const result = { secret, token: session.token, expiresAt: details.expires_at, accounts: Array.isArray(details.account_ids) ? details.account_ids.length : 0, accountIds: (details.account_ids ?? []) as string[] };
    if (!this.controller.signal.aborted) this.session = result;
    return result;
  }
  async check(secret: string): Promise<SourceTestResult> {
    // An explicit Ping must check the server even when normal requests can reuse a JWT.
    if (this.session?.secret === secret) this.invalidate(this.session.token);
    const { expiresAt, accounts } = await this.access(secret);
    return { authenticated: true, expiresAt, accounts };
  }
}
