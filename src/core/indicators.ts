import Decimal from 'decimal.js';
import type { Candle, SeriesField, IndicatorParameters } from '../shared/model';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Value = Decimal | null;
export type Values = Value[];

export function sma(values: Values, period: number): Values {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const window = values.slice(i - period + 1, i + 1);
    return window.some(v => v === null) ? null : window.reduce<Decimal>((sum, v) => sum.plus(v!), new D(0)).div(period);
  });
}
export function wma(values: Values, period: number): Values {
  const denominator = new D(period).times(period + 1).div(2);
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const window = values.slice(i - period + 1, i + 1);
    return window.some(v => v === null) ? null : window.reduce<Decimal>((sum, v, j) => sum.plus(v!.times(j + 1)), new D(0)).div(denominator);
  });
}
export function ema(values: Values, period: number): Values {
  const seed = sma(values, period);
  const alpha = new D(2).div(period + 1);
  let previous: Value = null;
  return values.map((value, i) => {
    if (value === null) { previous = null; return null; }
    previous = previous === null ? seed[i] : value.times(alpha).plus(previous.times(new D(1).minus(alpha)));
    return previous;
  });
}
export function stochastic(candles: Candle[], length = 10, smoothK = 5, smoothD = 5): { k: Values; d: Values } {
  const raw = candles.map((c, i) => {
    if (i < length - 1) return null;
    const window = candles.slice(i - length + 1, i + 1);
    const low = Decimal.min(...window.map(x => new D(x.low)));
    const high = Decimal.max(...window.map(x => new D(x.high)));
    return high.eq(low) ? new D(50) : new D(c.close).minus(low).div(high.minus(low)).times(100);
  });
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}
export function macd(candles: Candle[], fast = 6, slow = 8, signalPeriod = 4, oscillatorMa: 'sma' | 'ema' | 'wma' = 'wma', signalMa: 'sma' | 'ema' | 'wma' = 'wma'): { line: Values; signal: Values; hist: Values } {
  const close = candles.map(c => new D(c.close));
  const means = { sma, ema, wma };
  const fastValues = means[oscillatorMa](close, fast), slowValues = means[oscillatorMa](close, slow);
  const line = fastValues.map((v, i) => v === null || slowValues[i] === null ? null : v.minus(slowValues[i]!));
  const signal = means[signalMa](line, signalPeriod);
  return { line, signal, hist: line.map((v, i) => v === null || signal[i] === null ? null : v.minus(signal[i]!)) };
}
function checkPeriod(period: number): void {
  if (!Number.isSafeInteger(period) || period < 1 || period > 500) throw new Error('Период показателя должен быть от 1 до 500 свечей');
}
export function rollingExtreme(candles: Candle[], period: number, side: 'high' | 'low'): Values {
  checkPeriod(period);
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const values = candles.slice(i - period + 1, i + 1).map(c => new D(c[side]));
    return side === 'high' ? D.max(...values) : D.min(...values);
  });
}
export function volumeSum(candles: Candle[], period: number): Values {
  checkPeriod(period);
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const window = candles.slice(i - period + 1, i + 1);
    return window.some(c => c.volume === null) ? null : window.reduce((sum, c) => sum.plus(c.volume!), new D(0));
  });
}
/** Index i records when a fractal became knowable, never the earlier pivot index. */
export function confirmedFractal(candles: Candle[], period: number, side: 'high' | 'low', lookback = 100): Values {
  checkPeriod(period);
  if (!Number.isSafeInteger(lookback) || lookback < 1 || lookback > 10000) throw new Error('Окно поиска фрактала должно быть от 1 до 10000 свечей');
  let confirmed: Value = null;
  let confirmedAt = -Infinity;
  return candles.map((_, i) => {
    if (i >= period * 2) {
      const pivotIndex = i - period, pivot = new D(candles[pivotIndex][side]);
      const window = candles.slice(i - period * 2, i + 1);
      if (window.every((c, j) => j === period || (side === 'high' ? pivot.gt(c[side]) : pivot.lt(c[side])))) { confirmed = pivot; confirmedAt = i; }
    }
    return i - confirmedAt < lookback ? confirmed : null;
  });
}

interface IndicatorDefinition {
  calculate: (candles: Candle[], period: number, params: IndicatorParameters) => Values;
  historyBars: (period: number, params: IndicatorParameters) => number;
}
export function legVolumeRatio(candles: Candle[], period: number): Values {
  checkPeriod(period);
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const window = candles.slice(i - period + 1, i + 1);
    let maximum = 0;
    window.forEach((c, j) => { if (new D(c.high).gte(window[maximum].high)) maximum = j; });
    if (maximum === window.length - 1) return null;
    let minimum = maximum + 1;
    window.forEach((c, j) => { if (j > maximum && new D(c.low).lte(window[minimum].low)) minimum = j; });
    const mean = (section: Candle[]): Value => section.some(c => c.volume === null) ? null
      : section.reduce((sum, c) => sum.plus(c.volume!), new D(0)).div(section.length);
    const impulse = mean(window.slice(maximum, minimum + 1)), bounce = mean(window.slice(minimum));
    return impulse === null || bounce === null || impulse.isZero() ? null : bounce.div(impulse);
  });
}
const raw = (field: 'open' | 'high' | 'low' | 'close' | 'volume'): IndicatorDefinition => ({
  calculate: candles => candles.map(c => c[field] === null ? null : new D(c[field]!)), historyBars: () => 1,
});
const average = (calculate: typeof sma): IndicatorDefinition => ({
  calculate: (candles, period) => calculate(candles.map(c => new D(c.close)), period), historyBars: period => period,
});
const stochasticHistory = (params: IndicatorParameters, d: boolean): number => (params.kLength ?? 10) + (params.kSmooth ?? 5) - 1 + (d ? (params.dSmooth ?? 5) - 1 : 0);
const macdHistory = (params: IndicatorParameters, withSignal: boolean): number => Math.max(params.fast ?? 6, params.slow ?? 8)
  + (withSignal ? (params.signal ?? 4) - 1 : 0) + (params.oscillatorMa === 'ema' || (withSignal && params.signalMa === 'ema') ? 20 : 0);
const macdDefinition = (output: 'line' | 'signal' | 'hist'): IndicatorDefinition => ({
  calculate: (candles, _period, p) => macd(candles, p.fast, p.slow, p.signal, p.oscillatorMa, p.signalMa)[output],
  historyBars: (_period, p) => macdHistory(p, output !== 'line'),
});

/** Exhaustive registry: a new field must provide both its calculation and history budget. */
export const indicatorRegistry: Record<SeriesField, IndicatorDefinition> = {
  legVolumeRatio: { calculate: legVolumeRatio, historyBars: period => period },
  open: raw('open'), high: raw('high'), low: raw('low'), close: raw('close'), volume: raw('volume'),
  sma: average(sma), wma: average(wma), ema: { ...average(ema), historyBars: period => period + 20 },
  volumeSma: { calculate: (candles, period) => sma(candles.map(c => c.volume === null ? null : new D(c.volume)), period), historyBars: period => period },
  stochK: { calculate: (candles, _period, p) => stochastic(candles, p.kLength, p.kSmooth, p.dSmooth).k, historyBars: (_period, p) => stochasticHistory(p, false) },
  stochD: { calculate: (candles, _period, p) => stochastic(candles, p.kLength, p.kSmooth, p.dSmooth).d, historyBars: (_period, p) => stochasticHistory(p, true) },
  macd: macdDefinition('line'), macdSignal: macdDefinition('signal'), macdHist: macdDefinition('hist'),
  highest: { calculate: (candles, period) => rollingExtreme(candles, period, 'high'), historyBars: period => period },
  lowest: { calculate: (candles, period) => rollingExtreme(candles, period, 'low'), historyBars: period => period },
  volumeSum: { calculate: volumeSum, historyBars: period => period },
  fractalHigh: { calculate: (candles, period, p) => confirmedFractal(candles, period, 'high', p.fractalLookback), historyBars: (period, p) => period * 2 + (p.fractalLookback ?? 100) },
  fractalLow: { calculate: (candles, period, p) => confirmedFractal(candles, period, 'low', p.fractalLookback), historyBars: (period, p) => period * 2 + (p.fractalLookback ?? 100) },
};
export function indicatorHistoryBars(field: SeriesField, period: number, params: IndicatorParameters = {}): number {
  checkPeriod(period); return indicatorRegistry[field].historyBars(period, params);
}
export function indicator(candles: Candle[], field: SeriesField, period: number, params: IndicatorParameters = {}): Values {
  checkPeriod(period); return indicatorRegistry[field].calculate(candles, period, params);
}
