import { describe, expect, it } from 'vitest';
import { D, indicator } from '../src/core/indicators';
import { evaluate, historyRequirements, requiredTimeframes, SignalMachine } from '../src/core/rules';
import { readmeReversal } from '../src/shared/readme-presets';
import { signalSchema, type Condition, type EvaluationWindow, type Expression, type Group } from '../src/shared/model';
import { fromTemporalDraft, temporalDraft } from '../src/renderer/temporal-editor-model';
import { fromEditor, toEditor } from '../src/renderer/rule-model';
import { bars, condition, signal } from './fixtures';
const tf = 300000;
const inWindow = (window: Partial<EvaluationWindow> = {}): Condition => ({ ...condition(), window: { anchor: 'trigger', timeframe: '5m', from: -1, to: 2, match: 'any', ...window } });

describe('generic trigger-relative windows', () => {
  it('finds an earlier observation without seeing future confirmation bars', () => {
    const rows = bars([1, 3, 1, 1, 9]);
    expect(evaluate(inWindow(), { at: rows[2].closeTime, triggerAt: rows[2].closeTime, series: { '5m': rows } }).result).toBe('true');
    expect(evaluate(inWindow({ from: 0 }), { at: rows[2].closeTime, triggerAt: rows[2].closeTime, series: { '5m': rows } }).result).toBe('unknown');
    expect(evaluate(inWindow(), { at: rows[2].closeTime, series: { '5m': rows } }).result).toBe('unknown');
  });
  it('waits for the future window boundary for all, and returns false only on a known counterexample', () => {
    const rows = bars([3, 4, 5, 6]);
    const window = inWindow({ from: 0, to: 2, match: 'all' });
    expect(evaluate(window, { at: tf, triggerAt: tf, series: { '5m': rows } }).result).toBe('unknown');
    expect(evaluate(window, { at: 3 * tf, triggerAt: tf, series: { '5m': rows } }).result).toBe('true');
    rows[1].close = '1';
    expect(evaluate(window, { at: 2 * tf, triggerAt: tf, series: { '5m': rows } }).result).toBe('false');
  });
  it('uses current-relative past windows and refuses to prove all when a bar is missing', () => {
    const rows = bars([3, 4, 5]);
    const window = inWindow({ anchor: 'current', from: -2, to: 0, match: 'all' });
    expect(evaluate(window, { at: 3 * tf, series: { '5m': rows } }).result).toBe('true');
    expect(evaluate(window, { at: 3 * tf, series: { '5m': [rows[0], rows[2]] } }).result).toBe('unknown');
  });
  it('budgets lookback in the operand timeframe and fetches the window clock too', () => {
    const expression = { ...inWindow({ anchor: 'current', timeframe: '1h', from: -3, to: 0 }), left: { ...condition().left, field: 'ema' as const, period: 10 } };
    const definition = signal({ expression });
    expect(requiredTimeframes(definition)).toContain('1h');
    expect(historyRequirements(definition)['5m']).toBe(68);
    expect(signalSchema.safeParse(signal({ expression: inWindow() })).success).toBe(false);
    expect(signalSchema.safeParse(signal({ expression: inWindow({ anchor: 'current', to: 1 }) })).success).toBe(false);
    const nested: Group = { kind: 'group', id: 'nested', combinator: 'and', rules: [inWindow()], window: inWindow().window };
    expect(signalSchema.safeParse(signal({ expression: nested })).success).toBe(false);
  });
  it('respects exact README crossover equalities independently of ordinary EMA crosses', () => {
    expect(evaluate(condition({ operator: 'crossUpTouch' }), { at: 2 * tf, series: { '5m': bars([1, 2]) } }).result).toBe('true');
    expect(evaluate(condition({ operator: 'crossUpTouch' }), { at: 2 * tf, series: { '5m': bars([2, 3]) } }).result).toBe('false');
    expect(evaluate(condition({ operator: 'crossDownTouch' }), { at: 2 * tf, series: { '5m': bars([3, 2]) } }).result).toBe('true');
    expect(evaluate(condition({ operator: 'crossDownTouch' }), { at: 2 * tf, series: { '5m': bars([2, 1]) } }).result).toBe('false');
  });
});

describe('maximum → subsequent minimum → current volume', () => {
  it('uses inclusive sections and their means rather than total volumes', () => {
    const rows = bars([10, 8, 5, 7, 9]); rows.forEach((c, i) => { c.volume = ['30', '20', '10', '20', '30'][i]; });
    expect(indicator(rows, 'legVolumeRatio', 5).at(-1)?.toString()).toBe('1');
    expect(indicator(rows.slice(0, 4), 'legVolumeRatio', 5).at(-1)).toBeNull();
  });
  it('uses the latest equal extrema and requires the minimum to follow the maximum', () => {
    const rows = bars([10, 10, 5, 7, 8]); rows.forEach((c, i) => { c.volume = ['100', '20', '10', '20', '30'][i]; });
    expect(indicator(rows, 'legVolumeRatio', 5).at(-1)!.minus(new D(4).div(3)).abs().lt('1e-35')).toBe(true);
    expect(indicator(bars([1, 2, 3, 4, 5]), 'legVolumeRatio', 5).at(-1)).toBeNull();
  });
  it('does not replace missing or zero impulse volume with an invented ratio', () => {
    const rows = bars([10, 8, 5, 7, 9]); rows[1].volume = null;
    expect(indicator(rows, 'legVolumeRatio', 5).at(-1)).toBeNull();
    rows.forEach((c, i) => { c.volume = i < 3 ? '0' : '20'; });
    expect(indicator(rows, 'legVolumeRatio', 5).at(-1)).toBeNull();
  });
  it('allows a one-bar inclusive bounce when the minimum is the current bar', () => {
    const rows = bars([10, 8, 5]); rows.forEach((c, i) => { c.volume = ['30', '20', '10'][i]; });
    expect(indicator(rows, 'legVolumeRatio', 3).at(-1)?.toString()).toBe('0.5');
  });
});

describe('generic outcome labels', () => {
  const definition = () => signal({ expression: condition(), temporal: { mode: 'parallel', match: 'all', timeoutBars: 0, nextBar: false, retrigger: 'ignore',
    confirmations: [{ id: 'c', name: 'Готово', policy: 'latch', expression: condition() }],
    outcomes: [{ id: 'volume', label: 'Подтверждён', expression: condition({ left: { ...condition().left, field: 'volume' } }) }],
    defaultOutcome: 'Ранний', unknownOutcome: 'Недостаточно данных' } });
  it.each([['10', 'Подтверждён'], ['1', 'Ранний'], [null, 'Недостаточно данных']] as const)('classifies known and unknown volume %s without changing event detection', (volume, category) => {
    const rows = bars([1, 3]); rows[1].volume = volume;
    const machine = new SignalMachine();
    machine.step(definition(), { at: tf, series: { '5m': rows } }, 'data');
    expect(machine.step(definition(), { at: 2 * tf, series: { '5m': rows } }, 'data')).toMatchObject({ fire: true, category });
  });
  it('does not skip an unknown higher-priority outcome to select a lower true branch', () => {
    const config = definition(); config.temporal!.outcomes!.push({ id: 'later', label: 'Другой', expression: condition() });
    const rows = bars([1, 3]); rows[1].volume = null;
    const machine = new SignalMachine(); machine.step(config, { at: tf, series: { '5m': rows } }, 'data');
    expect(machine.step(config, { at: 2 * tf, series: { '5m': rows } }, 'data').category).toBe('Недостаточно данных');
  });
});

describe('README declarative templates', () => {
  it.each(['up', 'down'] as const)('%s is a valid, disabled, ordinary editable signal with exact parameters', direction => {
    const preset = readmeReversal('pair', direction, direction);
    expect(signalSchema.parse(preset)).toEqual(preset);
    expect(preset.enabled).toBe(false); expect(preset.cooldownBars).toBe(0);
    expect(preset.temporal).toMatchObject({ timeoutBars: 3, retrigger: 'replace', match: 'all', mode: 'parallel' });
    expect(fromEditor(toEditor(preset.expression as Group))).toEqual(preset.expression);
    expect(fromTemporalDraft(temporalDraft(preset.temporal))).toEqual(preset.temporal);
    const stochastic = preset.temporal!.confirmations[0].expression as Group;
    expect(stochastic.rules.slice(0, 2).every(c => c.window?.from === -3 && c.window.to === 3)).toBe(true);
    expect((stochastic.rules[1] as Condition).operator).toBe(direction === 'up' ? 'crossUpTouch' : 'crossDownTouch');
    expect(historyRequirements(preset)['5m']).toBeGreaterThanOrEqual(113);
  });
  it('runs both directions on real calculated indicator values without special preset code in the engine', () => {
    let seed = 17, price = 100;
    const rows = bars(Array.from({ length: 240 }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      price += (seed % 11 - 5) / 2 + (i % 40 < 20 ? -0.3 : 0.3); return String(price);
    }));
    rows.forEach(c => { c.high = new D(c.close).plus(1).toString(); c.low = new D(c.close).minus(1).toString(); c.volume = '10'; });
    const events: Record<string, number[]> = {};
    for (const direction of ['up', 'down'] as const) {
      const preset = { ...readmeReversal('pair', direction, direction), enabled: true }, machine = new SignalMachine();
      events[direction] = [];
      rows.forEach((row, i) => {
        const result = machine.step(preset, { at: row.closeTime, series: { '5m': rows } }, 'synthetic');
        if (result.fire) { events[direction].push(i); expect(result.triggeredAt).toBeLessThanOrEqual(row.closeTime); expect(row.closeTime - result.triggeredAt!).toBeLessThanOrEqual(3 * tf); }
      });
    }
    expect(events.up.length).toBeGreaterThan(0); expect(events.down.length).toBeGreaterThan(0);
  });
});
