import { describe, expect, it } from 'vitest';
import { historyRequirements, requiredTimeframes, SignalMachine } from '../src/core/rules';
import { signalSchema, type Candle, type Signal, type TemporalRule } from '../src/shared/model';
import { bars, condition, signal } from './fixtures';

const tf = 300000;
const high = condition({ id: 'high', left: { ...condition().left, field: 'high' }, right: { kind: 'constant', value: '10' } });
const volume = condition({ id: 'volume', left: { ...condition().left, field: 'volume' }, right: { kind: 'constant', value: '10' } });
function chain(config: Partial<TemporalRule> = {}, overrides: Partial<Signal> = {}): Signal {
  return signal({ expression: condition({ operator: 'crossUp' }), temporal: { mode: 'parallel', match: 'all', timeoutBars: 3,
    retrigger: 'ignore', nextBar: false, confirmations: [
      { id: 'a', name: 'Вершина', expression: high, policy: 'latch' },
      { id: 'b', name: 'Объём', expression: volume, policy: 'latch' },
    ], ...config }, ...overrides });
}
function input(prices: number[], highs: number[] = [], volumes: Array<number | null> = []): Candle[] {
  return bars(prices).map((c, i) => ({ ...c, high: String(Math.max(prices[i], highs[i] ?? 0)), volume: volumes[i] === null ? null : String(volumes[i] ?? 0) }));
}
function run(definition: Signal, rows: Candle[]) {
  const machine = new SignalMachine();
  return rows.map(row => machine.step(definition, { at: row.closeTime, series: { '5m': rows } }, 'dataset'));
}
const firing = (results: ReturnType<typeof run>) => results.flatMap((r, i) => r.fire ? [i] : []);

describe('temporal confirmations and lifecycle', () => {
  it('remembers independent parallel confirmations and emits one event with the original trigger', () => {
    const result = run(chain(), input([1, 3, 4, 5, 6], [0, 20], [0, 0, 20]));
    expect(firing(result)).toEqual([2]);
    expect(result[2]).toMatchObject({ state: 'completed', triggeredAt: 2 * tf, progress: { confirmed: 2, total: 2 } });
    expect(result[2].explanation.children?.find(c => c.id === 'a')).toMatchObject({ result: 'true', candleTime: 2 * tf });
    expect(result[3].state).toBe('idle');
  });
  it('rechecks selected confirmations at completion instead of remembering them as true', () => {
    const definition = chain(); definition.temporal!.confirmations[0].policy = 'recheck';
    const result = run(definition, input([1, 3, 4, 5], [0, 20, 0, 20], [0, 0, 20]));
    expect(result[2].fire).toBe(false); expect(firing(result)).toEqual([3]);
  });
  it('unknown cannot confirm or rearm, and an earlier known fact remains latched', () => {
    const result = run(chain(), input([1, 3, 4, 5], [0, 20], [0, null, null, 20]));
    expect(result[2].explanation.result).toBe('unknown'); expect(firing(result)).toEqual([3]);
  });
  it('any-confirmation mode accepts either group without requiring the other data', () => {
    expect(firing(run(chain({ match: 'any' }), input([1, 3, 4], [0, 20], [null, null, null])))).toEqual([1]);
  });
  it('accepts confirmations on the inclusive last bar of the window', () => {
    expect(firing(run(chain(), input([1, 3, 4, 5, 6], [0, 20], [0, 0, 0, 0, 20])))).toEqual([4]);
  });
  it('expires after checking the boundary and ignores later confirmations', () => {
    const result = run(chain(), input([1, 3, 4, 5, 6, 7], [0, 20], [0, 0, 0, 0, 0, 20]));
    expect(result[4].state).toBe('expired'); expect(firing(result)).toEqual([]);
  });
  it('timeout zero allows the trigger candle only', () => {
    expect(firing(run(chain({ timeoutBars: 0 }), input([1, 3], [0, 20], [0, 20])))).toEqual([1]);
    const late = run(chain({ timeoutBars: 0 }), input([1, 3, 4], [0, 20], [0, 0, 20]));
    expect(late[1].state).toBe('expired'); expect(firing(late)).toEqual([]);
  });
  it('reset wins over trigger and all confirmations on the same candle', () => {
    const result = run(chain({ reset: condition({ right: { kind: 'constant', value: '2' } }) }), input([1, 3, 4], [0, 20, 20], [0, 20, 20]));
    expect(result[1].state).toBe('reset'); expect(firing(result)).toEqual([]);
  });
  it('cancels an active chain on reset without replaying a completed confirmation later', () => {
    const reset = condition({ operator: 'lt', right: { kind: 'constant', value: '2' } });
    const result = run(chain({ reset }), input([1, 3, 1, 3, 4], [0, 20], [0, 0, 20, 20, 20]));
    expect(result[2].state).toBe('reset'); expect(firing(result)).toEqual([]);
  });
  it('unknown reset blocks completion and still expires at the boundary', () => {
    const reset = { ...volume, operator: 'lt' as const, right: { kind: 'constant' as const, value: '0' } };
    const result = run(chain({ reset, timeoutBars: 1 }), input([1, 3, 4], [0, 20, 20], [0, 0, null]));
    expect(result[2]).toMatchObject({ fire: false, state: 'expired', explanation: { result: 'unknown' } });
  });
  it('does not capture a trigger on unknown reset and requires a fresh edge after data returns', () => {
    const reset = { ...volume, operator: 'lt' as const, right: { kind: 'constant' as const, value: '0' } };
    const rows = input([1, 3, 4, 1, 3], [20, 20, 20, 20, 20], [0, null, 20, 0, 20]);
    const result = run(chain({ reset }), rows);
    expect(result[1]).toMatchObject({ state: 'idle', explanation: { result: 'unknown' } });
    expect(firing(result)).toEqual([4]);
  });
  it('can require confirmations to begin on the following candle', () => {
    const result = run(chain({ nextBar: true }), input([1, 3, 4], [0, 20, 20], [0, 20, 20]));
    expect(firing(result)).toEqual([2]);
  });
  it('processes sequential stages in order rather than latching a premature second confirmation', () => {
    const result = run(chain({ mode: 'sequential' }), input([1, 3, 4, 5], [0, 0, 20], [0, 20, 0, 20]));
    expect(firing(result)).toEqual([3]);
  });
  it('allows several sequential stages on one candle unless nextBar is selected', () => {
    const rows = input([1, 3, 4, 5], [0, 20, 20, 20], [0, 20, 20, 20]);
    expect(firing(run(chain({ mode: 'sequential' }), rows))).toEqual([1]);
    expect(firing(run(chain({ mode: 'sequential', nextBar: true }), rows))).toEqual([3]);
  });
  it('does not turn nextBar plus a zero-length window into same-bar confirmation', () => {
    const result = run(chain({ timeoutBars: 0, nextBar: true }), input([1, 3, 4], [20, 20, 20], [20, 20, 20]));
    expect(firing(result)).toEqual([]); expect(result[1].state).toBe('expired');
  });
  it('rechecks earlier sequential stages again at final completion', () => {
    const definition = chain({ mode: 'sequential' }); definition.temporal!.confirmations[0].policy = 'recheck';
    const result = run(definition, input([1, 3, 4, 5], [0, 20, 0, 20], [0, 0, 20]));
    expect(firing(result)).toEqual([3]);
  });
  it('waits for an optional final filter while retaining latched stage facts', () => {
    const completion = condition({ right: { kind: 'constant', value: '4' } });
    const result = run(chain({ completion }), input([1, 3, 4, 5], [0, 20], [0, 20]));
    expect(firing(result)).toEqual([3]);
  });
  it.each(['ignore', 'replace'] as const)('%s handles a new trigger in an already active chain', retrigger => {
    const result = run(chain({ retrigger }), input([1, 3, 1, 3, 4], [0, 20], [0, 0, 0, 20]));
    expect(firing(result)).toEqual(retrigger === 'ignore' ? [3] : []);
    if (retrigger === 'replace') expect(result[3].triggeredAt).toBe(4 * tf);
  });
  it('replacement restarts the inclusive timeout from the new trigger', () => {
    const result = run(chain({ retrigger: 'replace', timeoutBars: 2 }), input([1, 3, 1, 3, 4, 5], [0, 0, 0, 20], [0, 0, 0, 0, 0, 20]));
    expect(firing(result)).toEqual([5]);
  });
  it('cooldown rejects new triggers without queueing them for later', () => {
    const definition = chain({ match: 'any' }, { cooldownBars: 3 });
    const result = run(definition, input([1, 3, 1, 3, 1, 3], [20, 20, 20, 20, 20, 20]));
    expect(firing(result)).toEqual([1, 5]); expect(result[3].state).toBe('cooldown');
  });
  it('duplicate and older messages cannot advance stages or emit twice', () => {
    const definition = chain({ mode: 'sequential', nextBar: true });
    const rows = input([1, 3, 4], [0, 20, 20], [0, 20, 20]);
    const machine = new SignalMachine();
    const step = (i: number) => machine.step(definition, { at: rows[i].closeTime, series: { '5m': rows } }, 'dataset');
    step(0); step(1); expect(step(2).fire).toBe(false);
    expect(step(2).fire).toBe(false); expect(step(1).fire).toBe(false);
  });
  it('a gap cancels pending facts and primes the new trigger state', () => {
    const rows = input([1, 3, 4], [0, 20], [0, 0, 20]);
    rows[2].openTime += tf; rows[2].closeTime += tf;
    const result = run(chain(), rows);
    expect(result[2]).toMatchObject({ fire: false, state: 'gap', explanation: { result: 'unknown' } });
  });
  it('priming a true trigger starts no historical chain and needs a fresh transition', () => {
    const definition = chain({}, { expression: condition() });
    const rows = input([3, 4, 1, 3], [20, 20, 20, 20], [20, 20, 20, 20]);
    const machine = new SignalMachine();
    machine.prime(definition, { at: rows[0].closeTime, series: { '5m': rows } }, 'dataset');
    expect(machine.step(definition, { at: rows[1].closeTime, series: { '5m': rows } }, 'dataset').fire).toBe(false);
    machine.step(definition, { at: rows[2].closeTime, series: { '5m': rows } }, 'dataset');
    expect(machine.step(definition, { at: rows[3].closeTime, series: { '5m': rows } }, 'dataset').fire).toBe(true);
  });
  it('revision, source and explicit reset discard old confirmations', () => {
    for (const change of ['revision', 'source', 'reset'] as const) {
      const definition = chain(), rows = input([1, 3, 4], [0, 20], [0, 0, 20]);
      const machine = new SignalMachine();
      rows.slice(0, 2).forEach(row => machine.step(definition, { at: row.closeTime, series: { '5m': rows } }, 'first'));
      if (change === 'revision') definition.revision++;
      if (change === 'reset') machine.reset();
      expect(machine.step(definition, { at: rows[2].closeTime, series: { '5m': rows } }, change === 'source' ? 'second' : 'first').fire).toBe(false);
    }
  });
  it('does not start or advance a disabled signal', () => {
    expect(firing(run(chain({}, { enabled: false }), input([1, 3, 4], [0, 20], [0, 20])))).toEqual([]);
  });
});

describe('temporal mixed periods, isolation and schema', () => {
  it('uses only the last closed hourly confirmation and never a future or forming hourly bar', () => {
    const definition = chain({ confirmations: [{ id: 'hour', name: 'Час', policy: 'latch',
      expression: condition({ left: { ...condition().left, timeframe: '1h' }, right: { kind: 'constant', value: '2' } }) }] });
    const hourly = bars([1, 4, 999], '1h'); hourly[1].closed = false;
    const rows = bars([1, 3, 4, 5], '5m', 3600000);
    const machine = new SignalMachine();
    const results = rows.map(row => machine.step(definition, { at: row.closeTime, series: { '5m': rows, '1h': hourly } }, 'dataset'));
    expect(firing(results)).toEqual([]);
    hourly[1].closed = true; // Still closes after all evaluations in this test.
    const another = new SignalMachine();
    expect(firing(rows.map(row => another.step(definition, { at: row.closeTime, series: { '5m': rows, '1h': hourly } }, 'dataset')))).toEqual([]);
  });
  it('fetches every trigger/confirmation/reset/final period and budgets past evaluations', () => {
    const definition = chain({ reset: condition({ left: { ...condition().left, timeframe: '15m' } }),
      completion: condition({ left: { ...condition().left, field: 'ema', timeframe: '1h', period: 30 } }) });
    expect(requiredTimeframes(definition).sort()).toEqual(['15m', '1h', '5m'].sort());
    const budget = historyRequirements(definition);
    expect(budget['5m']).toBeGreaterThanOrEqual(6); expect(budget['1h']).toBe(53);
  });
  it('cancels latched facts when a new gap is discovered on a non-anchor timeframe', () => {
    const definition = chain({ confirmations: [
      { id: 'hour', name: 'Час', policy: 'latch', expression: condition({ left: { ...condition().left, timeframe: '1h' } }) },
      { id: 'volume', name: 'Объём', policy: 'latch', expression: volume },
    ], timeoutBars: 20 });
    const rows = input(Array.from({ length: 15 }, (_, i) => i === 0 ? 1 : 3));
    const hourly = [...bars([3], '1h'), ...bars([4], '1h', 2 * 3600000)];
    // Continuous 5m anchors around the new hourly successor at 03:00; 02:00 is absent.
    rows.forEach(c => { c.openTime += 2 * 3600000; c.closeTime += 2 * 3600000; });
    rows[11].volume = '20';
    const machine = new SignalMachine();
    const result = rows.map(row => machine.step(definition, { at: row.closeTime, series: { '5m': rows, '1h': hourly } }, 'dataset'));
    expect(result[1].progress?.confirmed).toBe(1);
    expect(result[11]).toMatchObject({ fire: false, state: 'gap' });
  });
  it('full-history replay, prefixes and simultaneous independent chains produce identical events', () => {
    const definition = chain(), rows = input([1, 3, 4, 1, 3, 4], [0, 20, 0, 0, 20], [0, 0, 20, 0, 0, 20]);
    const solo = run(definition, rows), prefix = new SignalMachine(), joint = new SignalMachine(), other = new SignalMachine();
    rows.forEach((row, i) => {
      const context = { at: row.closeTime, series: { '5m': rows } };
      other.step(chain({ match: 'any' }, { id: 'other' }), context, 'dataset');
      expect(joint.step(definition, context, 'dataset')).toEqual(solo[i]);
      expect(prefix.step(definition, { ...context, series: { '5m': rows.slice(0, i + 1) } }, 'dataset')).toEqual(solo[i]);
    });
    expect(firing(solo)).toEqual([2, 5]);
  });
  it('keeps old single-tree signals compatible and validates temporal limits', () => {
    expect(signalSchema.parse(signal())).toEqual(signal());
    expect(signalSchema.parse(chain()).temporal?.mode).toBe('parallel');
    const duplicate = chain(); duplicate.temporal!.confirmations[1].id = 'a';
    expect(signalSchema.safeParse(duplicate).success).toBe(false);
    expect(signalSchema.safeParse(chain({ mode: 'sequential', match: 'any' })).success).toBe(false);
    expect(signalSchema.safeParse(chain({ timeoutBars: -1 })).success).toBe(false);
    expect(signalSchema.safeParse(chain({ confirmations: [] })).success).toBe(false);
    expect(signalSchema.safeParse(chain({ timeoutBars: 10000 }, { timeframe: '1d' })).success).toBe(false);
  });
});
