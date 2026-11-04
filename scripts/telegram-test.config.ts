import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
export default defineConfig({ main: { build: { outDir: 'out/telegram-test', rollupOptions: {
  input: resolve('scripts/telegram-native-test.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' },
} } } });
