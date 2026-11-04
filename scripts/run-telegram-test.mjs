import { spawn } from 'node:child_process';
import electron from 'electron';
import { resolve } from 'node:path';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [resolve('out/telegram-test/index.cjs')], { env, stdio: 'inherit' });
child.on('error', () => { console.error('Не удалось запустить Electron-проверку Telegram'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
