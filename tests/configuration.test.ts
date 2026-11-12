import { describe, expect, it } from 'vitest';
import { createConfiguration, decodeConfiguration, parseConfiguration, prepareConfigurationImport } from '../src/shared/configuration';
import { seedData } from '../src/service/terminal';
import { condition, signal } from './fixtures';
import type { SavedData } from '../src/shared/model';

const fixture = (): SavedData => {
  const data = seedData('finam');
  data.pairs[0] = { id: 'forex', code: 'EURUSD', name: 'Евро / доллар', region: '#WWCP', source: 'finam' };
  data.signals = [signal({ pairId: 'forex', expression: { kind: 'group', id: 'root', combinator: 'and', rules: [signal().expression,
    condition({ id: 'decimal', right: { kind: 'constant', value: '1.00000000000000000001' } })] } })];
  data.settings = { monitoring: true, telegramEnabled: true, activePairId: 'forex', timeframe: '15m', soundEnabled: false, soundVolume: 37 };
  return data;
};
const ids = () => { let n = 0; return () => `new-${++n}`; };
describe('portable configuration', () => {
  it('round-trips nested signals, Decimal strings, MIC, sources and preferences', () => {
    const data = fixture(), exported = createConfiguration(data, 'all');
    const result = decodeConfiguration(JSON.stringify(exported));
    expect(result.signals).toEqual(data.signals); expect(result.pairs).toEqual(data.pairs);
    expect(result.settings).toEqual({ activePairId: 'forex', timeframe: '15m', soundEnabled: false, soundVolume: 37 });
    const restored = prepareConfigurationImport(seedData(), result, 'replace', ids());
    expect(restored.pairs[0]).toMatchObject({ code: 'EURUSD', region: '#WWCP', source: 'finam' });
    expect(restored.signals[0].pairId).toBe(restored.pairs[0].id);
    expect(restored.signals[0].expression).toEqual(data.signals[0].expression);
    expect(restored.signals[0].enabled).toBe(false);
    expect(restored.settings).toMatchObject({ monitoring: false, telegramEnabled: false, soundVolume: 37, activePairId: restored.pairs[0].id });
  });
  it('exports only explicit public configuration, including when passed a snapshot with credentials', () => {
    const data = Object.assign(fixture(), { telegramConnectionId: 'private-connection', token: 'private-token', events: ['private-event'], candles: ['private-price'] });
    Object.assign(data.settings, { token: 'settings-secret' });
    Object.assign(data.signals[0], { token: 'signal-secret' });
    Object.assign(data.pairs[0], { token: 'pair-secret' });
    const json = JSON.stringify(createConfiguration(data, 'all'));
    expect(json).not.toMatch(/private-|secret|token|monitoring|telegram/i);
  });
  it('exports an individual signal with only its dependent pair and no preferences', () => {
    const data = fixture(); data.pairs.push(...seedData().pairs);
    data.signals.push(signal({ id: 'other' }));
    const result = createConfiguration(data, 'signals', ['s']);
    expect(result.signals).toHaveLength(1); expect(result.pairs.map(p => p.id)).toEqual(['forex']); expect(result.settings).toBeUndefined();
    expect(() => createConfiguration(data, 'signals', ['missing'])).toThrow('удалён');
  });
  it('exports settings without signals and excludes activation flags', () => {
    const result = createConfiguration(fixture(), 'settings');
    expect(result.signals).toBeUndefined(); expect(result.settings).not.toHaveProperty('monitoring');
    expect(result.settings).not.toHaveProperty('telegramEnabled');
  });
  it('merges instruments by source, MIC and code, remaps IDs, and preserves existing signals', () => {
    const current = fixture(), backup = createConfiguration(current, 'all');
    const previous = structuredClone(current);
    const result = prepareConfigurationImport(current, backup, 'merge', ids());
    expect(result.pairs).toHaveLength(1); expect(result.signals).toHaveLength(2);
    expect(result.signals[0]).toEqual(current.signals[0]);
    expect(result.signals[1]).toMatchObject({ pairId: 'forex', enabled: false, name: 'Test · импорт' });
    expect(result.signals[1].id).not.toBe(result.signals[0].id);
    expect(current).toEqual(previous);
    const other = seedData(); other.pairs[0].code = 'EURUSD';
    expect(prepareConfigurationImport(other, backup, 'merge', ids()).pairs).toHaveLength(2);
  });
  it('settings-only import preserves signal definitions and pair links', () => {
    const current = fixture(), backup = createConfiguration(current, 'settings');
    backup.settings!.soundVolume = 0; backup.pairs[0].name = 'Новое имя';
    const result = prepareConfigurationImport(current, backup, 'merge', ids());
    expect(result.signals).toEqual(current.signals); expect(result.pairs[0].name).toBe('Новое имя');
    expect(result.settings.soundVolume).toBe(0);
    expect(() => prepareConfigurationImport(current, backup, 'replace', ids())).toThrow('без замены');
  });
  it('signal-only replacement keeps preferences and old pairs; complete empty replacement clears configuration', () => {
    const current = fixture(), backup = createConfiguration(seedData(), 'signals');
    const result = prepareConfigurationImport(current, backup, 'replace', ids());
    expect(result.pairs).toHaveLength(2); expect(result.signals).toHaveLength(backup.signals!.length);
    expect(result.settings.timeframe).toBe('15m'); expect(result.settings.activePairId).toBe('forex');
    const empty = createConfiguration({ pairs: [], signals: [], settings: { monitoring: false, activePairId: '', timeframe: '5m' } }, 'all');
    expect(prepareConfigurationImport(current, empty, 'replace', ids())).toMatchObject({ pairs: [], signals: [], settings: { activePairId: '', monitoring: false } });
  });
  it('rejects unknown versions, duplicate IDs, dangling references, invalid settings and malformed JSON', () => {
    const backup = createConfiguration(fixture(), 'all');
    const invalid = [ { ...backup, version: 2 }, { ...backup, pairs: [...backup.pairs, ...backup.pairs] },
      { ...backup, signals: [...backup.signals!, ...backup.signals!] }, { ...backup, pairs: [] },
      { ...backup, settings: { ...backup.settings, activePairId: 'absent' } },
      { ...backup, settings: { ...backup.settings, soundVolume: 101 } }, { ...backup, token: 'secret' } ];
    for (const value of invalid) expect(() => parseConfiguration(value)).toThrow('Некорректный');
    expect(() => decodeConfiguration('not json')).toThrow('JSON');
    expect(decodeConfiguration('\uFEFF' + JSON.stringify(backup))).toEqual(backup);
  });
  it('bounds deeply nested JSON before parsing the recursive schema and limits file bytes', () => {
    let value: unknown = {}; for (let i = 0; i < 100; i++) value = { nested: value };
    expect(() => parseConfiguration(value)).toThrow('вложенность');
    expect(() => decodeConfiguration(' '.repeat(5 * 1024 * 1024 + 1))).toThrow('5 МБ');
  });
});
