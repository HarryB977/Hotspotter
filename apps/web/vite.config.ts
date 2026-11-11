import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SAMPLES_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../samples');

/** Resolves a sample folder under samples/, falling back to samples/pbr/. */
function resolveSampleDir(dir: string): string | null {
  for (const base of [SAMPLES_ROOT, join(SAMPLES_ROOT, 'pbr')]) {
    const full = normalize(join(base, dir));
    if (full.startsWith(SAMPLES_ROOT + sep) && existsSync(full) && statSync(full).isDirectory()) return full;
  }
  return null;
}

function samplesPlugin(): Plugin {
  return {
    name: 'hotspotter-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = decodeURIComponent(url.pathname);
        if (path.startsWith('/samples-index/')) {
          const dir = resolveSampleDir(path.slice('/samples-index/'.length));
          if (!dir) { res.statusCode = 404; res.end(); return; }
          const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }
        if (path.startsWith('/samples/')) {
          const rel = path.slice('/samples/'.length);
          const slash = rel.lastIndexOf('/');
          const dir = slash < 0 ? null : resolveSampleDir(rel.slice(0, slash));
          const file = dir ? normalize(join(dir, rel.slice(slash + 1))) : null;
          if (!file || !file.startsWith(SAMPLES_ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404; res.end(); return;
          }
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), samplesPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['../..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:7420', changeOrigin: true } },
  },
});
