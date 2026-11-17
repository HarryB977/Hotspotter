import { describe, expect, it } from 'vitest';
import { allowedOrigins, buildApp } from '../src/app';

const get = (app: ReturnType<typeof buildApp>, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/api/health', headers });

describe('buildApp runtime port', () => {
  it('accepts the real port and rejects the old fixed one', async () => {
    const app = buildApp({ port: 7421, version: '9.9.9' });
    expect((await get(app, { host: '127.0.0.1:7421' })).statusCode).toBe(200);
    expect((await get(app, { host: '127.0.0.1:7420' })).statusCode).toBe(403);
    await app.close();
  });

  it('allows only the bundled origins unless dev is on', async () => {
    const prod = buildApp({ port: 7421 });
    const host = '127.0.0.1:7421';
    expect((await get(prod, { host, origin: 'http://localhost:7421' })).statusCode).toBe(200);
    expect((await get(prod, { host, origin: 'http://127.0.0.1:5173' })).statusCode).toBe(403);
    const dev = buildApp({ port: 7421, dev: true });
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
      expect((await get(dev, { host, origin })).statusCode, origin).toBe(200);
    }
    await prod.close();
    await dev.close();
  });

  it('reports the injected version on /api/health', async () => {
    const app = buildApp({ port: 7421, version: '1.2.3' });
    const res = await get(app, { host: '127.0.0.1:7421' });
    expect(res.json()).toEqual({ ok: true, version: '1.2.3' });
    await app.close();
  });

  it('builds the origin set from the port', () => {
    expect(allowedOrigins(7421, false)).toEqual(
      new Set(['http://127.0.0.1:7421', 'http://localhost:7421']),
    );
    expect(allowedOrigins(7421, true).size).toBe(4);
  });
});
