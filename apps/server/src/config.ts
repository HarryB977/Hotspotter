import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Replaced by esbuild `define` in the portable build; undeclared in dev and tests. */
declare const __HOTSPOTTER_VERSION__: string;

/** Folder for user data (settings, update state). Callers create it on demand. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOTSPOTTER_DATA_DIR) return env.HOTSPOTTER_DATA_DIR;
  if (env.LOCALAPPDATA) return `${env.LOCALAPPDATA}\Hotspotter`;
  return join(homedir(), 'AppData', 'Local', 'Hotspotter');
}

function readPackageVersion(): string {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return version;
}

/** Build-time version when bundled; package.json only as the dev/test fallback. */
export const APP_VERSION: string =
  typeof __HOTSPOTTER_VERSION__ !== 'undefined' ? __HOTSPOTTER_VERSION__ : readPackageVersion();
