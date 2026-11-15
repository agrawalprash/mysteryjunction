import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.VERSION_NAME ?? 'dev') },
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
