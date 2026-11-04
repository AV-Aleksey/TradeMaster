import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
mkdirSync('.local/screenshots', { recursive: true });
const directory = mkdtempSync(resolve('.local/readme-'));
const request = join(directory, 'pending-readme-presets.json');
writeFileSync(request, JSON.stringify({ type: 'createReadmeSignals', pairId: 'eurusd' }));
const env = { ...process.env, TRADEMASTER_REPLAY_ONLY: '1', TRADEMASTER_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
let application = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const errors = [];
try {
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data?.signals.filter(s => s.name.startsWith('README')).length === 2);
  const read = () => page.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  const before = (await read()).signals.filter(s => s.name.startsWith('README'));
  assert.ok(before.every(s => !s.enabled && s.timeframe === '5m'));
  assert.equal(existsSync(request), false);
  await page.getByRole('button', { name: 'Добавить сигналы из README', exact: true }).click();
  assert.equal((await read()).signals.filter(s => s.name.startsWith('README')).length, 2);
  for (const name of ['README · Разворот вверх', 'README · Разворот вниз']) {
    const card = page.locator('.signal-card').filter({ hasText: name });
    await card.getByRole('button', { name: 'edit', exact: true }).click();
    await page.getByLabel('Название подтверждения 1', { exact: true }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Использовать итоговые метки', exact: true }).isChecked(), true);
    const starts = page.getByRole('spinbutton', { name: 'Начало окна', exact: true });
    assert.equal(await starts.count(), 2);
    for (const start of await starts.all()) assert.equal(await start.inputValue(), '-3');
    if (name.endsWith('вверх')) await page.screenshot({ path: '.local/screenshots/readme-signal.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Сохранить сигнал', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const after = (await read()).signals.filter(s => s.name.startsWith('README'));
  for (const previous of before) {
    const current = after.find(s => s.id === previous.id);
    assert.deepEqual(current.expression, previous.expression);
    assert.deepEqual(current.temporal, previous.temporal);
  }
  await application.close();
  application = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const restoredPage = await application.firstWindow();
  await restoredPage.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor();
  const restored = await restoredPage.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.equal(restored.signals.filter(s => s.name.startsWith('README')).length, 2);
  assert.equal(restored.settings.monitoring, false);
  assert.deepEqual(errors, []);
  console.log('PASS: queued creation, both disabled README signals, idempotency, editable windows/outcomes, exact save round-trip and SQLite restart');
} catch (error) {
  const page = (await application.windows())[0];
  if (page) { console.error((await page.locator('body').innerText()).slice(-12000)); await page.screenshot({ path: '.local/screenshots/readme-failure.png' }).catch(() => {}); }
  console.error('Renderer errors:', JSON.stringify(errors)); throw error;
} finally { await application.close().catch(() => {}); }
