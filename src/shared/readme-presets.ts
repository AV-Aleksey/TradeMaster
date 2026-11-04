import type { Condition, Expression, Group, Operator, SeriesField, SeriesOperand, Signal } from './model';

/** Declarative templates only: execution uses the same operators as user-created signals. */
export function readmeReversal(pairId: string, direction: 'up' | 'down', id: string): Signal {
  const up = direction === 'up', label = up ? 'Разворот вверх' : 'Разворот вниз';
  const series = (field: SeriesField, period = 1, offset = 0): SeriesOperand => ({ kind: 'series', field, timeframe: '5m', period, offset, factor: '1',
    ...(field.startsWith('stoch') ? { params: { kLength: 10, kSmooth: 5, dSmooth: 5 } } : {}),
    ...(field.startsWith('macd') ? { params: { fast: 6, slow: 8, signal: 4, oscillatorMa: 'wma' as const, signalMa: 'wma' as const } } : {}),
  });
  const condition = (id: string, left: SeriesOperand, operator: Operator, right: SeriesOperand | string): Condition => ({ kind: 'condition', id, left, operator,
    right: typeof right === 'string' ? { kind: 'constant', value: right } : right, bars: 1 });
  const group = (id: string, rules: Expression[], combinator: 'and' | 'or' = 'and'): Group => ({ kind: 'group', id, rules, combinator });
  const cross = condition('ema-cross', series('ema', 5), up ? 'crossUp' : 'crossDown', series('ema', 10));
  const trigger = group('trigger', [cross, group('prior-move', [
    condition('prior-price', series('close'), up ? 'lt' : 'gt', series('close', 1, 10)),
    condition('prior-ema', series('ema', 5, 5), up ? 'lt' : 'gt', series('ema', 5, 10)),
  ], 'or')]);
  const window = { anchor: 'trigger' as const, timeframe: '5m' as const, from: -3, to: 3, match: 'any' as const };
  const stochastic = group('stochastic', [
    { ...condition('stoch-zone', series('stochK'), up ? 'lte' : 'gte', up ? '20' : '80'), window },
    { ...condition('stoch-cross', series('stochK'), up ? 'crossUpTouch' : 'crossDownTouch', series('stochD')), window },
    condition('stoch-current-slope', series('stochK'), up ? 'gt' : 'lt', series('stochK', 1, 1)),
  ]);
  const macd = group('macd', [
    condition('histogram-slope', series('macdHist'), up ? 'gt' : 'lt', series('macdHist', 1, 1)),
    condition('macd-signal', series('macd'), up ? 'gt' : 'lt', series('macdSignal')),
  ]);
  const confirmed = group('strength', [
    condition('background-30', series('ema', 30), up ? 'gt' : 'lt', series('ema', 30, 3)),
    condition('background-90', series('ema', 90), up ? 'gt' : 'lt', series('ema', 90, 3)),
    condition('volume-legs', series('legVolumeRatio', 20), up ? 'gt' : 'lt', up ? '1.2' : '0.8'),
  ]);
  return { id, pairId, name: `README · ${label}`, revision: 1, enabled: false, timeframe: '5m', cooldownBars: 0, expression: trigger,
    temporal: { mode: 'parallel', match: 'all', timeoutBars: 3, nextBar: false, retrigger: 'replace',
      confirmations: [{ id: 'stochastic', name: 'Стохастик 10/5/5', expression: stochastic, policy: 'latch' },
        { id: 'macd', name: 'MACD 6/8/4 WMA', expression: macd, policy: 'latch' }],
      reset: group('reset', [condition('reverse-cross', series('ema', 5), up ? 'crossDown' : 'crossUp', series('ema', 10))]),
      outcomes: [{ id: 'confirmed', label: `${label}: подтверждён`, expression: confirmed }],
      defaultOutcome: `${label}: ранний`, unknownOutcome: `${label}: недостаточно данных`,
    } };
}
