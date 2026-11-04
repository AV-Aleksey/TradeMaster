import { describe, expect, it } from 'vitest';
import { evaluate, historyRequirements, SignalMachine } from '../src/core/rules';
import { signalSchema, type SeriesOperand, type Expression } from '../src/shared/model';
import { bars, condition, signal } from './fixtures';
import { encodeOperand, fromEditor, operandLabel, toEditor } from '../src/renderer/rule-model';

const fractal: SeriesOperand = { kind: 'series', field: 'fractalHigh', timeframe: '5m', period: 2, offset: 0, factor: '1' };
describe('registered indicators in complete signal evaluations', () => {
  it('does not turn a future or forming fractal confirmation into an earlier crossing', () => {
    const input = bars([1, 3, 7, 3, 1, 8]);
    const expression = condition({ operator: 'crossUp', right: fractal });
    const at = (n: number) => evaluate(expression, { at: input[n].closeTime, series: { '5m': input } });
    expect(at(3).result).toBe('unknown');
    expect(at(4).result).toBe('unknown'); // Previous fractal level did not exist yet.
    expect(at(5).result).toBe('true');
    input[4].closed = false;
    expect(at(4).result).toBe('unknown');
  });
  it('excludes an unclosed/future hourly pivot while comparing different timeframes', () => {
    const hourly = bars([1, 3, 7, 3, 1, 999], '1h'); hourly[5].closed = false;
    const expression = condition({ right: { ...fractal, timeframe: '1h' } });
    const minuteBars = bars([8], '5m', 5 * 3600000);
    expect(evaluate(expression, { at: minuteBars[0].closeTime, series: { '5m': minuteBars, '1h': hourly } }))
      .toMatchObject({ result: 'true', right: '7' });
  });
  it('resets the carried fractal level across a gap instead of reusing pre-gap values', () => {
    const input = [...bars([1, 3, 7, 3, 1]), ...bars([8, 9], '5m', 10 * 300000)];
    expect(evaluate(condition({ right: fractal }), { at: input.at(-1)!.closeTime, series: { '5m': input } }).result).toBe('unknown');
  });
  it('uses offset 1 to compare price with a completed prior window instead of including the breakout itself', () => {
    const input = bars([1, 3, 2, 4]);
    const level: SeriesOperand = { ...fractal, field: 'highest', period: 3, offset: 1 };
    const context = { at: input.at(-1)!.closeTime, series: { '5m': input } };
    expect(evaluate(condition({ right: level }), context)).toMatchObject({ result: 'true', right: '3' });
    expect(evaluate(condition({ right: { ...level, offset: 0 } }), context).result).toBe('false');
  });
  it('runs a composed fractal/volume scheme identically alone and alongside its individual conditions', () => {
    const input = bars([1, 3, 7, 3, 1, 8, 9, 2, 9]);
    const a = condition({ id: 'fractal-break', operator: 'crossUp', right: fractal });
    const b = condition({ id: 'volume', left: { ...fractal, field: 'volumeSum', period: 2 }, right: { kind: 'constant', value: '15' } });
    const expression: Expression = { kind: 'group', id: 'and', combinator: 'and', rules: [a, b] };
    const alone = new SignalMachine(), together = [new SignalMachine(), new SignalMachine(), new SignalMachine()];
    const events: number[] = [], jointEvents: number[] = [];
    input.forEach((bar, i) => {
      const context = { at: bar.closeTime, series: { '5m': input } };
      if (alone.step(signal({ expression }), context, 'test').fire) events.push(i);
      together[0].step(signal({ id: 'a', expression: a }), context, 'test');
      together[1].step(signal({ id: 'b', expression: b }), context, 'test');
      if (together[2].step(signal({ expression }), context, 'test').fire) jointEvents.push(i);
      const prefix = { ...context, series: { '5m': input.slice(0, i + 1) } };
      expect(evaluate(expression, context)).toEqual(evaluate(expression, prefix));
    });
    expect(events).toEqual([5, 8]); expect(jointEvents).toEqual(events);
    input[5].volume = null;
    expect(evaluate(expression, { at: input[5].closeTime, series: { '5m': input } }).result).toBe('unknown');
  });
  it('serializes new fields through the editor and includes offsets and crossing history in the budget', () => {
    const expression = { kind: 'group' as const, id: 'root', combinator: 'and' as const,
      rules: [condition({ operator: 'crossUp', right: { ...fractal, period: 500, offset: 3 } })] };
    expect(signalSchema.parse(signal({ expression })).expression).toEqual(expression);
    expect(fromEditor(toEditor(expression))).toEqual(expression);
    expect(historyRequirements(signal({ expression }))['5m']).toBe(1106);
    expect(operandLabel(fractal)).toBe('Фрактал вверх(2+2) · окно 100 · 5m');
    expect(encodeOperand(fractal)).toContain('fractalHigh');
  });
});
