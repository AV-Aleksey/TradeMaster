import type { Candle, SourceId, Timeframe } from '../shared/model';

export interface Instrument { code: string; name: string; region: string }
export interface ProviderCapabilities {
  nativeTimeframes: Timeframe[]; volume: 'reported' | 'synthetic' | 'unavailable';
  stream: boolean; calendar: 'demo-24h' | 'unverified';
}
export interface BarUpdate { candle: Candle; sourceTime: number }
export interface DataProvider {
  id: SourceId; name: string; capabilities: ProviderCapabilities;
  history(instrument: Instrument, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  search(query: string): Promise<Instrument[]>;
  subscribe?(instrument: Instrument, timeframe: Timeframe, onBar: (update: BarUpdate) => void,
    onStatus: (status: string) => void): () => void;
  now(): number;
  close(): void;
}
export interface ProviderDescriptor { id: SourceId; name: string; requiresToken: boolean }
export const descriptors: ProviderDescriptor[] = [
  { id: 'replay', name: 'Тестовые данные · Replay', requiresToken: false },
  { id: 'itick', name: 'iTick · Production', requiresToken: true },
  { id: 'itick-trial', name: 'iTick · Trial', requiresToken: true },
];
export type ProviderErrorKind = 'unauthorized' | 'forbidden' | 'rateLimited' | 'unavailable' | 'invalidData' | 'unsupported';
export class ProviderError extends Error {
  constructor(public readonly kind: ProviderErrorKind, message: string) { super(message); this.name = 'ProviderError'; }
}

/** One queue per credential/host, shared by catalog and all series. */
export class RequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  constructor(private readonly minGapMs = 12100) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAt - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.nextAt = Date.now() + this.minGapMs;
      return operation();
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}
