import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()],
  // Assets are always emitted as files: the server's CSP (img-src 'self' blob:) blocks inlined data: URLs.
  build: {outDir: '../../dist/web', emptyOutDir: true, assetsInlineLimit: 0},
  server: {host: '127.0.0.1', proxy: {'/api': {target: process.env.DEV_API_ORIGIN ?? 'http://127.0.0.1:3000', changeOrigin: true, headers: {origin: process.env.DEV_API_ORIGIN ?? 'http://127.0.0.1:3000'}}}}
});
