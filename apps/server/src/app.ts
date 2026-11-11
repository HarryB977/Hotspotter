import { existsSync, readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerExportRoute } from './exportRoute';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export function buildApp(opts: { webRoot?: string }): FastifyInstance {
  const app = Fastify();

  app.get('/api/health', async () => ({ ok: true, version }));
  registerExportRoute(app);

  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.register(fastifyStatic, { root: opts.webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'No encontrado' });
    });
  }

  return app;
}
