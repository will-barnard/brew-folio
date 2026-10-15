import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:3001', '/healthz': process.env.API_URL || 'http://localhost:3001' },
  },
  build: { target: 'es2020', sourcemap: false },
});
