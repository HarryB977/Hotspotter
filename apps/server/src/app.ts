import { existsSync, readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerExportRoute } from './exportRoute';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export function buildApp(opts: { webRoot?: string; allowedPort?: number }): FastifyInstance {
  const app = Fastify();

  // Blocks DNS rebinding: only loopback host names are accepted.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    const i = host.lastIndexOf(':');
    const name = i < 0 ? host : host.slice(0, i);
    const port = i < 0 ? '' : host.slice(i + 1);
    const portOk = opts.allowedPort === undefined || port === String(opts.allowedPort);
    if ((name !== '127.0.0.1' && name !== 'localhost') || !portOk) {
      return reply.code(403).send({ error: 'Host no permitido' });
    }
  });

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
