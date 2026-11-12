import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
mkdirSync('.local', { recursive: true });
const directory = mkdtempSync(resolve('.local/configuration-smoke-'));
const exportPath = join(directory, 'configuration.json');
const env = { ...process.env, TRADEMASTER_DATA_DIR: directory, TRADEMASTER_REPLAY_ONLY: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const launch = () => electron.launch({ args: ['.'], cwd: process.cwd(), timeout: 30000, env });
try {
  application = await launch();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.getByRole('button', { name: 'Настройки', exact: true }).waitFor({ timeout: 30000 });
  const read = () => page.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  const initial = await read();
  // Replace only OS dialogs, keeping the actual IPC, filesystem, worker, SQLite and UI intact.
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, exportPath);
  await page.getByRole('button', { name: 'Настройки', exact: true }).dispatchEvent('click');
  const settings = page.getByRole('dialog', { name: /Настройки/ });
  await settings.getByRole('button', { name: 'Экспортировать', exact: true }).dispatchEvent('click');
  await page.getByText('Файл экспорта сохранён', { exact: true }).waitFor();
  const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
  assert.equal(exported.format, 'trademaster-configuration');
  assert.equal(exported.signals.length, initial.signals.length);
  assert.equal(exported.settings.monitoring, undefined);
  assert.equal(exported.settings.telegramEnabled, undefined);
  await page.evaluate(async id => {
    await window.trademaster.invoke({ type: 'setSoundSettings', enabled: false, volume: 13 });
    await window.trademaster.invoke({ type: 'deleteSignal', id });
  }, initial.signals[0].id);
  await settings.getByRole('button', { name: 'Импортировать из файла', exact: true }).dispatchEvent('click');
  const preview = page.getByRole('dialog', { name: 'Импорт сигналов и настроек', exact: true });
  await preview.waitFor();
  assert.equal((await read()).signals.length, initial.signals.length - 1);
  await preview.getByLabel('Режим импорта', { exact: true }).dispatchEvent('mousedown');
  await page.locator('.ant-select-item-option-content').filter({ hasText: 'Заменить все пары, сигналы и настройки' }).dispatchEvent('click');
  await preview.getByText('Текущие сигналы будут заменены', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Импортировать', exact: true }).dispatchEvent('click');
  await preview.waitFor({ state: 'hidden' });
  const restored = await read();
  assert.equal(restored.signals.length, initial.signals.length);
  assert.ok(restored.signals.every(s => !s.enabled && restored.pairs.some(p => p.id === s.pairId)));
  assert.equal(restored.settings.monitoring, false); assert.equal(restored.settings.telegramEnabled, false);
  assert.equal(restored.settings.soundVolume, initial.settings.soundVolume);
  assert.equal(restored.settings.soundEnabled, initial.settings.soundEnabled);
  assert.deepEqual(restored.signals.map(s => s.expression), initial.signals.map(s => s.expression));
  writeFileSync(exportPath, '{"version":999}');
  await settings.getByRole('button', { name: 'Импортировать из файла', exact: true }).dispatchEvent('click');
  await settings.getByText(/Некорректный файл TradeMaster/).waitFor();
  assert.deepEqual((await read()).signals, restored.signals);
  await settings.getByRole('button', { name: 'Закрыть', exact: true }).last().dispatchEvent('click');
  await page.getByRole('button', { name: `Экспортировать ${restored.signals[0].name}`, exact: true }).dispatchEvent('click');
  await page.getByText('Сигнал экспортирован', { exact: true }).waitFor();
  const single = JSON.parse(readFileSync(exportPath, 'utf8'));
  assert.equal(single.signals.length, 1); assert.equal(single.settings, undefined);
  await application.close(); application = await launch();
  const reopened = await application.firstWindow();
  await reopened.getByRole('button', { name: 'Настройки', exact: true }).waitFor({ timeout: 30000 });
  const persisted = await reopened.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.deepEqual(persisted.signals, restored.signals);
  assert.equal(persisted.settings.soundVolume, initial.settings.soundVolume);
  console.log('PASS: configuration and individual signal export, preview-confirm replacement, invalid file rejection, safe activation flags and restart persistence through real Electron/SQLite');
} catch (error) {
  const current = application?.windows()[0];
  if (current) { console.error((await current.locator('body').innerText()).slice(-4500)); await current.screenshot({ path: '.local/configuration-failure.png' }); }
  throw error;
} finally {
  await application?.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
