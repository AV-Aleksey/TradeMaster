import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.local/screenshots', { recursive: true });
const environment = { ...process.env, TRADEMASTER_REPLAY_ONLY: '1', TRADEMASTER_DATA_DIR: mkdtempSync(resolve('.local/editor-')) };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: ['.'], cwd: process.cwd(), env: environment });
const errors = [];
async function choose(page, selector, text) {
  await selector.click();
  for (let attempt = 0; attempt < 250; attempt++) {
    const option = page.locator('.ant-select-item-option-active');
    if (await option.count() && (await option.last().innerText()) === text) {
      await option.last().click(); return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`Option not found: ${text}`);
}
try {
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', error => errors.push(error.message));
  const cases = [
    { name: 'Фрактальный уровень', field: 'Фрактал вверх', label: 'Фрактал вверх(3+3) · окно 12 · 15m', id: 'fractalHigh', tf: '15m', period: 3,
      params: { fractalLookback: 12 }, inputs: [['Свечей с каждой стороны', '3'], ['Искать подтверждение за последние N свечей', '12']] },
    { name: 'Настроенный MACD', field: 'MACD', label: 'MACD 4/9/3 · 5m', id: 'macd', tf: '5m', period: 10,
      params: { fast: 4, slow: 9, signal: 3 }, inputs: [['fast', '4'], ['slow', '9'], ['signal', '3']] },
    { name: 'Настроенный стохастик', field: 'Стохастик %K', label: 'Стохастик %K 5/2/2 · 5m', id: 'stochK', tf: '5m', period: 10,
      params: { kLength: 5, kSmooth: 2, dSmooth: 2 }, inputs: [['kLength', '5'], ['kSmooth', '2'], ['dSmooth', '2']] },
  ];
  for (const example of cases) {
    await page.getByRole('button', { name: 'Создать сигнал', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill(example.name);
    await page.getByRole('button', { name: /Настроить показатель/ }).click();
    const form = page.getByRole('dialog', { name: 'Настроить показатель', exact: true });
    await choose(page, form.getByLabel('Показатель', { exact: true }), example.field);
    await choose(page, form.getByLabel('Таймфрейм', { exact: true }), example.tf);
    for (const [label, value] of example.inputs) await form.getByLabel(label, { exact: true }).fill(value);
    await form.getByRole('button', { name: 'Добавить показатель', exact: true }).click();
    await choose(page, page.locator('.rule-fields').first(), example.label);
    await page.getByRole('button', { name: 'Сохранить сигнал', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const snapshot = await page.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
    const saved = snapshot.signals.find(s => s.name === example.name);
    assert.ok(saved, `Signal not saved: ${example.name}`);
    const rule = saved.expression.rules[0];
    assert.equal(rule.left.field, example.id); assert.equal(rule.left.period, example.period); assert.equal(rule.left.timeframe, example.tf);
    for (const [key, value] of Object.entries(example.params)) assert.equal(rule.left.params[key], value);
    assert.equal(rule.right.timeframe, example.tf);
    assert.equal(saved.enabled, false);
  }
  await page.getByRole('button', { name: 'Справочники', exact: true }).click();
  await page.getByRole('cell', { name: 'Фрактал вверх', exact: true }).waitFor();
  await page.getByRole('cell', { name: 'Сумма объёма', exact: true }).waitFor();
  await page.screenshot({ path: '.local/screenshots/indicator-catalog.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('PASS: custom fractal/MACD/Stochastic configuration, compatible crossing, engine schema save and indicator catalog');
} catch (error) {
  console.error('Renderer errors:', JSON.stringify(errors));
  const page = (await application.windows())[0];
  if (page) { console.error((await page.locator('body').innerText()).slice(-9000)); await page.screenshot({ path: '.local/screenshots/editor-failure.png' }); }
  throw error;
} finally { await application.close(); }
