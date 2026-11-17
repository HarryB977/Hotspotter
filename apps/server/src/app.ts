import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerExportRoute } from './exportRoute';
import { APP_VERSION } from './config';
import type { UpdateServiceLike } from './updateTypes';

/** Browser origins allowed to call the API: the bundled app, plus the Vite dev server in dev. */
export function allowedOrigins(port: number, dev: boolean): Set<string> {
  const ports = dev ? [port, 5173] : [port];
  return new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
}

export function buildApp(opts: {
  webRoot?: string;
  port: number;
  version?: string;
  dev?: boolean;
  updates?: UpdateServiceLike;
}): FastifyInstance {
  const app = Fastify();
  const origins = allowedOrigins(opts.port, opts.dev ?? false);
  const version = opts.version ?? APP_VERSION;

  // Blocks DNS rebinding: only loopback host names are accepted.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    const i = host.lastIndexOf(':');
    const name = i < 0 ? host : host.slice(0, i);
    const port = i < 0 ? '' : host.slice(i + 1);
    const portOk = port === String(opts.port);
    if ((name !== '127.0.0.1' && name !== 'localhost') || !portOk) {
      return reply.code(403).send({ error: 'Host no permitido' });
    }
    // Blocks cross-site requests that reach the server through the dev proxy, which rewrites Host.
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return reply.code(403).send({ error: 'Origen no permitido' });
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
