import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationFiles } from '../src/service/configuration-files';
import { createConfiguration } from '../src/shared/configuration';
import { seedData } from '../src/service/terminal';
const directories: string[] = [];
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'trademaster-transfer-')); directories.push(path); return path; };
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('native file import/export boundary', () => {
  it('writes and reads a real JSON file, previews before applying, and consumes the preview after success', async () => {
    const path = join(await directory(), 'backup.json'), configuration = createConfiguration(seedData(), 'all');
    const apply = vi.fn(async () => ({ ok: true as const }));
    const files = new ConfigurationFiles({ save: async () => path, open: async () => path }, async () => ({ ok: true, data: configuration }), apply);
    expect((await files.export('all')).ok).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(configuration);
    const result = await files.preview(); expect(result.ok).toBe(true);
    const preview = (result as { data: { importId: string; signals: number } }).data;
    expect(preview.signals).toBe(configuration.signals!.length); expect(apply).not.toHaveBeenCalled();
    // File changes after preview do not change what the user approved.
    await writeFile(path, 'invalid JSON');
    expect((await files.apply(preview.importId, 'merge')).ok).toBe(true);
    expect(apply).toHaveBeenCalledWith(configuration, 'merge');
    await expect(files.apply(preview.importId, 'replace')).rejects.toThrow('устарел');
  });
  it('cancels native dialogs without applying anything', async () => {
    const apply = vi.fn(), files = new ConfigurationFiles({ save: async () => undefined, open: async () => undefined },
      async () => ({ ok: true, data: createConfiguration(seedData(), 'all') }), apply);
    expect(await files.export('all')).toMatchObject({ ok: true, data: { canceled: true } });
    expect(await files.preview()).toMatchObject({ ok: true, data: { canceled: true } }); expect(apply).not.toHaveBeenCalled();
  });
  it('rejects invalid and oversized files before staging an import', async () => {
    const path = join(await directory(), 'bad.json'), apply = vi.fn();
    const files = new ConfigurationFiles({ save: async () => path, open: async () => path }, async () => ({ ok: false, error: 'unused' }), apply);
    await writeFile(path, '{}'); await expect(files.preview()).rejects.toThrow('Некорректный');
    await writeFile(path, ' '.repeat(5 * 1024 * 1024 + 1)); await expect(files.preview()).rejects.toThrow('5 МБ');
    expect(apply).not.toHaveBeenCalled();
  });
  it('invalidates canceled and expired previews while allowing retry after a failed apply', async () => {
    const path = join(await directory(), 'backup.json');
    await writeFile(path, JSON.stringify(createConfiguration(seedData(), 'signals')));
    const apply = vi.fn(async () => ({ ok: false as const, error: 'store unavailable' }));
    const files = new ConfigurationFiles({ save: async () => undefined, open: async () => path }, async () => ({ ok: false, error: 'unused' }), apply);
    const result = await files.preview(), id = (result as { data: { importId: string } }).data.importId;
    expect((await files.apply(id, 'merge')).ok).toBe(false);
    expect((await files.apply(id, 'merge')).ok).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 11 * 60000);
    await expect(files.apply(id, 'merge')).rejects.toThrow('устарел');
    vi.useRealTimers(); const other = await files.preview(), otherId = (other as { data: { importId: string } }).data.importId;
    files.cancel(otherId); await expect(files.apply(otherId, 'merge')).rejects.toThrow('устарел');
  });
});
