import { aggregate, normalizeCandles } from '../core/candles';
import { intervalMs, type Candle, type Pair, type Timeframe } from '../shared/model';
import type { DataProvider } from '../providers/contracts';

interface Entry { bars: Candle[]; loadedAt: number; restAt: number; requested: number; loading?: Promise<Candle[]>; stop?: () => void; status: string }
export class MarketDataService {
  private entries = new Map<string, Entry>();
  constructor(private readonly providers: Map<string, DataProvider>, private readonly onChange: () => void) {}
  provider(id: string): DataProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error('Неизвестный источник данных');
    return provider;
  }
  key(pair: Pair, tf: Timeframe): string { return `${pair.source}:${pair.region}:${pair.code}:${tf}`; }
  cached(pair: Pair, tf: Timeframe): Candle[] { return this.entries.get(this.key(pair, tf))?.bars ?? []; }
  status(pair: Pair, tf: Timeframe): string { return this.entries.get(this.key(pair, tf))?.status ?? 'Ожидание данных'; }
  receivedAt(pair: Pair, tf: Timeframe): number | null { return this.entries.get(this.key(pair, tf))?.loadedAt || null; }
  async load(pair: Pair, tf: Timeframe, refresh = false, minimumBars = 300): Promise<Candle[]> {
    const provider = this.provider(pair.source);
    const key = this.key(pair, tf);
    let entry = this.entries.get(key);
    if (entry?.loading) { await entry.loading; return entry.requested >= minimumBars ? entry.bars : this.load(pair, tf, true, minimumBars); }
    const ttl = provider.id === 'replay' ? 700 : 30000;
    if (entry && !refresh && entry.requested >= minimumBars && Date.now() - entry.restAt < ttl) return entry.bars;
    if (!entry) { entry = { bars: [], loadedAt: 0, restAt: 0, requested: 0, status: 'Загрузка истории' }; this.entries.set(key, entry); }
    const target = entry;
    const requestStarted = Date.now();
    target.loading = (async () => {
      try {
        const bars = tf === '10m'
          ? aggregate(await this.load(pair, '5m', refresh, minimumBars * 2 + 2), '5m', '10m')
          : normalizeCandles(await provider.history(pair, tf, minimumBars));
        if (this.entries.get(key) !== target) return [];
        // Keep streaming updates received during a REST request, while preferring
        // reconciled final history over provisional old bars.
        const streamUpdates = target.loadedAt > requestStarted ? target.bars.filter(c => !c.closed && !bars.some(b => b.openTime === c.openTime && b.closed)) : [];
        target.bars = normalizeCandles([...bars, ...streamUpdates]); target.loadedAt = Date.now(); target.restAt = Date.now(); target.requested = minimumBars;
        target.status = provider.id === 'replay' ? 'Тестовые данные · Replay ×60' : 'REST · периодическое обновление';
        if (!target.stop && provider.subscribe && tf !== '10m') {
          target.stop = provider.subscribe(pair, tf, update => {
            if (this.entries.get(key) !== target) return;
            const latest = target.bars.at(-1)?.openTime ?? -Infinity;
            if (update.candle.openTime < latest) return; // old messages need explicit reconciliation
            const prior = target.bars.find(c => c.openTime === latest);
            if (update.candle.openTime > latest && prior && !prior.closed) {
              // A successor alone does not supply the preceding candle's final OHLC.
              // Reconcile before allowing it into indicator calculations.
              target.restAt = 0;
            }
            const existing = target.bars.filter(c => c.openTime !== update.candle.openTime);
            target.bars = normalizeCandles([...existing, update.candle]).slice(-Math.max(500, target.requested));
            target.loadedAt = Date.now();
            target.status = provider.id === 'replay' ? 'Тестовые данные · Replay ×60' : 'WebSocket · обновление свечи';
            this.onChange();
          }, status => { if (this.entries.get(key) === target) { target.status = status; this.onChange(); } });
        }
        return target.bars;
      } catch (error) {
        if (this.entries.get(key) === target) target.status = error instanceof Error ? error.message : 'Ошибка данных';
        throw error;
      } finally { target.loading = undefined; this.onChange(); }
    })();
    return target.loading;
  }
  prune(needed: Set<string>): void {
    for (const [key, entry] of this.entries) {
      if (!needed.has(key)) { entry.stop?.(); this.entries.delete(key); }
    }
  }
  removePair(pair: Pair): void {
    const prefix = `${pair.source}:${pair.region}:${pair.code}:`;
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix)) { entry.stop?.(); this.entries.delete(key); }
    }
  }
  close(): void { this.prune(new Set()); for (const provider of this.providers.values()) provider.close(); }
}
