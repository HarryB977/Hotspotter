import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { findRunning, pickPort } from '../src/instance';

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hs-instance-'));
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  await rm(dir, { recursive: true, force: true });
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function occupy(port = 0): Promise<number> {
  const server = createServer((_req, res) => res.end('busy'));
  const p = await listen(server, port);
  closers.push(() => new Promise((r) => server.close(r)));
  return p;
}

const writeLock = (port: number, version = '0.1.0') =>
  writeFile(join(dir, 'instance.json'), JSON.stringify({ port, version, pid: 4242 }), 'utf8');

describe('pickPort', () => {
  it('returns the preferred port when it is free', async () => {
    // A port the OS just handed out and released, so the test does not depend on 7420 being idle.
    const server = createServer();
    const free = await listen(server);
    await new Promise((r) => server.close(r));
    expect(await pickPort(free)).toBe(free);
  });

  it('returns another free port when the preferred one is taken', async () => {
    const taken = await occupy();
    const port = await pickPort(taken);
    expect(port).not.toBe(taken);
    expect(port).toBeGreaterThan(0);
    // The returned port is really free.
    await occupy(port);
  });
});

describe('findRunning', () => {
  it('returns null without a lock file', async () => {
    expect(await findRunning(dir)).toBeNull();
  });

  it('returns null when the lock points to a port where nothing answers', async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((r) => server.close(r));
    await writeLock(port);
    expect(await findRunning(dir)).toBeNull();
  });

  it('returns null when something other than Hotspotter answers', async () => {
    await writeLock(await occupy());
    expect(await findRunning(dir)).toBeNull();
  });

  it('returns null for a malformed lock file', async () => {
    await writeFile(join(dir, 'instance.json'), '{nope', 'utf8');
    expect(await findRunning(dir)).toBeNull();
  });

  it('returns the port and version reported by a running server', async () => {
    const port = await pickPort(0);
    const app = buildApp({ port, version: '9.8.7' });
    await app.listen({ host: '127.0.0.1', port });
    closers.push(() => app.close());
    await writeLock(port, '0.0.1');
    expect(await findRunning(dir)).toEqual({ port, version: '9.8.7' });
  });
});
