import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLog, LOG_NAME, MAX_LOG_BYTES, rotateLog } from '../src/log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hs-log-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('rotateLog', () => {
  it('moves a log over the cap to .1 and leaves room for a fresh one', async () => {
    await writeFile(join(dir, LOG_NAME), 'x'.repeat(MAX_LOG_BYTES + 1));
    rotateLog(dir);
    expect(existsSync(join(dir, LOG_NAME))).toBe(false);
    expect((await readFile(join(dir, `${LOG_NAME}.1`), 'utf8')).length).toBe(MAX_LOG_BYTES + 1);
  });

  it('replaces an older .1', async () => {
    await writeFile(join(dir, `${LOG_NAME}.1`), 'old');
    await writeFile(join(dir, LOG_NAME), 'y'.repeat(20));
    rotateLog(dir, 10);
    expect(await readFile(join(dir, `${LOG_NAME}.1`), 'utf8')).toBe('y'.repeat(20));
  });

  it('keeps a small log and tolerates a missing one', async () => {
    rotateLog(dir);
    await writeFile(join(dir, LOG_NAME), 'small');
    rotateLog(dir);
    expect(await readFile(join(dir, LOG_NAME), 'utf8')).toBe('small');
    expect(existsSync(join(dir, `${LOG_NAME}.1`))).toBe(false);
  });
});

describe('createFileLog', () => {
  it('appends timestamped single-line entries', async () => {
    const log = createFileLog(dir, [], () => new Date('2026-11-17T10:00:00Z'));
    log('start 0.1.0 port 7420');
    log('two\nlines');
    expect(await readFile(join(dir, LOG_NAME), 'utf8')).toBe(
      '2026-11-17T10:00:00.000Z start 0.1.0 port 7420\n2026-11-17T10:00:00.000Z two lines\n',
    );
  });

  it('never writes the token, even if it ends up in a message', async () => {
    const token = 'github_pat_SECRET123';
    const log = createFileLog(dir, [token]);
    log(`update check failed: bad credentials for ${token}`);
    const text = await readFile(join(dir, LOG_NAME), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('update check failed');
  });

  it('does not throw when the folder is missing', () => {
    expect(() => createFileLog(join(dir, 'nope'))('hello')).not.toThrow();
  });
});
