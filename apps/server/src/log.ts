import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_NAME = 'hotspotter.log';
export const MAX_LOG_BYTES = 1024 * 1024;

/** Moves an oversized log to `<name>.1` (replacing the previous one); a missing file is fine. */
export function rotateLog(dir: string, maxBytes = MAX_LOG_BYTES): void {
  const file = join(dir, LOG_NAME);
  try {
    if (statSync(file).size <= maxBytes) return;
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or it cannot be rotated: logging must never stop the app.
  }
}

export interface FileLog {
  (message: string): void;
}

/** Appends timestamped lines to `<dir>/hotspotter.log`. Any `secrets` are masked; write errors are swallowed. */
export function createFileLog(dir: string, secrets: string[] = [], now: () => Date = () => new Date()): FileLog {
  const file = join(dir, LOG_NAME);
  const masked = secrets.filter((s) => s.length > 0);
  return (message) => {
    let line = message.replace(/\r?\n/g, ' ');
    for (const s of masked) line = line.split(s).join('***');
    try {
      appendFileSync(file, `${now().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // Same as above.
    }
  };
}
