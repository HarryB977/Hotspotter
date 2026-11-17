// Builds the portable release: dist/portable/Hotspotter/{hotspotter.exe, web/} and dist/Hotspotter-<version>-win64.zip.
// hotspotter.exe is a Node Single Executable Application (https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html).
// The optional read-only GitHub token comes from HOTSPOTTER_READ_TOKEN and is never printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const work = join(dist, 'portable-build');
const outDir = join(dist, 'portable', 'Hotspotter');
const exe = join(outDir, 'hotspotter.exe');

const { version } = JSON.parse(readFileSync(join(root, 'apps', 'server', 'package.json'), 'utf8'));
const zip = join(dist, `Hotspotter-${version}-win64.zip`);
const token = process.env.HOTSPOTTER_READ_TOKEN ?? '';

const step = (msg) => console.log(`\n[portable] ${msg}`);
const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal ?? r.error?.message})`);
}

try {
  step(`Hotspotter ${version} (${token ? 'with' : 'without'} update token)`);

  step('npm run build');
  run('npm', ['run', 'build'], { shell: true });

  rmSync(work, { recursive: true, force: true });
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`cannot clear ${outDir}; close any running hotspotter.exe (${err.message})`);
  }
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  step('esbuild: launcher -> CommonJS bundle');
  const bundle = join(work, 'launcher.cjs');
  await build({
    entryPoints: [join(root, 'apps', 'server', 'src', 'launcher.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'none',
    define: {
      __HOTSPOTTER_VERSION__: JSON.stringify(version),
      __HOTSPOTTER_GH_TOKEN__: JSON.stringify(token),
    },
    // config.ts reads import.meta.url only in its dev fallback, which the version define makes dead code.
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'warning',
  });

  step('SEA blob');
  const blob = join(work, 'sea-prep.blob');
  const seaConfig = join(work, 'sea-config.json');
  writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig]);

  step('hotspotter.exe');
  copyFileSync(process.execPath, exe);
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  step('web/');
  const webDist = join(root, 'apps', 'web', 'dist');
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`${webDist} has no index.html`);
  cpSync(webDist, join(outDir, 'web'), { recursive: true });

  step('zip');
  rmSync(zip, { force: true });
  // Windows' bsdtar writes zip archives; Git Bash's GNU tar may shadow it on PATH, so call it by full path.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', join(dist, 'portable'), 'Hotspotter'], { stdio: 'inherit' });

  // The bundle and blob carry the token in clear text; only the exe should keep it.
  rmSync(work, { recursive: true, force: true });

  step('done');
  console.log(`  ${exe}  ${mb(exe)}`);
  console.log(`  ${zip}  ${mb(zip)}`);
} catch (err) {
  rmSync(work, { recursive: true, force: true });
  console.error(`\n[portable] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
