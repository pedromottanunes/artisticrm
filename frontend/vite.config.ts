import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': process.env.ARTISTI_API_TARGET ?? 'http://127.0.0.1:3333' },
  },
  preview: { port: 4173, proxy: { '/api': 'http://127.0.0.1:3333' } },
});
