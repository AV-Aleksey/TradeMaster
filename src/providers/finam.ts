import type { Candle, Timeframe, SourceTestResult } from '../shared/model';
import { ProviderError, type DataProvider, type Instrument } from './contracts';
import { FinamAuthClient } from './finam-auth';

/** Integration boundary only: no market-data capabilities are advertised yet. */
export class FinamProvider implements DataProvider {
  readonly id = 'finam';
  readonly name = 'Finam';
  readonly capabilities = { nativeTimeframes: [] as Timeframe[], volume: 'unavailable' as const,
    stream: false, calendar: 'unverified' as const };
  private readonly auth: FinamAuthClient;
  constructor(private readonly token: () => string, fetcher: typeof fetch = fetch) { this.auth = new FinamAuthClient(fetcher); }
  async ping(): Promise<SourceTestResult> {
    const secret = this.token();
    if (!secret) throw new ProviderError('unauthorized', 'Сохраните API-токен Finam в настройках');
    const result = await this.auth.check(secret);
    if (this.token() !== secret) throw new ProviderError('unauthorized', 'Ключ Finam изменён. Повторите Ping');
    return result;
  }
  async history(_instrument: Instrument, _timeframe: Timeframe, _limit: number): Promise<Candle[]> {
    throw this.unavailable();
  }
  async search(_query: string): Promise<Instrument[]> { throw this.unavailable(); }
  now(): number { return Date.now(); }
  close(): void { this.auth.close(); }
  private unavailable(): ProviderError {
    return this.token() ? new ProviderError('unsupported', 'Finam: адаптер рыночных данных ещё не реализован')
      : new ProviderError('unauthorized', 'Сохраните API-токен Finam в настройках');
  }
}
