import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',          // Use relative paths — required for Electron & PWA
  build: {
    outDir: 'www',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      }
    }
  }
});
