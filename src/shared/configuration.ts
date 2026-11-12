import { z } from 'zod';
import { signalSchema, timeframes, type SavedData } from './model';

export type TransferScope = 'all' | 'signals' | 'settings';
export type ImportMode = 'merge' | 'replace';
export const configurationMaxBytes = 5 * 1024 * 1024;
const pairSchema = z.object({ id: z.string().min(1).max(80), code: z.string().regex(/^[^\s@\x00-\x1f]{1,64}$/),
  name: z.string().trim().min(1).max(100), region: z.string().regex(/^[A-Za-z0-9_#-]{1,16}$/), source: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict();
const preferencesSchema = z.object({ activePairId: z.string().max(80), timeframe: z.enum(timeframes),
  soundEnabled: z.boolean(), soundVolume: z.number().int().min(0).max(100) }).strict();
const transferSchema = z.object({ format: z.literal('trademaster-configuration'), version: z.literal(1),
  exportedAt: z.iso.datetime(), pairs: z.array(pairSchema).max(500), signals: z.array(signalSchema).max(1000).optional(),
  settings: preferencesSchema.optional() }).strict().superRefine((data, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!data.signals && !data.settings) issue('В файле нет сигналов или настроек');
  const pairIds = new Set(data.pairs.map(pair => pair.id));
  if (pairIds.size !== data.pairs.length) issue('Идентификаторы пар повторяются');
  if (new Set(data.pairs.map(pair => identity(pair))).size !== data.pairs.length) issue('Инструменты повторяются');
  if (new Set(data.signals?.map(signal => signal.id)).size !== (data.signals?.length ?? 0)) issue('Идентификаторы сигналов повторяются');
  if (data.signals?.some(signal => !pairIds.has(signal.pairId))) issue('Сигнал ссылается на отсутствующую пару');
  if (data.settings && (data.pairs.length ? !pairIds.has(data.settings.activePairId) : data.settings.activePairId !== '')) issue('Выбранная пара отсутствует');
});
export type ConfigurationTransfer = z.infer<typeof transferSchema>;
export interface ImportPreview { importId: string; pairs: number; signals: number; hasSignals: boolean; hasSettings: boolean; sources: string[] }
const identity = (pair: SavedData['pairs'][number]): string => JSON.stringify([pair.source, pair.region, pair.code]);

/** Bound traversal before the recursive AST schema sees untrusted JSON. */
export function parseConfiguration(value: unknown): ConfigurationTransfer {
  const stack = [{ value, depth: 0 }]; let count = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++count > 500000 || entry.depth > 40) throw new Error('Файл слишком сложный: сократите число сигналов или вложенность');
    if (entry.value && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
    }
  }
  const result = transferSchema.safeParse(value);
  if (!result.success) throw new Error('Некорректный файл TradeMaster: проверьте версию, сигналы и ссылки на пары');
  return result.data;
}
export function decodeConfiguration(text: string): ConfigurationTransfer {
  if (new TextEncoder().encode(text).length > configurationMaxBytes) throw new Error('Файл превышает 5 МБ');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Не удалось прочитать JSON-файл'); }
  return parseConfiguration(value);
}
export function createConfiguration(data: SavedData, scope: TransferScope, signalIds?: string[]): ConfigurationTransfer {
  if (signalIds && scope !== 'signals') throw new Error('Выбор отдельных сигналов доступен только для экспорта сигналов');
  if (signalIds?.some(id => !data.signals.some(signal => signal.id === id))) throw new Error('Один из выбранных сигналов уже удалён');
  const signals = scope === 'settings' ? undefined : data.signals.filter(signal => !signalIds || signalIds.includes(signal.id));
  const pairs = scope === 'signals' ? data.pairs.filter(pair => signals!.some(signal => signal.pairId === pair.id)) : data.pairs;
  return parseConfiguration({ format: 'trademaster-configuration', version: 1, exportedAt: new Date().toISOString(),
    pairs: pairs.map(({ id, code, name, region, source }) => ({ id, code, name, region, source })),
    ...(signals ? { signals } : {}), ...(scope !== 'signals' ? { settings: { activePairId: data.settings.activePairId,
      timeframe: data.settings.timeframe, soundEnabled: data.settings.soundEnabled ?? true, soundVolume: data.settings.soundVolume ?? 60 } } : {}) });
}
export function prepareConfigurationImport(current: SavedData, input: unknown, mode: ImportMode, newId: () => string): SavedData {
  const incoming = parseConfiguration(input);
  if (mode === 'replace' && !incoming.signals) throw new Error('Файл только с настройками применяется без замены сигналов');
  const replaceAll = mode === 'replace' && Boolean(incoming.settings);
  const pairs = replaceAll ? [] : structuredClone(current.pairs);
  const pairIds = new Map<string, string>();
  for (const pair of incoming.pairs) {
    let target = pairs.find(existing => identity(existing) === identity(pair));
    if (!target) { target = { ...pair, id: newId() }; pairs.push(target); }
    else if (incoming.settings) target.name = pair.name;
    pairIds.set(pair.id, target.id);
  }
  const signals = mode === 'replace' ? [] : structuredClone(current.signals);
  for (const signal of incoming.signals ?? []) {
    const pairId = pairIds.get(signal.pairId)!;
    const name = signals.some(existing => existing.pairId === pairId && existing.name === signal.name) ? `${signal.name.slice(0, 90)} · импорт` : signal.name;
    signals.push({ ...structuredClone(signal), id: newId(), pairId, name, enabled: false });
  }
  if (pairs.length > 500 || signals.length > 1000) throw new Error('После импорта допускается максимум 500 пар и 1000 сигналов');
  const settings = { ...current.settings, ...incoming.settings, activePairId: incoming.settings
    ? pairIds.get(incoming.settings.activePairId) ?? (replaceAll ? '' : current.settings.activePairId)
    : current.settings.activePairId, monitoring: false, telegramEnabled: false };
  if (!pairs.some(pair => pair.id === settings.activePairId)) settings.activePairId = pairs[0]?.id ?? '';
  return { pairs, signals, settings };
}
