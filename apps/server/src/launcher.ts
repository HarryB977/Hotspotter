// Entry point of hotspotter.exe (bundled to CJS and packed as a Node SEA by scripts/build-portable.mjs).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildApp } from './app';
import { chooseBrowser, findInstalled, launchBrowser, readDefaultProgId } from './browser';
import { APP_VERSION, dataDir } from './config';
import { createFileLog, rotateLog } from './log';
import { findRunning, pickPort, removeInstance, writeInstance } from './instance';
import { createUpdateService } from './updates';

/** Read-only GitHub token injected by esbuild `define`; empty when the build had none. */
declare const __HOTSPOTTER_GH_TOKEN__: string;

const PREFERRED_PORT = 7420;

const say = (...lines: string[]) => console.log(lines.join('\n'));

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', () => resolve());
    rl.once('close', () => resolve());
  });
}

/** Opens Chrome or Edge at the URL; false when neither is installed or it failed to start. */
async function openInBrowser(url: string): Promise<boolean> {
  const choice = chooseBrowser(await readDefaultProgId(), findInstalled());
  return choice !== null && (await launchBrowser(choice.exe, url));
}

function sayNoBrowser(url: string): void {
  say(
    '',
    'No se ha encontrado Google Chrome ni Microsoft Edge.',
    'Hotspotter necesita uno de los dos (usa WebGPU). Instala Chrome (https://www.google.com/chrome/)',
    'o Edge (https://www.microsoft.com/edge) y abre en él esta dirección:',
    `  ${url}`,
  );
}

async function main(): Promise<void> {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const skipBrowser = process.env.HOTSPOTTER_NO_BROWSER === '1';
  rotateLog(dir);
  const token = typeof __HOTSPOTTER_GH_TOKEN__ !== 'undefined' ? __HOTSPOTTER_GH_TOKEN__ : '';
  const log = createFileLog(dir, [token]);

  const running = await findRunning(dir);
  if (running) {
    const url = `http://127.0.0.1:${running.port}/`;
    if (running.version !== APP_VERSION) {
      say(
        `Hay otra versión de Hotspotter abierta (${running.version}); ciérrala y vuelve a abrir esta.`,
        '',
        'Pulsa Intro para salir.',
      );
      await waitForEnter();
      process.exit(0);
    }
    say('Hotspotter ya estaba abierto: se abre en el navegador la copia que está en marcha.', `Dirección: ${url}`);
    if (!skipBrowser && !(await openInBrowser(url))) sayNoBrowser(url);
    process.exit(0);
  }

  const webRoot = join(dirname(process.execPath), 'web');
  if (!existsSync(webRoot)) {
    say(
      'Falta la carpeta web junto a hotspotter.exe: descomprime el zip entero y abre el .exe desde esa carpeta.',
      '',
      'Pulsa Intro para salir.',
    );
    await waitForEnter();
    process.exit(1);
  }

  const port = await pickPort(PREFERRED_PORT);
  const updates = createUpdateService({ currentVersion: APP_VERSION, token: token || undefined, dir, log });
  const app = buildApp({ webRoot, port, dev: false, updates });
  app.addHook('onError', async (req, _reply, err) => {
    log(`server error ${req.method} ${req.url.split('?')[0]}: ${err.message}`);
  });
  await app.listen({ host: '127.0.0.1', port });
  log(`start version ${APP_VERSION} port ${port} pid ${process.pid}`);

  writeInstance(dir, { port, version: APP_VERSION, pid: process.pid });
  process.on('exit', () => removeInstance(dir, process.pid));
  // SIGHUP is how Windows reports the console window being closed; exiting runs the handler above.
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGBREAK', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }

  const url = `http://127.0.0.1:${port}/`;
  say(`Hotspotter ${APP_VERSION}`, '');
  if (skipBrowser) say(`Hotspotter está en marcha en ${url}`);
  else if (await openInBrowser(url)) say(`Hotspotter está abierto en el navegador: ${url}`);
  else sayNoBrowser(url);
  if (port !== PREFERRED_PORT) {
    say(
      `Nota: el puerto ${PREFERRED_PORT} está ocupado, así que esta vez se usa el ${port}.`,
      'Los ajustes de la vista que guarda el navegador van por dirección y no se comparten con los del puerto habitual.',
    );
  }
  say('', 'Cierra esta ventana para salir de Hotspotter.');
}

main().catch((err: unknown) => {
  console.error('No se ha podido arrancar Hotspotter:', err instanceof Error ? err.message : String(err));
  console.error('Pulsa Intro para salir.');
  waitForEnter().then(() => process.exit(1));
});
