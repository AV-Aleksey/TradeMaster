import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve('src/main/index.ts'), worker: resolve('src/main/worker.ts'),
    } } },
  },
  preload: { plugins: [externalizeDepsPlugin()], build: {
    rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } },
  } },
  renderer: { plugins: [react()], root: 'src/renderer', build: {
    rollupOptions: { input: resolve('src/renderer/index.html') },
  } },
});
