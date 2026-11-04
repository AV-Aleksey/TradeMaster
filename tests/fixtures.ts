import { intervalMs, type Candle, type Condition, type Signal, type Timeframe } from '../src/shared/model';
export function bars(values: Array<number | string>, tf: Timeframe = '5m', start = 0): Candle[] {
  return values.map((value, i) => ({ openTime: start + i * intervalMs[tf], closeTime: start + (i + 1) * intervalMs[tf],
    open: String(value), high: String(value), low: String(value), close: String(value), volume: '10', closed: true }));
}
export function condition(overrides: Partial<Condition> = {}): Condition {
  return { kind: 'condition', id: 'c', left: { kind: 'series', field: 'close', timeframe: '5m', period: 1, offset: 0, factor: '1' },
    operator: 'gt', right: { kind: 'constant', value: '2' }, bars: 1, ...overrides };
}
export function signal(overrides: Partial<Signal> = {}): Signal {
  return { id: 's', pairId: 'eurusd', name: 'Test', revision: 1, enabled: true, timeframe: '5m', cooldownBars: 0,
    expression: condition(), ...overrides };
}
