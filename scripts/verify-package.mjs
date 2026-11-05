import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { listPackage } from '@electron/asar';
import { _electron as electron } from 'playwright';

const application = resolve(process.argv[2] ?? (process.platform === 'darwin' ? `release/mac-${process.arch}/TradeMaster.app` : 'release/win-unpacked'));
const resources = process.platform === 'darwin' ? join(application, 'Contents/Resources') : join(application, 'resources');
const executable = process.platform === 'darwin' ? join(application, 'Contents/MacOS/TradeMaster') : join(application, 'TradeMaster.exe');
const archive = join(resources, 'app.asar');
assert.ok(existsSync(join(resources, 'icon.png')), 'В пакете нет иконки приложения');
assert.ok(existsSync(executable), `Не найдено приложение: ${executable}`);
const files = listPackage(archive, {}).map(file => file.replaceAll('\\', '/').replace(/^\/+/, ''));
for (const required of ['out/main/index.js', 'out/main/worker.js', 'out/preload/index.cjs', 'out/renderer/index.html']) assert.ok(files.includes(required), `В пакете нет ${required}`);
assert.ok(files.some(file => /^out\/renderer\/assets\/signal-.*\.wav$/.test(file)), 'В пакете нет звука');
assert.ok(files.some(file => /better-sqlite3\/.*\.node$/.test(file) && existsSync(join(resources, 'app.asar.unpacked', file))), 'Нет распакованного нативного SQLite');
assert.deepEqual(files.filter(file => /^(?:\.env(?:\.|$)|\.local(?:\/|$)|src\/|tests\/|scripts\/|docs\/|credentials\.enc$|telegram\.enc$)/.test(file)), [], 'В пакет попали файлы разработки или настройки');
mkdirSync('.local', { recursive: true });
const directory = mkdtempSync(resolve('.local/packaged-'));
const environment = { ...process.env, TRADEMASTER_DATA_DIR: directory, TRADEMASTER_REPLAY_ONLY: '1', ITICK_TOKEN: '' };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const launch = () => electron.launch({ executablePath: executable, args: [], env: environment });
let app;
try {
  app = await launch();
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await page.waitForFunction(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data?.candles.length > 0);
  await page.evaluate(() => {
    window.packagedAudioResult = '';
    const OriginalAudio = window.Audio;
    window.Audio = function (...args) {
      const audio = new OriginalAudio(...args);
      audio.addEventListener('ended', () => { window.packagedAudioResult = 'ended'; });
      audio.addEventListener('error', () => { window.packagedAudioResult = 'error'; });
      return audio;
    };
  });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Прослушать звук', exact: true }).click();
  await page.waitForFunction(() => window.packagedAudioResult === 'ended');
  const result = await page.evaluate(async () => window.trademaster.invoke({ type: 'setSoundSettings', enabled: false, volume: 45 }));
  assert.equal(result.ok, true);
  assert.deepEqual(errors, []);
  await app.close(); app = undefined;
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.getByRole('button', { name: 'Создать сигнал', exact: true }).waitFor({ timeout: 30000 });
  const state = await reopened.evaluate(async () => (await window.trademaster.invoke({ type: 'snapshot' })).data);
  assert.equal(state.settings.soundEnabled, false); assert.equal(state.settings.soundVolume, 45);
  assert.ok(existsSync(join(directory, 'trademaster.sqlite')));
  console.log('PASS: packaged app, ASAR, utility worker, native SQLite, candles, bundled audio, settings persistence; no development data in archive.');
} finally { await app?.close(); }
