import { describe, it, expect } from 'vitest';
import { evaluate, SignalMachine } from '../src/core/rules';
import { checkExpressionLimits, defaultExpression, type Expression, type Operator, type Truth } from '../src/shared/model';
import { bars, condition, signal } from './fixtures';
import { crossPartner, simpleOperand } from '../src/shared/simple-signals';
import { fromEditor, normalizeSimpleEditor, toEditor } from '../src/renderer/rule-model';
const evaluateAt = (expression: Expression, input = bars([1, 2, 3])) => evaluate(expression, { at: input.at(-1)!.closeTime, series: { '5m': input } });
describe('conditions, boundaries and composition', () => {
  it('preserves Stochastic Simple through the editor and detects crosses in both directions', () => {
    const input = bars([80, 20, 40, 60, 20]);
    input.forEach(c => { c.low = '0'; c.high = '100'; });
    const left = { ...simpleOperand('stochSimpleK'), params: { kLength: 1, kSmooth: 1, dSmooth: 2 } };
    for (const [operator, count] of [['crossUp', 3], ['crossDown', 5]] as const) {
      const expression = { kind: 'group' as const, id: 'root', combinator: 'and' as const,
        rules: [condition({ left, right: crossPartner(left), operator })] };
      const restored = fromEditor(normalizeSimpleEditor(toEditor(expression)));
      expect(restored).toEqual(expression);
      checkExpressionLimits(restored);
      expect(evaluateAt(restored, input.slice(0, count)).result).toBe('true');
      const forming = input.slice(0, count).map(c => ({ ...c }));
      forming[count - 1].closed = false;
      expect(evaluateAt(restored, forming).result).not.toBe('true');
    }
  });
  it.each<[Operator, Truth]>([['gt', 'true'], ['gte', 'true'], ['lt', 'false'], ['lte', 'false'], ['eq', 'false']])('%s compares Decimal values', (operator, expected) => {
    expect(evaluateAt(condition({ operator })).result).toBe(expected);
  });
  it.each<[Operator, Truth]>([['gt', 'false'], ['gte', 'true'], ['lt', 'false'], ['lte', 'true'], ['eq', 'true']])('%s handles equality at threshold', (operator, expected) => {
    expect(evaluateAt(condition({ operator }), bars([2])).result).toBe(expected);
  });
  it('preserves a difference beyond Number precision', () => {
    expect(evaluateAt(condition({ right: { kind: 'constant', value: '1.00000000000000000001' } }), bars(['1.00000000000000000002'])).result).toBe('true');
  });
  it('cross up includes previous equality, excludes current equality', () => {
    expect(evaluateAt(condition({ operator: 'crossUp' }), bars([2, 3])).result).toBe('true');
    expect(evaluateAt(condition({ operator: 'crossUp' }), bars([1, 2])).result).toBe('false');
    expect(evaluateAt(condition({ operator: 'crossUp' }), bars([3, 4])).result).toBe('false');
  });
  it('cross down is symmetric', () => {
    expect(evaluateAt(condition({ operator: 'crossDown' }), bars([2, 1])).result).toBe('true');
    expect(evaluateAt(condition({ operator: 'crossDown' }), bars([3, 2])).result).toBe('false');
  });
  it('checks every comparison for N-bar growth', () => {
    expect(evaluateAt(condition({ operator: 'rising', bars: 2 }), bars([1, 2, 3])).result).toBe('true');
    expect(evaluateAt(condition({ operator: 'rising', bars: 2 }), bars([2, 1, 3])).result).toBe('false');
    expect(evaluateAt(condition({ operator: 'rising', bars: 2 }), bars([1, 3])).result).toBe('unknown');
  });
  for (const a of ['true', 'false', 'unknown'] as Truth[]) for (const b of ['true', 'false', 'unknown'] as Truth[]) {
    it(`AND/OR truth table ${a},${b}`, () => {
      const make = (result: Truth, id: string) => condition({ id, right: { kind: 'constant', value: result === 'true' ? '0' : '9' },
        ...(result === 'unknown' ? { left: { kind: 'series' as const, field: 'close' as const, timeframe: '1h' as const, period: 1, offset: 0, factor: '1' } } : {}) });
      const nodes = [make(a, 'a'), make(b, 'b')];
      expect(evaluateAt({ kind: 'group', id: 'root', combinator: 'and', rules: nodes }).result).toBe(a === 'false' || b === 'false' ? 'false' : a === 'true' && b === 'true' ? 'true' : 'unknown');
      expect(evaluateAt({ kind: 'group', id: 'root', combinator: 'or', rules: nodes }).result).toBe(a === 'true' || b === 'true' ? 'true' : a === 'false' && b === 'false' ? 'false' : 'unknown');
    });
  }
  it('handles mixed nested groups', () => {
    expect(evaluateAt({ kind: 'group', id: 'and', combinator: 'and', rules: [condition(), { kind: 'group', id: 'or', combinator: 'or', rules: [condition({ id: 'bad', operator: 'lt' }), condition({ id: 'good', operator: 'gt' })] }] }).result).toBe('true');
  });
  it('never uses forming or future higher-timeframe candles', () => {
    const expression = condition({ left: { kind: 'series', field: 'close', timeframe: '1h', period: 1, offset: 0, factor: '1' } });
    const hourly = bars([1, 100, 999], '1h'); hourly[1].closed = false;
    expect(evaluate(expression, { at: 90 * 60000, series: { '1h': hourly } }).left).toBe('1');
    expect(evaluate(expression, { at: 30 * 60000, series: { '1h': hourly } }).result).toBe('unknown');
  });
  it('future modifications do not change any historical prefix result', () => {
    const input = bars(Array.from({ length: 36 }, (_, i) => i % 9 < 5 ? i % 9 + 1 : 10 - i % 9));
    const expression = condition({ left: { kind: 'series', field: 'ema', timeframe: '5m', period: 3, offset: 0, factor: '1' }, operator: 'crossUp' });
    for (let i = 1; i <= input.length; i++) {
      const at = input[i - 1].closeTime;
      const prefix = evaluate(expression, { at, series: { '5m': input.slice(0, i) } });
      const full = evaluate(expression, { at, series: { '5m': input } });
      expect(full).toEqual(prefix);
    }
  });
  it('does not calculate cross or EMA through a gap', () => {
    const input = bars([1, 3]); input[1].openTime += 300000; input[1].closeTime += 300000;
    expect(evaluateAt(condition({ operator: 'crossUp' }), input).result).toBe('unknown');
    expect(evaluateAt(condition({ left: { kind: 'series', field: 'ema', timeframe: '5m', period: 2, offset: 0, factor: '1' } }), input).result).toBe('unknown');
  });
  it('rejects mixed-timeframe cross and oversized schemas', () => {
    expect(() => checkExpressionLimits(condition({ operator: 'crossUp', right: { kind: 'series', field: 'close', timeframe: '1h', period: 1, offset: 0, factor: '1' } }))).toThrow();
    expect(() => checkExpressionLimits({ kind: 'group', id: 'root', combinator: 'and', rules: Array.from({ length: 101 }, () => condition()) })).toThrow();
  });
});
describe('signal execution state', () => {
  it('emits once on rising edge and rearms only after false', () => {
    const machine = new SignalMachine(), s = signal();
    const input = bars([1, 3, 4, 1, 5]);
    const fired = input.map((bar, i) => machine.step(s, { at: bar.closeTime, series: { '5m': input.slice(0, i + 1) } }, 'dataset').fire);
    expect(fired).toEqual([false, true, false, false, true]);
    expect(machine.step(s, { at: input.at(-1)!.closeTime, series: { '5m': input } }, 'dataset').fire).toBe(false);
  });
  it('disabled signal cannot fire', () => expect(new SignalMachine().step(signal({ enabled: false }), { at: 300000, series: { '5m': bars([3]) } }, 'd').fire).toBe(false));
  it('cooldown counts closed bars, not elapsed wall time', () => {
    const machine = new SignalMachine(), s = signal({ cooldownBars: 4 }), input = bars([3, 1, 3, 1, 3]);
    expect(input.map((c, i) => machine.step(s, { at: c.closeTime, series: { '5m': input.slice(0, i + 1) } }, 'd').fire)).toEqual([true, false, false, false, true]);
  });
  it('unknown does not rearm a true condition', () => {
    const machine = new SignalMachine(), s = signal();
    expect(machine.step(s, { at: 300000, series: { '5m': bars([3]) } }, 'd').fire).toBe(true);
    expect(machine.step(s, { at: 600000, series: {} }, 'd').fire).toBe(false);
    expect(machine.step(s, { at: 900000, series: { '5m': bars([3, 3, 3]) } }, 'd').fire).toBe(false);
  });
  it('separate machines and joint execution produce the same per-signal events', () => {
    const input = bars([1, 3, 4, 1, 5]);
    const definitions = [signal(), signal({ id: 'down', expression: condition({ operator: 'lt' }) })];
    const run = (defs: typeof definitions) => {
      const machines = defs.map(() => new SignalMachine());
      return defs.map((s, j) => input.flatMap((bar, i) => machines[j].step(s, { at: bar.closeTime, series: { '5m': input.slice(0, i + 1) } }, 'd').fire ? [bar.closeTime] : []));
    };
    expect(run(definitions)).toEqual(definitions.map(s => run([s])[0]));
  });
});
