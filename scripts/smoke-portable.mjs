// Smoke test of the real portable build: builds it, runs hotspotter.exe and checks the server,
// the second-copy path and the different-version path. Every process it starts is killed on exit.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'dist', 'portable', 'Hotspotter', 'hotspotter.exe');
const { version } = JSON.parse(await readFile(join(root, 'apps', 'server', 'package.json'), 'utf8'));

const children = [];
const servers = [];
let dataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ok  ${msg}`);
}

function start(env, stdin = 'ignore') {
  const child = spawn(exe, [], {
    env: { ...process.env, HOTSPOTTER_NO_BROWSER: '1', HOTSPOTTER_DATA_DIR: dataDir, ...env },
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.output = '';
  child.stdout.on('data', (d) => (child.output += d));
  child.stderr.on('data', (d) => (child.output += d));
  child.exited = new Promise((r) => child.once('exit', (code) => r(code)));
  children.push(child);
  return child;
}

async function waitFor(what, fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exitWithin(child, ms) {
  return Promise.race([child.exited, sleep(ms).then(() => 'timeout')]);
}

function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  // child.kill may not reach a process tree on Windows; taskkill is the fallback.
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

let failed = false;
try {
  console.log('[smoke] npm run portable');
  const build = spawnSync('npm', ['run', 'portable'], { cwd: root, stdio: 'inherit', shell: true });
  check(build.status === 0, 'portable build succeeds');
  check(existsSync(exe), 'hotspotter.exe exists');

  dataDir = await mkdtemp(join(tmpdir(), 'hs-smoke-'));
  const lock = join(dataDir, 'instance.json');

  console.log('[smoke] first copy');
  const first = start({});
  const info = await waitFor('instance.json', async () => JSON.parse(await readFile(lock, 'utf8')));
  check(info.pid === first.pid, `lock file written by the exe (port ${info.port})`);
  const base = `http://127.0.0.1:${info.port}`;
  const health = await waitFor('health', async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    return body.version === version ? body : undefined;
  });
  check(health.ok === true, `/api/health reports version ${version}`);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check(page.ok && html.includes('<title>Hotspotter</title>'), 'GET / serves index.html');
  check((await fetch(`${base}/api/update`)).ok, '/api/update is mounted');

  console.log('[smoke] second copy, same version');
  const second = start({});
  const code = await exitWithin(second, 15_000);
  check(code === 0, 'second copy exits on its own');
  check(second.output.includes('ya estaba abierto'), 'second copy points to the running one');
  check(!second.output.includes('Cierra esta ventana'), 'second copy does not start a server');
  check(JSON.parse(await readFile(lock, 'utf8')).pid === first.pid, 'lock file still belongs to the first copy');

  kill(first);
  await exitWithin(first, 5_000);

  console.log('[smoke] other version running');
  const fake = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: '0.0.1' }));
  });
  servers.push(fake);
  const fakePort = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
  await writeFile(lock, JSON.stringify({ port: fakePort, version: '0.0.1', pid: 1 }), 'utf8');
  const other = start({}, 'pipe');
  await waitFor('other-version message', async () => other.output.includes('Hay otra versión de Hotspotter abierta (0.0.1)'));
  check(other.exitCode === null, 'waits for Enter before exiting');
  other.stdin.write('\n');
  check((await exitWithin(other, 10_000)) === 0, 'exits after Enter');

  console.log('[smoke] PASS');
} catch (err) {
  failed = true;
  console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  for (const c of children) if (c.output) console.error(`--- output of pid ${c.pid} ---\n${c.output}`);
} finally {
  for (const c of children) kill(c);
  for (const s of servers) s.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
