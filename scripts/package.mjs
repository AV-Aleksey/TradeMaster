import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import './ensure-electron.mjs';

const require = createRequire(import.meta.url);
const [target = 'dir', ...options] = process.argv.slice(2);
const signed = options.includes('--signed');
const architectures = options.filter(option => option === '--arm64' || option === '--x64');
if (!['dir', 'mac', 'win'].includes(target) || options.some(option => !['--arm64', '--x64', '--signed'].includes(option)) || architectures.length > 1) {
  console.error('Использование: node scripts/package.mjs dir|mac|win [--arm64|--x64] [--signed]');
  process.exit(1);
}
if (!['darwin', 'win32'].includes(process.platform) || (target === 'mac' && process.platform !== 'darwin') || (target === 'win' && process.platform !== 'win32')) {
  console.error('Собирайте macOS-версию на macOS, Windows-версию — на Windows: SQLite содержит нативный модуль.');
  process.exit(1);
}
if (signed) {
  const certificate = process.platform === 'darwin' ? process.env.CSC_LINK || process.env.CSC_NAME : process.env.WIN_CSC_LINK || process.env.CSC_LINK;
  const notarization = (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
    || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
    || (process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE);
  if (!certificate || (process.platform === 'darwin' && !notarization)) {
    console.error('Для подписанного релиза задайте сертификат; для macOS также нужны учётные данные нотариализации. См. docs/BUILD.md.');
    process.exit(1);
  }
}
const environment = { ...process.env, TRADEMASTER_SIGNED_RELEASE: signed ? '1' : '0' };
delete environment.ELECTRON_RUN_AS_NODE;
if (!signed) environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--config', 'electron-builder.config.cjs',
  target === 'dir' ? '--dir' : `--${target}`, ...architectures, '--publish', 'never'], { stdio: 'inherit', env: environment });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
