import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { compareSemver, createUpdateService } from '../src/updates';

const HOUR = 3_600_000;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hs-updates-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const release = (tag: string) =>
  new Response(JSON.stringify({ tag_name: tag, body: 'Notas', html_url: `https://example.test/${tag}` }), { status: 200 });

function setup(opts: { respond?: () => Response | Promise<Response>; token?: string; current?: string } = {}) {
  let t = 1_700_000_000_000;
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    (opts.respond ?? (() => release('v0.2.0')))(),
  );
  const service = createUpdateService({
    currentVersion: opts.current ?? '0.1.0',
    token: opts.token,
    dir,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => t,
  });
  return { service, fetchMock, advance: (ms: number) => (t += ms) };
}

describe('compareSemver', () => {
  it('compares numerically and accepts a leading v', () => {
    expect(compareSemver('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.9.0', '0.10.0')).toBeLessThan(0);
  });
});

describe('update service', () => {
  it('reports a newer stable release with notes and url', async () => {
    const { service, fetchMock } = setup();
    expect(await service.state()).toEqual({
      status: 'available',
      version: '0.2.0',
      notes: 'Notas',
      url: 'https://example.test/v0.2.0',
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.github.com/repos/HarryB977/Hotspotter/releases/latest');
  });

  it('reports none for equal and older versions', async () => {
    expect((await setup({ respond: () => release('v0.1.0') }).service.state()).status).toBe('none');
    expect((await setup({ respond: () => release('v0.0.9') }).service.state()).status).toBe('none');
  });

  it('never offers a pre-release tag', async () => {
    const { service } = setup({ respond: () => release('v0.2.0-beta.1') });
    expect((await service.state()).status).toBe('none');
  });

  it('hides a skipped version', async () => {
    const { service } = setup();
    await service.skip('0.2.0');
    expect((await service.state()).status).toBe('none');
  });

  it('reports authError on 401 and 403', async () => {
    for (const code of [401, 403]) {
      const { service } = setup({ respond: () => new Response('{}', { status: code }) });
      expect(await service.state()).toEqual({ status: 'authError' });
    }
  });

  it('reports none when fetch throws, and retries on the next call', async () => {
    const { service, fetchMock } = setup({
      respond: () => {
        throw new Error('offline');
      },
    });
    expect((await service.state()).status).toBe('none');
    await service.state();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throttles to one request per 6 hours', async () => {
    const { service, fetchMock, advance } = setup();
    await service.state();
    advance(6 * HOUR - 1);
    expect((await service.state()).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(2);
    await service.state();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persists the throttle across service instances', async () => {
    await setup().service.state();
    const second = setup();
    expect((await second.service.state()).status).toBe('available');
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates a corrupt updates.json', async () => {
    await writeFile(join(dir, 'updates.json'), '{not json');
    const { service } = setup();
    expect((await service.state()).status).toBe('available');
    expect(JSON.parse(await readFile(join(dir, 'updates.json'), 'utf8')).lastCheck).toBeGreaterThan(0);
  });

  it('sends Authorization only when a token is set', async () => {
    const withToken = setup({ token: 'sekret-token' });
    await withToken.service.state();
    const h = (withToken.fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sekret-token');
    expect(h.Accept).toBe('application/vnd.github+json');
    expect(h['User-Agent']).toBe('Hotspotter/0.1.0');
    const anon = setup();
    await rm(join(dir, 'updates.json'), { force: true });
    await anon.service.state();
    expect((anon.fetchMock.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Authorization');
  });
});

describe('update routes', () => {
  it('serves the state without leaking the token, and skip needs the header', async () => {
    const { service } = setup({ token: 'sekret-token' });
    const app = buildApp({ port: 80, updates: service });
    const res = await app.inject({ method: 'GET', url: '/api/update' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('available');
    expect(res.body).not.toContain('sekret-token');

    const denied = await app.inject({ method: 'POST', url: '/api/update/skip', payload: { version: '0.2.0' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/update/skip',
      headers: { 'x-hotspotter': '1' },
      payload: { version: '0.2.0' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/update' })).json()).toEqual({ status: 'none' });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/update/skip',
      headers: { 'x-hotspotter': '1' },
      payload: { version: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('does not register the routes without a service', async () => {
    const app = buildApp({ port: 80 });
    expect((await app.inject({ method: 'GET', url: '/api/update' })).statusCode).toBe(404);
    await app.close();
  });
});
