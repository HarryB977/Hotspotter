import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const port = Number(process.env.HOTSPOTTER_PORT ?? 7420);
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

// Dev has no release to check: a no-op service keeps /api/update answering 200 instead of 404.
const updates = { state: async () => ({ status: 'none' as const }), skip: async () => {} };
const app = buildApp({ webRoot, port, dev: true, updates });
app.listen({ host: '127.0.0.1', port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
