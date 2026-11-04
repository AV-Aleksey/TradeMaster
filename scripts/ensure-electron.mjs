import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('TradeMaster требует Node.js 22.12 или новее. Версия проекта для Volta: 22.23.1.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('electron/package.json'));
const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const pathFile = join(directory, 'path.txt');
let installed = false;
try {
  const relative = readFileSync(pathFile, 'utf8').trim();
  const version = readFileSync(join(directory, 'dist/version'), 'utf8').trim().replace(/^v/, '');
  installed = version === metadata.version && existsSync(join(directory, 'dist', relative));
} catch { /* a fresh npm installation does not include the Electron executable */ }
if (!installed) {
  console.log(`Устанавливаем исполняемый Electron ${metadata.version}. Первый запуск требует загрузки архива; следующие используют локальную копию.`);
  const result = spawnSync(process.execPath, [join(directory, 'install.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Не удалось загрузить Electron. Проверьте доступ к github.com и release-assets.githubusercontent.com, затем выполните npm run setup.');
    process.exit(1);
  }
}
