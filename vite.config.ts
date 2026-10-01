import { defineConfig } from 'vite';
import { pwaPlugin } from './build/pwa.ts';

export default defineConfig({
  plugins: [
    // Emits dist/sw.js (precache + offline support) on `vite build` only.
    pwaPlugin(),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
  },
});
