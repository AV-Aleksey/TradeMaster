import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { configurationMaxBytes, decodeConfiguration, parseConfiguration, type ConfigurationTransfer, type ImportMode, type TransferScope } from '../shared/configuration';
import type { CommandResult } from '../shared/model';

export interface ConfigurationDialogs {
  save(defaultPath: string): Promise<string | undefined>;
  open(): Promise<string | undefined>;
}
/** Native dialogs own paths. Renderer receives a short-lived preview handle, never arbitrary file access. */
export class ConfigurationFiles {
  private staged?: { id: string; configuration: ConfigurationTransfer; expiresAt: number };
  constructor(private readonly dialogs: ConfigurationDialogs,
    private readonly exportData: (scope: TransferScope, signalIds?: string[]) => Promise<CommandResult>,
    private readonly applyData: (configuration: ConfigurationTransfer, mode: ImportMode) => Promise<CommandResult>) {}
  async export(scope: TransferScope, signalIds?: string[]): Promise<CommandResult> {
    const result = await this.exportData(scope, signalIds);
    if (!result.ok) return result;
    const configuration = parseConfiguration(result.data);
    const serialized = JSON.stringify(configuration, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > configurationMaxBytes) throw new Error('Экспорт превышает 5 МБ. Экспортируйте сигналы отдельно');
    const path = await this.dialogs.save(`TradeMaster-${scope}-${new Date().toISOString().slice(0, 10)}.json`);
    if (!path) return { ok: true, data: { canceled: true } };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
    catch { await unlink(temporary).catch(() => {}); throw new Error('Не удалось сохранить файл экспорта'); }
    return { ok: true, data: { fileName: basename(path) } };
  }
  async preview(): Promise<CommandResult> {
    this.staged = undefined;
    const path = await this.dialogs.open();
    if (!path) return { ok: true, data: { canceled: true } };
    let text: string;
    try {
      const file = await open(path, 'r');
      try {
        if (!(await file.stat()).isFile()) throw new Error('not a file');
        // Fixed buffer also bounds reads if the selected file grows after stat().
        const buffer = Buffer.alloc(configurationMaxBytes + 1);
        let size = 0;
        while (size < buffer.length) { const { bytesRead } = await file.read(buffer, size, buffer.length - size, null); if (!bytesRead) break; size += bytesRead; }
        if (size > configurationMaxBytes) throw new Error('too large');
        text = buffer.subarray(0, size).toString('utf8');
      } finally { await file.close(); }
    } catch { throw new Error('Не удалось прочитать файл. Выберите JSON-файл размером до 5 МБ'); }
    const configuration = decodeConfiguration(text);
    const id = randomUUID();
    this.staged = { id, configuration, expiresAt: Date.now() + 10 * 60000 };
    return { ok: true, data: { importId: id, pairs: configuration.pairs.length, signals: configuration.signals?.length ?? 0,
      hasSignals: Boolean(configuration.signals), hasSettings: Boolean(configuration.settings), sources: [...new Set(configuration.pairs.map(pair => pair.source))], fileName: basename(path) } };
  }
  async apply(id: string, mode: ImportMode): Promise<CommandResult> {
    const staged = this.staged;
    if (!staged || staged.id !== id || staged.expiresAt < Date.now()) throw new Error('Предпросмотр устарел. Выберите файл заново');
    const result = await this.applyData(staged.configuration, mode);
    if (result.ok && this.staged === staged) this.staged = undefined;
    return result;
  }
  cancel(id: string): CommandResult { if (this.staged?.id === id) this.staged = undefined; return { ok: true }; }
}
