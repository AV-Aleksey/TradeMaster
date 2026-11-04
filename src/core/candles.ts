import { D } from './indicators';
import { intervalMs, type Candle, type Timeframe } from '../shared/model';

export function validateCandle(c: Candle): void {
  if (!Number.isSafeInteger(c.openTime) || !Number.isSafeInteger(c.closeTime) || c.closeTime <= c.openTime) throw new Error('Некорректное время свечи');
  const open = new D(c.open), high = new D(c.high), low = new D(c.low), close = new D(c.close);
  if (![open, high, low, close].every(v => v.isFinite()) || low.gt(D.min(open, close)) || high.lt(D.max(open, close)) || low.gt(high)) throw new Error('Некорректные OHLC');
  if (c.volume !== null && (!new D(c.volume).isFinite() || new D(c.volume).lt(0))) throw new Error('Некорректный объём');
}

export function normalizeCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of candles) { validateCandle(candle); byTime.set(candle.openTime, candle); }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** UTC-aligned fixed-duration aggregation. Session-aware/daily policies are separate. */
export function aggregate(candles: Candle[], from: Timeframe, to: Timeframe): Candle[] {
  const base = intervalMs[from], target = intervalMs[to];
  if (target < base || target % base) throw new Error('Несовместимые периоды агрегации');
  const groups = new Map<number, Candle[]>();
  for (const candle of normalizeCandles(candles)) {
    if (candle.closeTime - candle.openTime !== base) throw new Error('Длительность исходного бара не совпадает с периодом');
    const bucket = Math.floor(candle.openTime / target) * target;
    const list = groups.get(bucket) ?? []; list.push(candle); groups.set(bucket, list);
  }
  return [...groups.entries()].map(([openTime, group]) => {
    const complete = group.length === target / base && group.every((c, i) => c.openTime === openTime + base * i && c.closed);
    return { openTime, closeTime: openTime + target, open: group[0].open, close: group.at(-1)!.close,
      high: D.max(...group.map(c => new D(c.high))).toString(), low: D.min(...group.map(c => new D(c.low))).toString(),
      volume: group.every(c => c.volume !== null) ? group.reduce((sum, c) => sum.plus(c.volume!), new D(0)).toString() : null,
      closed: complete };
  });
}
