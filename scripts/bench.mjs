// npm run bench: runs the visual bench (apps/web/e2e/bench.spec.ts, @bench) over samples/pbr and opens its index.html.
// Output: samples/_bench/<YYYYMMDD-HHmm>/ (never committed). Exits with Playwright's exit code.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
const out = join(root, 'samples', '_bench', stamp);

const run = spawnSync('npx', ['playwright', 'test', '--grep', '@bench', '--workers=1', '--reporter=line'], {
  cwd: join(root, 'apps', 'web'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, HS_BENCH: '1', HS_BENCH_DIR: out },
});
const code = run.status ?? 1;

const index = join(out, 'index.html');
if (!existsSync(index)) {
  console.log('No se generó index.html (¿falta samples/pbr?).');
} else {
  console.log(`Índice: ${index}`);
  // Best effort: no browser (CI, a headless box) must not fail the bench.
  if (!process.env.CI) {
    try {
      const [cmd, args] = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', `"${index}"`]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [index]];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
      child.on('error', () => console.log('No se pudo abrir el navegador; abre el índice a mano.'));
      child.unref();
    } catch {
      console.log('No se pudo abrir el navegador; abre el índice a mano.');
    }
  }
}
process.exit(code);
