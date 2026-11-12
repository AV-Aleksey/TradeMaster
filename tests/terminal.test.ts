import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalService, seedData, type Store } from '../src/service/terminal';
import type { DataProvider } from '../src/providers/contracts';
import type { Candle, SavedData, SignalEvent, Timeframe } from '../src/shared/model';
import { bars, condition, signal } from './fixtures';

class MemoryStore implements Store {
  saved: SavedData;
  all: SignalEvent[] = [];
  notificationTargets = new Map<string, string>();
  closed = false;
  constructor() { this.saved = seedData(); this.saved.signals = [signal()]; }
  load(): SavedData { return structuredClone(this.saved); }
  save(data: SavedData): void { if (this.closed) throw new Error('closed store'); this.saved = structuredClone(data); }
  events(): SignalEvent[] { if (this.closed) throw new Error('closed store'); return structuredClone(this.all); }
  addEvent(event: SignalEvent, target?: string): boolean {
    if (this.closed) throw new Error('closed store');
    if (this.all.some(e => e.id === event.id)) return false;
    this.all.push(structuredClone(event)); if (target) this.notificationTargets.set(event.id, target); return true;
  }
}
class ManualProvider implements DataProvider {
  id = 'replay'; name = 'Manual';
  capabilities = { nativeTimeframes: ['5m', '1h'] as Timeframe[], volume: 'unavailable' as const, stream: false, calendar: 'demo-24h' as const };
  input: Candle[] = bars([1]);
  requested: number[] = [];
  deferred?: Promise<Candle[]>;
  async history(_instrument: unknown, _tf: Timeframe, limit: number): Promise<Candle[]> { this.requested.push(limit); return this.deferred ?? structuredClone(this.input); }
  async search() { return []; }
  now(): number { return this.input.at(-1)!.closeTime; }
  close(): void {}
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const pendingChain = () => signal({ temporal: { mode: 'parallel', match: 'all', timeoutBars: 3, nextBar: false, retrigger: 'ignore', confirmations: [
  { id: 'high', name: 'Вершина', policy: 'latch', expression: condition({ left: { ...condition().left, field: 'high' }, right: { kind: 'constant', value: '10' } }) },
  { id: 'volume', name: 'Объём', policy: 'latch', expression: condition({ left: { ...condition().left, field: 'volume' }, right: { kind: 'constant', value: '15' } }) },
] } });

describe('terminal lifecycle and complete signal processing', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2000000); });
  afterEach(() => vi.useRealTimers());
  function setup() {
    const store = new MemoryStore(), provider = new ManualProvider();
    const emit = vi.fn();
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, emit);
    return { store, provider, terminal, emit };
  }
  async function enable(terminal: TerminalService): Promise<void> {
    expect(await terminal.command({ type: 'setMonitoring', enabled: true })).toEqual({ ok: true });
    await flush();
  }
  async function tick(terminal: TerminalService): Promise<void> { vi.setSystemTime(Date.now() + 2000); await terminal.refresh(); }

  it('processes every missed closed anchor rather than latest only', async () => {
    const { store, provider, terminal } = setup();
    await enable(terminal);
    provider.input = bars([1, 3, 1, 4, 1]);
    await tick(terminal);
    expect(store.all.map(e => e.at)).toEqual([600000, 1200000]);
    await tick(terminal);
    expect(store.all).toHaveLength(2);
    terminal.close();
  });
  it('queues named monitoring start, actual firing and stop as distinct events without duplicates', async () => {
    const store = new MemoryStore(), provider = new ManualProvider(); store.saved.settings.telegramEnabled = true;
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {}, 'replay', () => 'telegram-target');
    await enable(terminal); await terminal.command({ type: 'setMonitoring', enabled: true }); await flush();
    expect(store.all.map(e => e.kind)).toEqual(['monitoring-started']);
    provider.input = bars([1, 3]); await tick(terminal);
    expect(store.all.map(e => e.kind ?? 'signal')).toEqual(['monitoring-started', 'signal']);
    await terminal.command({ type: 'toggleSignal', id: 's', enabled: false }); await flush();
    await terminal.command({ type: 'toggleSignal', id: 's', enabled: false }); await flush();
    expect(store.all.map(e => e.kind ?? 'signal')).toEqual(['monitoring-started', 'signal', 'monitoring-stopped']);
    expect(store.all.every(e => e.signalName === 'Test')).toBe(true);
    expect([...store.notificationTargets.values()]).toEqual(['telegram-target', 'telegram-target', 'telegram-target']); terminal.close();
  });
  it('global pause notifies only effectively monitored signals, and close records a final stop', async () => {
    const store = new MemoryStore(), provider = new ManualProvider(); store.saved.settings.telegramEnabled = true;
    store.saved.signals.push(signal({ id: 'other', name: 'Other' }), signal({ id: 'off', enabled: false }));
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {}, 'replay', () => 'target');
    await enable(terminal); await terminal.command({ type: 'setMonitoring', enabled: false }); await flush();
    expect(store.all.filter(e => e.kind === 'monitoring-started').map(e => e.signalId)).toEqual(['s', 'other']);
    expect(store.all.filter(e => e.kind === 'monitoring-stopped').map(e => e.signalId)).toEqual(['s', 'other']);
    await enable(terminal); terminal.close(); terminal.close();
    expect(store.all.filter(e => e.kind === 'monitoring-stopped')).toHaveLength(4);
  });
  it('a Telegram test uses the same queue without enabling monitoring or creating a market signal', async () => {
    const store = new MemoryStore(), provider = new ManualProvider();
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {}, 'replay', () => 'target');
    expect((await terminal.command({ type: 'testTelegram' })).ok).toBe(true);
    expect(store.all).toHaveLength(1); expect(store.all[0].kind).toBe('test');
    expect(terminal.snapshot().settings.monitoring).toBe(false); terminal.close();
  });
  it('completes a temporal chain through shared data loading and stores its trigger and facts once', async () => {
    const { store, provider, terminal } = setup();
    const definition = pendingChain();
    definition.temporal!.outcomes = [{ id: 'strong', label: 'Подтверждён', expression: condition({ left: { ...condition().left, field: 'volume' }, right: { kind: 'constant', value: '15' } }) }];
    definition.temporal!.defaultOutcome = 'Ранний'; definition.temporal!.unknownOutcome = 'Недостаточно данных';
    await terminal.command({ type: 'saveSignal', signal: definition }); await flush();
    await enable(terminal);
    provider.input = bars([1, 3]); provider.input[1].high = '20'; await tick(terminal);
    expect(store.all).toHaveLength(0);
    expect(terminal.snapshot().statuses[0].state).toContain('1/2');
    await tick(terminal); expect(terminal.snapshot().statuses[0].state).toContain('1/2');
    provider.input = bars([1, 3, 4]); provider.input[1].high = '20'; provider.input[2].volume = '20'; await tick(terminal);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]).toMatchObject({ triggeredAt: 600000, at: 900000, category: 'Подтверждён', explanation: { result: 'true' } });
    await tick(terminal); expect(store.all).toHaveLength(1); terminal.close();
  });
  it('explicit pause cancels pending temporal facts instead of finishing them on resume', async () => {
    const { store, provider, terminal } = setup();
    await terminal.command({ type: 'saveSignal', signal: pendingChain() }); await flush();
    await enable(terminal);
    provider.input = bars([1, 3]); provider.input[1].high = '20'; await tick(terminal);
    await terminal.command({ type: 'setMonitoring', enabled: false }); await flush();
    provider.input = bars([1, 3, 4]); provider.input[2].volume = '20'; await tick(terminal);
    await enable(terminal);
    provider.input = bars([1, 3, 4, 5]); provider.input[3].volume = '20'; await tick(terminal);
    expect(store.all).toHaveLength(0); terminal.close();
  });
  it('does not remain stuck on a missing confirmation bar after its closed successor arrives', async () => {
    const store = new MemoryStore();
    const definition = pendingChain(); definition.timeframe = '1m'; definition.temporal!.timeoutBars = 20;
    definition.expression = condition({ left: { ...condition().left, timeframe: '1m' } });
    definition.temporal!.confirmations = [{ id: 'five', name: '5m', policy: 'latch', expression: condition() }];
    store.saved.signals = [definition];
    class MixedProvider extends ManualProvider {
      override capabilities = { nativeTimeframes: ['1m', '5m'] as Timeframe[], volume: 'unavailable' as const, stream: false, calendar: 'demo-24h' as const };
      anchors = bars([1], '1m');
      five = bars([1], '5m', -300000); // closed at 0; the closure at 5m will be missing.
      override async history(_instrument: unknown, tf: Timeframe, _limit: number): Promise<Candle[]> {
        return structuredClone(tf === '1m' ? this.anchors : this.five);
      }
      override now(): number { return this.anchors.at(-1)!.closeTime; }
    }
    const provider = new MixedProvider();
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {});
    await enable(terminal);
    provider.anchors = bars([1, 3, 3, 3, 3, 3, 3, 3, 3, 3], '1m'); await tick(terminal);
    expect(terminal.snapshot().statuses[0].state).toContain('синхронизация');
    provider.five.push(...bars([4], '5m', 300000)); // successor closed at 10m proves missing 5m.
    await tick(terminal);
    expect(terminal.snapshot().statuses[0].checkedAt).toBe(600000);
    expect(terminal.snapshot().statuses[0].state).toContain('Разрыв');
    expect(store.all).toHaveLength(0);
    // A fresh trigger must work after the gap, without carrying old pending facts.
    provider.anchors = bars([1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 3], '1m'); await tick(terminal);
    expect(store.all.map(event => event.at)).toEqual([720000]); terminal.close();
  });
  it('primes an already-true condition without creating a false rising edge', async () => {
    const { store, provider, terminal } = setup(); provider.input = bars([3]);
    await enable(terminal);
    provider.input = bars([3, 3]); await tick(terminal);
    expect(store.all).toHaveLength(0);
    provider.input = bars([3, 3, 1, 3]); await tick(terminal);
    expect(store.all).toHaveLength(1);
    terminal.close();
  });
  it('global pause preserves individual switches and does not replay paused history', async () => {
    const { store, provider, terminal } = setup();
    await enable(terminal);
    await terminal.command({ type: 'setMonitoring', enabled: false }); await flush();
    expect(terminal.snapshot().signals[0].enabled).toBe(true);
    provider.input = bars([1, 3, 1, 3]); await tick(terminal);
    await enable(terminal);
    expect(store.all).toHaveLength(0);
    provider.input = bars([1, 3, 1, 3, 1, 3]); await tick(terminal);
    expect(store.all.map(e => e.at)).toEqual([1800000]);
    terminal.close();
  });
  it('two enabled signals run independently, and disabling one leaves the other active', async () => {
    const store = new MemoryStore(), provider = new ManualProvider();
    store.saved.signals.push(signal({ id: 'other', name: 'other' }));
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {});
    await enable(terminal);
    await terminal.command({ type: 'toggleSignal', id: 's', enabled: false }); await flush();
    provider.input = bars([1, 3]); await tick(terminal);
    expect(store.all.map(e => e.signalId)).toEqual(['other']); terminal.close();
  });
  it('closing while a request is pending never broadcasts from the disposed store', async () => {
    const { store, provider, terminal, emit } = setup();
    let resolve!: (value: Candle[]) => void;
    provider.deferred = new Promise<Candle[]>(r => { resolve = r; });
    const pending = terminal.refresh();
    terminal.close(); store.closed = true; const before = emit.mock.calls.length;
    resolve(bars([1, 3])); await expect(pending).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(before);
  });
  it('new source appears without changes to the signal model and resets its evaluation baseline', async () => {
    const { store, provider, terminal } = setup();
    const third = new ManualProvider(); third.id = 'third-rest'; third.input = bars([1, 3]);
    // Separate instance uses the same interface, including no catalog/volume/stream.
    const withThird = new TerminalService(store, new Map([[provider.id, provider], [third.id, third]]), () => true, () => {});
    await enable(withThird);
    expect((await withThird.command({ type: 'switchSource', pairId: 'eurusd', source: third.id })).ok).toBe(true);
    await flush();
    expect(withThird.snapshot().signals[0].enabled).toBe(true);
    expect(withThird.snapshot().providers.some(p => p.id === third.id)).toBe(true);
    expect(store.all).toHaveLength(0);
    terminal.close(); withThird.close();
  });
  it('requests enough history for a supported long-period configuration', async () => {
    const store = new MemoryStore(), provider = new ManualProvider();
    store.saved.signals = [signal({ expression: condition({ left: { kind: 'series', field: 'sma', timeframe: '5m', period: 500, offset: 100, factor: '1' } }) })];
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {});
    await enable(terminal);
    expect(Math.max(...provider.requested)).toBeGreaterThanOrEqual(602);
    terminal.close();
  });
});

describe('Finam instrument identity at terminal boundary', () => {
  function setupFinam() {
    const replay = new ManualProvider(), store = new MemoryStore();
    const search = vi.fn(async () => [{ code: 'EUR/USD', region: '_NPRO', name: 'EUR/USD' }]);
    const finam: DataProvider = { id: 'finam', name: 'Finam', capabilities: replay.capabilities,
      search, history: async () => bars([1]), now: Date.now, close: () => {} };
    const terminal = new TerminalService(store, new Map<string, DataProvider>([['replay', replay], ['finam', finam]]), () => true, () => {});
    return { terminal, store, search };
  }
  it('adds a confirmed Finam ticker with its actual MIC and prevents unsafe source remapping', async () => {
    const { terminal, store, search } = setupFinam();
    const result = await terminal.command({ type: 'addPair', source: 'finam', code: 'EUR/USD', region: '_NPRO', name: 'Euro Dollar' });
    expect(result.ok).toBe(true); expect(search).toHaveBeenCalledWith('EUR/USD@_NPRO');
    const pair = store.saved.pairs.find(p => p.source === 'finam')!;
    expect(pair).toMatchObject({ code: 'EUR/USD', region: '_NPRO' });
    expect((await terminal.command({ type: 'switchSource', pairId: pair.id, source: 'replay' })).ok).toBe(false);
    expect((await terminal.command({ type: 'switchSource', pairId: store.saved.pairs[0].id, source: 'finam' })).ok).toBe(false);
    terminal.close();
  });
  it('rejects unconfirmed Finam tickers and preserves the GB-only contract of other providers', async () => {
    const { terminal, store } = setupFinam();
    expect((await terminal.command({ type: 'addPair', source: 'finam', code: 'SBER', region: 'MISX', name: 'Sberbank' })).ok).toBe(false);
    expect((await terminal.command({ type: 'addPair', source: 'replay', code: 'EURUSD', region: '_NPRO', name: 'Euro Dollar' })).ok).toBe(false);
    expect(store.saved.pairs).toHaveLength(1); terminal.close();
  });
});

describe('configuration import lifecycle', () => {
  it('persists before publishing, pauses monitoring, disables imported signals and keeps event history', async () => {
    const store = new MemoryStore(), provider = new ManualProvider();
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {});
    store.all.push({ id: 'old-event', signalId: 's', signalName: 'Test', revision: 1, pairId: 'eurusd', code: 'EURUSD', source: 'replay',
      at: 1, createdAt: 1, price: '1', explanation: { id: 'r', result: 'true', label: 'Stored event' } });
    const exported = await terminal.command({ type: 'exportConfiguration', scope: 'all' });
    if (!exported.ok) throw new Error(exported.error);
    await terminal.command({ type: 'setMonitoring', enabled: true });
    await flush();
    expect(terminal.importConfiguration(exported.data, 'replace').ok).toBe(true);
    const state = terminal.snapshot();
    expect(state.settings.monitoring).toBe(false); expect(state.settings.telegramEnabled).toBe(false);
    expect(state.signals.every(s => !s.enabled)).toBe(true);
    expect(state.signals[0].id).not.toBe('s'); expect(state.signals[0].pairId).toBe(state.pairs[0].id);
    expect(store.saved.signals).toEqual(state.signals); expect(store.all.some(event => event.id === 'old-event')).toBe(true);
    terminal.close();
  });
  it('keeps current settings, signals and runtime unchanged when validation or persistence fails', async () => {
    const store = new MemoryStore(), provider = new ManualProvider();
    const terminal = new TerminalService(store, new Map([[provider.id, provider]]), () => true, () => {});
    const before = terminal.snapshot();
    const exported = await terminal.command({ type: 'exportConfiguration', scope: 'all' });
    if (!exported.ok) throw new Error(exported.error);
    expect(terminal.importConfiguration({ version: 99 }, 'replace').ok).toBe(false);
    const badSource = structuredClone(exported.data) as { pairs: Array<{ source: string }> }; badSource.pairs[0].source = 'unknown-provider';
    expect(terminal.importConfiguration(badSource, 'replace').ok).toBe(false);
    const save = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(terminal.importConfiguration(exported.data, 'replace')).toEqual({ ok: false, error: 'disk full' });
    const after = terminal.snapshot();
    expect(after.pairs).toEqual(before.pairs); expect(after.signals).toEqual(before.signals); expect(after.settings).toEqual(before.settings);
    save.mockRestore(); terminal.close();
  });
});
