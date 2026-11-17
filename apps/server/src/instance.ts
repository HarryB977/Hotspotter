import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Contents of `<dataDir>/instance.json`, written by the running launcher. */
export interface InstanceInfo {
  port: number;
  version: string;
  pid: number;
}

const lockFile = (dir: string) => join(dir, 'instance.json');

/** Asks the port in the lock file whether a Hotspotter is really there; a stale lock gives null. */
export async function findRunning(
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ port: number; version: string } | null> {
  let port: unknown;
  try {
    ({ port } = JSON.parse(await readFile(lockFile(dir), 'utf8')) as { port?: unknown });
  } catch {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    if (body.ok !== true || typeof body.version !== 'string') return null;
    return { port, version: body.version };
  } catch {
    return null;
  }
}

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) =>
      err.code === 'EADDRINUSE' || err.code === 'EACCES' ? resolve(null) : reject(err),
    );
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address() as { port: number };
      server.close(() => resolve(bound));
    });
  });
}

/** The preferred port if it is free on 127.0.0.1, otherwise one the OS hands out. */
export async function pickPort(preferred: number): Promise<number> {
  return (await tryListen(preferred)) ?? (await tryListen(0))!;
}

export function writeInstance(dir: string, info: InstanceInfo): void {
  writeFileSync(lockFile(dir), JSON.stringify(info), 'utf8');
}

/** Synchronous so it can run from an `exit` handler; leaves another process's lock alone. */
export function removeInstance(dir: string, pid: number): void {
  try {
    const current = JSON.parse(readFileSync(lockFile(dir), 'utf8')) as { pid?: unknown };
    if (current.pid === pid) unlinkSync(lockFile(dir));
  } catch {
    // Already gone or unreadable: nothing to clean up.
  }
}
