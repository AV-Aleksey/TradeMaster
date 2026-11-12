import type { Condition, Group, SeriesOperand, Signal, Timeframe } from './model';

/** Indicator families exposed in the simplified constructor. */
export const signalIndicators = [
  { value: 'ema', label: 'EMA', description: 'Экспоненциальная средняя. Период задаётся в свечах.', parameters: 'Период средней' },
  { value: 'sma', label: 'SMA', description: 'Простая средняя. Период задаётся в свечах.', parameters: 'Период средней' },
  { value: 'wma', label: 'WMA', description: 'Взвешенная средняя. Период задаётся в свечах.', parameters: 'Период средней' },
  { value: 'stochK', label: 'Стохастик', description: 'Один индикатор с двумя линиями. Кросс — пересечение быстрой и сигнальной линий.', parameters: '10 / 5 / 5' },
  { value: 'stochSimpleK', label: 'Стохастик Simple', description: 'Стохастик со сглаживанием SMA. Кросс — пересечение быстрой и сигнальной линий.', parameters: '10 / 5 / 5' },
  { value: 'macd', label: 'MACD', description: 'Обычный MACD на EMA. Кросс — пересечение линии MACD и сигнальной линии.', parameters: '12 / 26 / 9' },
] as const;
export type SignalIndicator = typeof signalIndicators[number]['value'];
export const isStochastic = (field: string): boolean => field === 'stochK' || field === 'stochSimpleK';
export function simpleOperand(field: SignalIndicator = 'ema', timeframe: Timeframe = '5m', period = 5): SeriesOperand {
  return { kind: 'series', field, timeframe, period: isStochastic(field) ? 10 : field === 'macd' ? 12 : period, offset: 0, factor: '1',
    ...(isStochastic(field) ? { params: { kLength: 10, kSmooth: 5, dSmooth: 5 } }
      : field === 'macd' ? { params: { fast: 12, slow: 26, signal: 9, oscillatorMa: 'ema', signalMa: 'ema' } } : {}) };
}
export function internalCross(operand: SeriesOperand, operator: string): boolean {
  return operator.startsWith('cross') && (isStochastic(operand.field) || operand.field === 'macd');
}
export function crossPartner(left: SeriesOperand): SeriesOperand {
  return { ...left, field: left.field === 'stochSimpleK' ? 'stochSimpleD' : left.field === 'stochK' ? 'stochD' : left.field === 'macd' ? 'macdSignal' : left.field,
    period: left.field === 'ema' || left.field === 'sma' || left.field === 'wma' ? 10 : left.period };
}
export function simpleCrossSignals(pairId: string, timeframe: Timeframe = '5m'): Signal[] {
  return (['up', 'down'] as const).map(direction => {
    const id = `simple-${pairId}-${direction}`;
    const condition = (block: number, field: 'ema' | 'stochK'): Condition => {
      const left = simpleOperand(field, timeframe, 5);
      return { kind: 'condition', id: `${id}-${block}-${field}`, left, right: crossPartner(left),
        operator: direction === 'up' ? 'crossUp' : 'crossDown', bars: 1 };
    };
    const expression: Group = { kind: 'group', id: `${id}-root`, combinator: 'or',
      rules: (['and', 'or'] as const).map((combinator, block) => ({ kind: 'group', id: `${id}-block-${block}`,
        combinator, rules: [condition(block, 'ema'), condition(block, 'stochK')] })) };
    return { id, pairId, name: direction === 'up' ? 'Сигнал вверх' : 'Сигнал вниз', revision: 1,
      enabled: false, timeframe, cooldownBars: 0, expression };
  });
}
