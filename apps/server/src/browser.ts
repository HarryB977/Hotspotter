import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

const USER_CHOICE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';

export interface InstalledBrowsers {
  chrome?: string;
  edge?: string;
}

/** Default browser if it is Chrome or Edge and installed; otherwise whichever of the two is installed. */
export function chooseBrowser(defaultProgId: string | null, installed: InstalledBrowsers): { exe: string } | null {
  const id = defaultProgId ?? '';
  if (id.startsWith('ChromeHTML') && installed.chrome) return { exe: installed.chrome };
  if (id.startsWith('MSEdgeHTM') && installed.edge) return { exe: installed.edge };
  const exe = installed.chrome ?? installed.edge;
  return exe ? { exe } : null;
}

/** Extracts the ProgId value from `reg query ... /v ProgId` output. */
export function parseProgId(regOutput: string): string | null {
  const m = /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/im.exec(regOutput);
  return m ? m[1] : null;
}

export function readDefaultProgId(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', USER_CHOICE_KEY, '/v', 'ProgId'], { windowsHide: true }, (err, stdout) =>
      resolve(err ? null : parseProgId(stdout)),
    );
  });
}

/** Looks for Chrome and Edge in their standard per-machine and per-user install folders. */
export function findInstalled(env: NodeJS.ProcessEnv = process.env): InstalledBrowsers {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
  const first = (rel: string) => roots.map((r) => win32.join(r, rel)).find((p) => existsSync(p));
  return {
    chrome: first('Google\\Chrome\\Application\\chrome.exe'),
    edge: first('Microsoft\\Edge\\Application\\msedge.exe'),
  };
}

/** Starts the browser independent of this process, so closing the console leaves it open. Resolves false if it failed to start. */
export function launchBrowser(exe: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
    child.unref();
  });
}
