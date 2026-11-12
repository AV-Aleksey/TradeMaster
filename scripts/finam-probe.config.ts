import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
export default defineConfig({ main: { build: { outDir: 'out/finam-probe', rollupOptions: {
  input: resolve('scripts/finam-probe.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' },
} } } });
