import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VERSION_NAME ?? 'dev'),
    __APP_VERSION_CODE__: JSON.stringify(Number(process.env.VERSION_CODE ?? 0)),
  },
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
