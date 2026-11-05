import { ProviderError } from './contracts';
import type { SourceTestResult } from '../shared/model';

/** Auth-only connection check; JWT stays in the backend and is never returned to UI. */
export class FinamAuthClient {
  private readonly controller = new AbortController();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  close(): void { this.controller.abort(); }
  private async request(path: '/v1/sessions' | '/v1/sessions/details', parameters: object): Promise<Record<string, unknown>> {
    if (this.controller.signal.aborted) throw new ProviderError('unavailable', 'Finam: подключение закрыто');
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]);
    let response: Response;
    try {
      response = await this.fetcher(`https://api.finam.ru${path}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(parameters), signal });
    } catch { throw new ProviderError('unavailable', 'Finam: нет соединения или превышено время ожидания'); }
    if (response.status === 400 || response.status === 401) throw new ProviderError('unauthorized', 'Finam: токен недействителен или срок его действия истёк');
    if (response.status === 403) throw new ProviderError('forbidden', 'Finam: недостаточно прав у токена');
    if (response.status === 404) throw new ProviderError('forbidden', 'Finam: счёт не найден в токене');
    if (response.status === 429) throw new ProviderError('rateLimited', 'Finam: превышен лимит запросов, повторите Ping позже');
    if (!response.ok) throw new ProviderError('unavailable', `Finam: сервис недоступен (HTTP ${response.status})`);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ProviderError(signal.aborted ? 'unavailable' : 'invalidData', signal.aborted ? 'Finam: превышено время ожидания' : 'Finam: некорректный ответ сервера'); }
    if (signal.aborted) throw new ProviderError('unavailable', 'Finam: запрос отменён или превышено время ожидания');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('invalidData', 'Finam: некорректный ответ сервера');
    return body as Record<string, unknown>;
  }
  async check(secret: string): Promise<SourceTestResult> {
    const session = await this.request('/v1/sessions', { secret });
    if (typeof session.token !== 'string' || !session.token.trim() || session.token.length > 8192) throw new ProviderError('invalidData', 'Finam: сервер не вернул токен сессии');
    const details = await this.request('/v1/sessions/details', { token: session.token });
    if (typeof details.expires_at !== 'string' || !Number.isFinite(Date.parse(details.expires_at))
      || (details.account_ids !== undefined && (!Array.isArray(details.account_ids) || !details.account_ids.every(id => typeof id === 'string')))) {
      throw new ProviderError('invalidData', 'Finam: сервер не подтвердил параметры сессии');
    }
    return { authenticated: true, expiresAt: details.expires_at, accounts: Array.isArray(details.account_ids) ? details.account_ids.length : 0 };
  }
}
