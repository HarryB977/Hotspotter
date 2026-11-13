import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

// Visual bench (npm run bench, docs/11-test-bench.md): every set under samples/pbr goes through the app's own flow —
// import, automatic structure and family, auto layout 'mixed' with seed 1, the export dialog's checks and export at
// 2048 Unity URP — into samples/_bench/<YYYYMMDD-HHmm>/<set>/, plus an index.html with thumbnails and the checks of
// every set. Tagged @bench: the default e2e run leaves it out (playwright.config.ts grepInvert).

const SAMPLES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples');
const PBR = join(SAMPLES, 'pbr');
const RES = 2048;
const THUMB = 256;
/** Exported maps shown in the index, by file suffix. */
const SHOWN = ['BaseColor', 'Normal', 'Height', 'WearMask'] as const;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// scripts/bench.mjs passes the run folder, so a restarted worker writes into the same one.
const OUT = process.env.HS_BENCH_DIR ?? join(SAMPLES, '_bench', stamp());
const sets = existsSync(PBR)
  ? readdirSync(PBR).filter((n) => statSync(join(PBR, n)).isDirectory()).sort()
  : [];

interface CheckRow { id: string; status: 'ok' | 'warn' | 'error'; message: string; rects: number; points: number }
interface SetSummary {
  set: string;
  ok: boolean;
  error?: string;
  material?: string;
  structure?: { type: string; source: string; pieces: number };
  family?: string;
  rects?: number;
  seconds: number;
  /** Relative to the run folder. */
  maps: { kind: string; full: string; thumb: string }[];
  checks: CheckRow[];
}

// --- PNG (8-bit RGBA, filter 0, as encodePngRgba8 writes them) -----------------------------------------------------

function decodeRgbaPng(buf: Buffer): { w: number; h: number; data: Buffer } {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(data, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, data };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function encodeRgbaPng(w: number, h: number, data: Buffer): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const all = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    let c = 0xffffffff;
    for (const x of all) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, all, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filtered thumbnail, opaque (BaseColor alpha may hold opacity). */
function thumbnail(src: string, dst: string): void {
  const img = decodeRgbaPng(readFileSync(src));
  const f = Math.max(1, Math.round(img.w / THUMB));
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const o = ((y * f + j) * img.w + x * f + i) * 4;
          for (let c = 0; c < 3; c++) sum[c] += img.data[o + c];
        }
      }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(sum[c] / (f * f));
      out[o + 3] = 255;
    }
  }
  writeFileSync(dst, encodeRgbaPng(w, h, out));
}

// --- index.html ----------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Relative URL of a path under the run folder (set names have spaces). */
const href = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');
const STATUS = { ok: 'correcto', warn: 'aviso', error: 'error' } as const;

function writeIndex(): void {
  const summaries: SetSummary[] = readdirSync(OUT)
    .filter((n) => existsSync(join(OUT, n, 'bench.json')))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(OUT, n, 'bench.json'), 'utf8')));
  const badge = (s: 'ok' | 'warn' | 'error', label = STATUS[s]) => `<span class="b ${s}">${esc(label)}</span>`;
  const setStatus = (s: SetSummary) =>
    !s.ok || s.checks.some((c) => c.status === 'error') ? 'error' : s.checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  const rows = summaries.map((s) => {
    const warns = s.checks.filter((c) => c.status !== 'ok').map((c) => `${c.id} (${STATUS[c.status]})`).join(', ');
    return `<tr><td><a href="#${href(s.set)}">${esc(s.set)}</a></td><td>${badge(setStatus(s))}</td>` +
      `<td>${esc(s.structure?.type ?? '—')}</td><td>${esc(s.family ?? '—')}</td><td>${s.rects ?? '—'}</td>` +
      `<td>${s.seconds.toFixed(1)} s</td><td>${esc(s.error ?? (warns || '—'))}</td></tr>`;
  }).join('\n');
  const sections = summaries.map((s) => {
    const maps = s.maps.map((m) =>
      `<figure><a href="${href(m.full)}"><img src="${href(m.thumb)}" alt="${esc(m.kind)}" loading="lazy"></a>` +
      `<figcaption>${esc(m.kind)}</figcaption></figure>`).join('');
    const checks = s.checks.map((c) =>
      `<tr><td>${esc(c.id)}</td><td>${badge(c.status)}</td><td>${c.rects}</td><td>${esc(c.message)}</td></tr>`).join('');
    const meta = [
      s.material && `Material: ${s.material}`,
      s.structure && `Estructura: ${s.structure.type} (${s.structure.pieces} piezas, desde ${s.structure.source})`,
      s.family && `Familia: ${s.family}`,
      s.rects !== undefined && `${s.rects} rectángulos`,
      `${s.seconds.toFixed(1)} s`,
    ].filter(Boolean).map((t) => esc(t as string)).join(' · ');
    return `<section id="${esc(s.set)}"><h2>${esc(s.set)} ${badge(setStatus(s))}</h2><p class="meta">${meta}</p>` +
      (s.error ? `<p class="err">${esc(s.error)}</p>` : '') +
      `<div class="maps">${maps}</div>` +
      (checks ? `<table><thead><tr><th>Comprobación</th><th>Estado</th><th>Rects</th><th>Mensaje</th></tr></thead>` +
        `<tbody>${checks}</tbody></table>` : '') + '</section>';
  }).join('\n');
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Banco de pruebas</title>
<style>
:root { color-scheme: dark; --bg: #121214; --panel: #1b1b1f; --line: #2c2c33; --text: #e4e4e7; --dim: #a1a1aa;
  --ok: #4ade80; --warn: #fbbf24; --error: #f87171; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 13px/1.45 system-ui, sans-serif; }
h1 { font-size: 16px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 0 0 4px; }
.meta, .sub { color: var(--dim); margin: 0 0 10px; }
a { color: #93c5fd; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--dim); font-weight: 500; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 12px; margin: 12px 0; }
.maps { display: flex; flex-wrap: wrap; gap: 8px; }
figure { margin: 0; } figure img { display: block; width: 256px; max-width: 100%; height: auto; image-rendering: auto;
  border: 1px solid var(--line); background: #000; }
figcaption { color: var(--dim); font-size: 12px; margin-top: 2px; }
.b { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 12px; border: 1px solid currentColor; }
.b.ok { color: var(--ok); } .b.warn { color: var(--warn); } .b.error { color: var(--error); }
.err { color: var(--error); }
</style>
</head>
<body>
<h1>Banco de pruebas · ${esc(OUT.split(/[\\/]/).pop()!)}</h1>
<p class="sub">Cada set de samples/pbr con estructura y familia automáticas, layout automático «mixed» con semilla 1 y
exportación Unity URP a ${RES} px. Pulsa una miniatura para ver el mapa completo.</p>
<table><thead><tr><th>Set</th><th>Estado</th><th>Estructura</th><th>Familia</th><th>Rects</th><th>Tiempo</th>
<th>Avisos / errores</th></tr></thead><tbody>
${rows}
</tbody></table>
${sections}
</body>
</html>
`;
  writeFileSync(join(OUT, 'index.html'), html);
}

// --- the bench -----------------------------------------------------------------------------------------------------

/** Waits until the shown atlas was composed from the current document, after the structure analysis. */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const s = window.__hs?.store.getState();
    return !!s?.atlas && !!s.structure && !s.importing && s.atlas.doc === s.doc && s.atlas.structure === s.structure;
  }, undefined, { timeout: 60_000 });

test.describe('visual bench @bench', () => {
  test.skip(sets.length === 0, 'samples/pbr not present');
  // Import, analysis, the 2048 evaluation and the 2048 export of one set.
  test.describe.configure({ timeout: 240_000 });

  for (const set of sets) {
    test(set, async ({ page }) => {
      const t0 = Date.now();
      const dir = join(OUT, set);
      mkdirSync(join(dir, 'thumbs'), { recursive: true });
      const summary: SetSummary = { set, ok: false, seconds: 0, maps: [], checks: [] };
      try {
        await page.goto('/');
        // The app's import: the folder input, as a drop or the Carpeta button does.
        await page.getByTestId('folder-input').setInputFiles(join(PBR, set));
        await settled(page);
        // Auto layout 'mixed', seed 1, as the Layout panel sets it.
        await page.evaluate(() =>
          window.__hs!.store.getState().setLayoutParams({ mode: 'auto', target: 'mixed', seed: 1 }));
        await settled(page);
        // The export dialog's run(): output resolution, forced checks at it, then exportProject (composeInputFor).
        const r = await page.evaluate(async ({ d, res }) => {
          const hs = window.__hs!;
          const store = hs.store;
          store.getState().updateNode<'output'>('output', { resolutionPx: res });
          const results = await store.getState().runEvaluation({ exportResolutionPx: res, force: true });
          if (!results) throw new Error('la evaluación de las comprobaciones falló');
          const written = await hs.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: res, checks: results });
          const s = store.getState();
          const wear = s.doc!.nodes.find((n) => n.type === 'wear')!.params as { family: string };
          return {
            written: written.length,
            material: s.material!.settings.name,
            structure: { type: s.structure!.result.type, source: s.structure!.source, pieces: s.structure!.result.pieceCount },
            family: wear.family,
            rects: s.atlas!.layout.rects.length,
            checks: results.map((c) => ({
              id: c.id, status: c.status, message: c.message, rects: c.rectIds.length, points: c.points?.length ?? 0,
            })),
          };
        }, { d: dir, res: RES });
        expect(r.written).toBe(9);
        Object.assign(summary, {
          material: r.material, structure: r.structure, family: r.family, rects: r.rects, checks: r.checks,
        });
        for (const kind of SHOWN) {
          const name = `${r.material}_${kind}.png`;
          const thumb = `thumbs/${kind}.png`;
          thumbnail(join(dir, name), join(dir, thumb));
          summary.maps.push({ kind, full: `${set}/${name}`, thumb: `${set}/${thumb}` });
        }
        summary.ok = true;
      } catch (e) {
        summary.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
        throw e;
      } finally {
        summary.seconds = (Date.now() - t0) / 1000;
        writeFileSync(join(dir, 'bench.json'), JSON.stringify(summary, null, 2));
        writeIndex();
      }
      // Pass criterion: warnings are fine, an error is not.
      expect(summary.checks.filter((c) => c.status === 'error')).toEqual([]);
    });
  }
});
