import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    rolldownOptions: { input: { game: 'index.html', review: 'review.html' } },
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
  },
});
