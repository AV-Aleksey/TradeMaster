import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.local/screenshots', { recursive: true });
const directory = mkdtempSync(resolve('.local/smoke-'));
const environment = { ...process.env, TRADEMASTER_DATA_DIR: directory, TRADEMASTER_REPLAY_ONLY: '1', ITICK_TOKEN: '' };
delete environment.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ args: ['.'], cwd: process.cwd(), timeout: 30000, env: environment });
let application;
try {
  application = await launch();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="candle-chart"] canvas'));
  const initial = await page.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.equal(initial.settings.monitoring, false);
  assert.equal(initial.pairs[0].source, 'replay');
  await page.waitForFunction(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data.candles.length > 0);
  await page.screenshot({ path: '.local/screenshots/terminal.png' });
  await page.getByRole('button', { name: 'Создать сигнал', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Проверка UI');
  await page.screenshot({ path: '.local/screenshots/editor.png' });
  await page.getByRole('button', { name: 'Сохранить сигнал', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
  await page.getByRole('switch', { name: 'Включить Проверка UI', exact: true }).click();
  await page.getByRole('switch', { name: 'Общий мониторинг', exact: true }).click();
  await page.waitForFunction(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data.settings.monitoring);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByText('Ключ не задан', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
  await page.getByRole('button', { name: 'Добавить пару', exact: true }).click();
  await page.getByLabel('Код пары', { exact: true }).fill('GBPUSD');
  await page.getByLabel('Название', { exact: true }).fill('Фунт / доллар');
  await page.getByRole('button', { name: 'Добавить пару', exact: true }).last().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
  await page.waitForFunction(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data.pairs.length === 2);
  await application.close();
  application = await launch();
  const reopened = await application.firstWindow();
  await reopened.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor({ timeout: 30000 });
  const restored = await reopened.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.equal(restored.pairs.length, 2);
  assert.equal(restored.signals.length, 2);
  assert.equal(restored.settings.monitoring, false);
  assert.equal(restored.signals.find(s => s.name === 'Проверка UI').enabled, true);
  await reopened.screenshot({ path: '.local/screenshots/restored.png' });
  console.log('PASS: Electron window, sandbox preload, SQLite worker, candle canvas, editor save, toggles, settings, pair creation and restart persistence');
} catch (error) {
  if (application) {
    const windows = application.windows();
    if (windows[0]) {
      console.error('Visible page:', (await windows[0].locator('body').innerText()).slice(0, 1600));
      await windows[0].screenshot({ path: '.local/screenshots/failure.png' }).catch(() => {});
    }
  }
  throw error;
} finally { await application?.close().catch(() => {}); }
