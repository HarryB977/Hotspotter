import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
let root: string;
let dir: string;

const put = (query: Record<string, string>, body: Buffer, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'PUT',
    url: '/api/export/file',
    query,
    headers: { 'content-type': 'application/octet-stream', 'x-hotspotter': '1', ...headers },
    payload: body,
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hotspotter-'));
  dir = join(root, 'my export folder', 'sub dir');
  app = buildApp({});
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('server', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });

  it('writes identical bytes into a directory with spaces, creating it', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const res = await put({ dir, name: 'albedo.png' }, bytes);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: join(dir, 'albedo.png') });
    expect(Buffer.compare(await readFile(join(dir, 'albedo.png')), bytes)).toBe(0);
  });

  it('overwrites when the same name is uploaded again', async () => {
    await put({ dir, name: 'o.bin' }, Buffer.from('first-longer'));
    const res = await put({ dir, name: 'o.bin' }, Buffer.from('second'));
    expect(res.statusCode).toBe(200);
    expect((await readFile(join(dir, 'o.bin'))).toString()).toBe('second');
  });

  it('rejects unsafe paths with 400', async () => {
    const body = Buffer.from('x');
    const cases: Record<string, string>[] = [
      { dir, name: '../x.png' },
      { dir, name: 'a/b.png' },
      { dir, name: 'a\\b.png' },
      { dir, name: '..' },
      { dir, name: '' },
      { dir: 'relative/path', name: 'x.png' },
      { dir: '\\\\server\\share\\x', name: 'x.png' },
      { dir: '//server/share/x', name: 'x.png' },
      { dir: '\\\\?\\C:\\x', name: 'x.png' },
      { dir, name: 'a.png:evil' },
      { dir, name: 'CON' },
      { dir, name: 'nul.png' },
      { dir, name: 'x.' },
      { dir: `${dir}/../escape`, name: 'x.png' },
      { dir: `${dir}\\..\\escape`, name: 'x.png' },
    ];
    for (const q of cases) {
      const res = await put(q, body);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
  });

  it('rejects non-loopback Host headers with 403', async () => {
    const strict = buildApp({ allowedPort: 7420 });
    const ok = await strict.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:7420' } });
    expect(ok.statusCode).toBe(200);
    for (const host of ['evil.example:7420', 'localhost:9999', '127.0.0.1']) {
      const res = await strict.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
    await strict.close();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:7420' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests from a foreign Origin with 403', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:9999', 'null']) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
    const write = await put({ dir, name: 'evil.png' }, Buffer.from('x'), { origin: 'http://evil.example' });
    expect(write.statusCode).toBe(403);
  });

  it('rejects an export upload without the X-Hotspotter header with 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/export/file',
      query: { dir, name: 'noheader.png' },
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost:5173' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('accepts an export upload from an allowed Origin with the X-Hotspotter header', async () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:7420', 'http://127.0.0.1:7420']) {
      const res = await put({ dir, name: 'ok.png' }, Buffer.from(origin), { origin });
      expect(res.statusCode, origin).toBe(200);
    }
  });
});
