import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Writes a .br (quality 11) and .gz (level 9) copy beside each built script, style, SVG and page, once per build.
// The server sends these as they are, rather than compressing every response at the plugin's quicker settings.
function precompress(): Plugin {
  let outDir = '';
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(join(dir, f.name)) : [join(dir, f.name)]);
  return {
    name: 'tk-precompress', apply: 'build',
    // outDir is relative to the app's root, not to where the build was started.
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!/\.(?:js|css|svg|html)$/.test(file)) continue;
        const bytes = readFileSync(file);
        if (bytes.length < 1024) continue;
        writeFileSync(`${file}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      }
    }
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react(), precompress()],
  // Assets are always emitted as files: the server's CSP (img-src 'self' blob:) blocks inlined data: URLs.
  // portal.html is the Requests site's page (Admin › Requests); it shares the app's bundles.
  build: {outDir: '../../dist/web', emptyOutDir: true, assetsInlineLimit: 0,
    rollupOptions: {input: {main: fileURLToPath(new URL('index.html', import.meta.url)), portal: fileURLToPath(new URL('portal.html', import.meta.url))}}},
  server: {host: '127.0.0.1', proxy: {'/api': {target: process.env.DEV_API_ORIGIN ?? 'http://127.0.0.1:3000', changeOrigin: true, headers: {origin: process.env.DEV_API_ORIGIN ?? 'http://127.0.0.1:3000'}}}}
});
