import { describe, it, expect } from 'vitest';
import { D, sma, wma, ema, macd, stochastic, indicator, indicatorRegistry, indicatorHistoryBars, rollingExtreme, confirmedFractal, volumeSum } from '../src/core/indicators';
import { fields } from '../src/shared/model';
import { indicatorCatalog } from '../src/shared/indicator-catalog';
import { bars } from './fixtures';
const strings = (values: ReturnType<typeof sma>) => values.map(v => v?.toString() ?? null);
describe('independent indicator references', () => {
  it('SMA requires a complete window', () => expect(strings(sma([1, 2, 3, 4, 5].map(v => new D(v)), 3))).toEqual([null, null, '2', '3', '4']));
  it('WMA puts the greatest weight on the latest candle', () => {
    const result = wma([1, 2, 3].map(v => new D(v)), 3);
    expect(result[0]).toBeNull(); expect(result[2]!.minus(new D(14).div(6)).abs().lt('1e-35')).toBe(true);
  });
  it('EMA uses an explicit SMA seed and recursive updates', () => expect(strings(ema([1, 2, 3, 8, 5].map(v => new D(v)), 3))).toEqual([null, null, '2', '5', '5']));
  it('does not bridge unknown EMA input with a stale accumulator', () => {
    expect(strings(ema([new D(1), new D(3), null, new D(5), new D(7)], 2))).toEqual([null, '2', null, null, '6']);
  });
  it('MACD WMA 6/8 is 2/3 on a linear ramp, signal available after 11 samples', () => {
    const result = macd(bars(Array.from({ length: 14 }, (_, i) => i + 1)));
    expect(result.line[6]).toBeNull(); expect(result.signal[9]).toBeNull();
    expect(result.line[7]!.minus(new D(2).div(3)).abs().lt('1e-35')).toBe(true);
    expect(result.signal[10]!.minus(new D(2).div(3)).abs().lt('1e-35')).toBe(true);
    expect(result.hist[10]!.abs().lt('1e-35')).toBe(true);
  });
  it('supports a different oscillator and signal MA without changing formulas elsewhere', () => {
    const result = macd(bars([1, 2, 3, 4]), 2, 3, 2, 'sma', 'sma');
    expect(strings(result.line)).toEqual([null, null, '0.5', '0.5']);
    expect(strings(result.signal)).toEqual([null, null, null, '0.5']);
  });
  it('flat stochastic has configured neutral value and full smoothing warmup', () => {
    const result = stochastic(bars(Array(22).fill(5)));
    expect(result.k[12]).toBeNull(); expect(result.k[13]?.toString()).toBe('50');
    expect(result.d[16]).toBeNull(); expect(result.d[17]?.toString()).toBe('50');
  });
  it('custom stochastic parameters are respected', () => {
    const input = bars([1, 2, 3]); input.forEach(c => { c.low = '0'; c.high = '10'; });
    expect(strings(indicator(input, 'stochK', 10, { kLength: 2, kSmooth: 1, dSmooth: 1 }))).toEqual([null, '20', '30']);
  });
  it('Stochastic Simple applies SMA to both lines with complete warmup and preserves legacy values', () => {
    const input = bars([10, 30, 20, 80, 40]);
    input.forEach(c => { c.low = '0'; c.high = '100'; });
    const params = { kLength: 1, kSmooth: 2, dSmooth: 2 };
    const k = strings(indicator(input, 'stochSimpleK', 10, params));
    const d = strings(indicator(input, 'stochSimpleD', 10, params));
    expect(k).toEqual([null, '20', '25', '50', '60']);
    expect(d).toEqual([null, null, '22.5', '37.5', '55']);
    expect(indicatorHistoryBars('stochSimpleK', 10, params)).toBe(2);
    expect(indicatorHistoryBars('stochSimpleD', 10, params)).toBe(3);
    expect(strings(indicator(input, 'stochK', 10, params))).toEqual(k);
    expect(strings(indicator(input, 'stochD', 10, params))).toEqual(d);
  });
  it('missing volume is unknown and actual zero is a number', () => {
    const input = bars([1, 2, 3]); input[0].volume = null; input[1].volume = '0';
    expect(strings(indicator(input, 'volume', 1))).toEqual([null, '0', '10']);
    expect(indicator(input, 'volumeSma', 2)[1]).toBeNull();
    expect(indicator(input, 'volumeSma', 2)[2]?.toString()).toBe('5');
  });
});
describe('registered window indicators and confirmed fractals', () => {
  it('has a calculation, history budget and UI description for every registered field', () => {
    expect(Object.keys(indicatorRegistry).sort()).toEqual([...fields].sort());
    expect(Object.keys(indicatorCatalog).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(indicator(bars([1, 2, 3]), field, 2)).toHaveLength(3);
      expect(indicatorHistoryBars(field, 2)).toBeGreaterThan(0);
      expect(indicatorCatalog[field].description.length).toBeGreaterThan(5);
    }
  });
  it('takes window extremes from High/Low including the current closed bar', () => {
    const input = bars([5, 4, 6, 3]);
    input.forEach((c, i) => { c.high = ['9', '8', '7', '6'][i]; c.low = ['4', '2', '5', '1'][i]; });
    expect(strings(rollingExtreme(input, 2, 'high'))).toEqual([null, '9', '8', '7']);
    expect(strings(rollingExtreme(input, 2, 'low'))).toEqual([null, '2', '2', '1']);
    expect(strings(indicator(input, 'highest', 1))).toEqual(['9', '8', '7', '6']);
  });
  it('sums exact volumes, keeps zero and recovers after an unknown volume leaves the window', () => {
    const input = bars([1, 2, 3, 4, 5]);
    input.forEach((c, i) => { c.volume = [null, '0', '1.00000000000000000001', '2', '3'][i]; });
    expect(strings(volumeSum(input, 2))).toEqual([null, null, '1.00000000000000000001', '3.00000000000000000001', '5']);
  });
  it('publishes a high fractal only after all right bars close and retains the last level', () => {
    const input = bars([1, 3, 7, 3, 1, 2, 8, 2, 1]);
    expect(strings(confirmedFractal(input, 2, 'high'))).toEqual([null, null, null, null, '7', '7', '7', '7', '8']);
    expect(confirmedFractal(input.slice(0, 4), 2, 'high').at(-1)).toBeNull();
  });
  it('confirms lows symmetrically, using the same delayed availability', () => {
    expect(strings(indicator(bars([9, 7, 3, 7, 9, 8, 2, 8, 9]), 'fractalLow', 2)))
      .toEqual([null, null, null, null, '3', '3', '3', '3', '2']);
  });
  it('rejects plateaus on either side, including values beyond Number precision', () => {
    expect(strings(confirmedFractal(bars([1, 3, 7, 7, 1, 0, 2]), 2, 'high'))).toEqual(Array(7).fill(null));
    expect(strings(confirmedFractal(bars([3, 1, 1, 3]), 1, 'low'))).toEqual(Array(4).fill(null));
    expect(strings(confirmedFractal(bars(['1', '1.00000000000000000001', '1']), 1, 'high')))
      .toEqual([null, null, '1.00000000000000000001']);
  });
  it.each(['highest', 'lowest', 'volumeSum', 'fractalHigh', 'fractalLow'] as const)('%s gives identical values for historical prefixes and full-history calculation', field => {
    const input = bars([3, 1, 8, 2, 4, 9, 5, 3, 1, 7, 2, 4]);
    const full = strings(indicator(input, field, 2));
    for (let n = 1; n <= input.length; n++) expect(strings(indicator(input.slice(0, n), field, 2))).toEqual(full.slice(0, n));
  });
  it.each([0, -1, 1.5, 501])('rejects invalid period %s instead of producing partial windows', period => {
    expect(() => indicator(bars([1]), 'fractalHigh', period)).toThrow(/Период/);
    expect(() => rollingExtreme(bars([1]), period, 'low')).toThrow(/Период/);
  });
  it('budgets both sides of fractals, including periods requiring paginated history', () => {
    expect(indicatorHistoryBars('fractalHigh', 500)).toBe(1100);
    expect(indicatorHistoryBars('volumeSum', 9)).toBe(9);
  });
  it('expires a fractal at the explicit lookback boundary and can publish only on confirmation', () => {
    const input = bars([1, 3, 7, 3, 1, 2, 3, 4]);
    expect(strings(confirmedFractal(input, 2, 'high', 3))).toEqual([null, null, null, null, '7', '7', '7', null]);
    expect(strings(confirmedFractal(input, 2, 'high', 1))).toEqual([null, null, null, null, '7', null, null, null]);
  });
  it.each(['fractalHigh', 'fractalLow'] as const)('%s is independent of longer cache histories when the requested budget is met', field => {
    const input = bars([1, 8, 2, 9, 3, 2, 1, 3, 2, 4, 5, 6, 7, 8, 9]);
    const params = { fractalLookback: 3 }, required = indicatorHistoryBars(field, 2, params);
    for (let n = required; n <= input.length; n++) {
      expect(indicator(input.slice(n - required, n), field, 2, params).at(-1)?.toString() ?? null)
        .toEqual(indicator(input.slice(0, n), field, 2, params).at(-1)?.toString() ?? null);
    }
  });
});
