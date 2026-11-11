import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
let root: string;
let dir: string;

const put = (query: Record<string, string>, body: Buffer) =>
  app.inject({
    method: 'PUT',
    url: '/api/export/file',
    query,
    headers: { 'content-type': 'application/octet-stream' },
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
      { dir: `${dir}/../escape`, name: 'x.png' },
      { dir: `${dir}\\..\\escape`, name: 'x.png' },
    ];
    for (const q of cases) {
      const res = await put(q, body);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
  });
});
