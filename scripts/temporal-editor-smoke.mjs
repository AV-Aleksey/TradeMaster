import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.local/screenshots', { recursive: true });
const directory = mkdtempSync(resolve('.local/temporal-'));
const environment = { ...process.env, TRADEMASTER_REPLAY_ONLY: '1', TRADEMASTER_DATA_DIR: directory };
delete environment.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ args: ['.'], cwd: process.cwd(), env: environment });
let application;
const errors = [];
async function choose(page, selector, text) {
  await selector.click();
  for (let n = 0; n < 250; n++) {
    const active = page.locator('.ant-select-item-option-active');
    if (await active.count() && await active.last().innerText() === text) { await active.last().click(); return; }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`Option not found: ${text}`);
}
try {
  application = await launch();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Создать сигнал', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Цепочка UI');
  await page.getByText('Цепочка подтверждений', { exact: true }).click();
  await choose(page, page.getByLabel('Проверять на закрытии', { exact: true }), '1m');
  const trigger = page.locator('.queryBuilder').first();
  await choose(page, trigger.locator('.rule-fields').first(), 'Закрытие · 1m');
  await choose(page, trigger.locator('.rule-operators').first(), '>');
  await choose(page, trigger.locator('.rule-valueSource').first(), 'Число');
  await trigger.locator('input.rule-value').fill('1000000');
  await page.getByLabel('Окно ожидания, свечей', { exact: true }).fill('4');
  await choose(page, page.getByLabel('Порядок подтверждений', { exact: true }), 'Последовательно');
  await choose(page, page.getByLabel('Повторный триггер', { exact: true }), 'Начать заново');
  await page.getByRole('switch', { name: 'Подтверждение не раньше следующей свечи', exact: true }).click();
  await page.getByLabel('Название подтверждения 1', { exact: true }).fill('Стохастик');
  await choose(page, page.getByLabel('Политика подтверждения 1', { exact: true }), 'Перепроверить при завершении');
  await page.getByRole('button', { name: 'Добавить подтверждение', exact: true }).click();
  await page.getByLabel('Название подтверждения 2', { exact: true }).fill('Второе условие');
  await page.getByRole('button', { name: 'Поднять подтверждение 2', exact: true }).click();
  await page.getByRole('switch', { name: 'Использовать условие сброса', exact: true }).click();
  await page.getByRole('switch', { name: 'Использовать итоговый фильтр', exact: true }).click();
  await page.screenshot({ path: '.local/screenshots/temporal-editor.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Сохранить сигнал', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const read = () => page.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  let saved = (await read()).signals.find(s => s.name === 'Цепочка UI');
  assert.ok(saved?.temporal);
  assert.equal(saved.timeframe, '1m'); assert.equal(saved.expression.rules[0].right.value, '1000000');
  assert.deepEqual({ mode: saved.temporal.mode, match: saved.temporal.match, timeoutBars: saved.temporal.timeoutBars, retrigger: saved.temporal.retrigger, nextBar: saved.temporal.nextBar },
    { mode: 'sequential', match: 'all', timeoutBars: 4, retrigger: 'replace', nextBar: true });
  assert.deepEqual(saved.temporal.confirmations.map(c => [c.name, c.policy]), [['Второе условие', 'latch'], ['Стохастик', 'recheck']]);
  assert.ok(saved.temporal.reset && saved.temporal.completion);
  const original = saved.temporal;
  const card = page.locator('.signal-card').filter({ hasText: 'Цепочка UI' });
  await card.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByLabel('Название подтверждения 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Сохранить сигнал', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  saved = (await read()).signals.find(s => s.name === 'Цепочка UI');
  assert.deepEqual(saved.temporal, original);
  await page.getByRole('switch', { name: 'Включить Цепочка UI', exact: true }).click();
  await page.getByRole('switch', { name: 'Общий мониторинг', exact: true }).click();
  await page.waitForFunction(async () => {
    const s = (await window.trademaster.invoke({ type: 'snapshot' })).data;
    const signal = s.signals.find(row => row.name === 'Цепочка UI');
    return s.statuses.some(row => row.signalId === signal.id && row.checkedAt && row.state.includes('Ожидание нового триггера'));
  }, undefined, { timeout: 20000 });
  await application.close();
  application = await launch();
  const reopened = await application.firstWindow();
  await reopened.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor();
  const restored = await reopened.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.equal(restored.settings.monitoring, false);
  assert.deepEqual(restored.signals.find(s => s.name === 'Цепочка UI').temporal, original);
  assert.deepEqual(errors, []);
  console.log('PASS: temporal UI configuration, reorder/policies/reset/filter, save/edit round-trip, engine closed-bar evaluation and SQLite restart');
} catch (error) {
  const page = application && (await application.windows())[0];
  if (page) { console.error((await page.locator('body').innerText()).slice(-10000)); await page.screenshot({ path: '.local/screenshots/temporal-failure.png' }).catch(() => {}); }
  console.error('Renderer errors:', JSON.stringify(errors)); throw error;
} finally { await application?.close().catch(() => {}); }
