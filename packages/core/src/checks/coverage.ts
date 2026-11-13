import { WEAR_FAMILIES } from '../wear/params';
import { evalGeometry, wearSkipReason } from './geometry';
import type { EvalRect } from './geometry';
import type { CheckContext, CheckResult } from './index';

/** Longest stretch of perimeter (metres) allowed without wear. */
export const COVERAGE_GAP_M = 0.02;

interface Sample { covered: boolean; x: number; y: number }

/**
 * Perimeter samples of one rect, walked clockwise (top, right, bottom, left), one per evaluation px. A sample is
 * covered when any pixel of the guaranteed rim band (from the visible edge inwards, max(rim, 1 px) deep) has wear.
 */
function perimeter(ctx: CheckContext, r: EvalRect, ppm: number): Sample[] {
  const { width: W, height: H, rectId, wearMask } = ctx.maps;
  const id = r.index + 1;
  const depth = Math.max(r.rimM * ppm, 1);
  const xa = Math.max(0, Math.ceil(r.x0 - 0.5)), xb = Math.min(W - 1, Math.floor(r.x1 - 0.5));
  const ya = Math.max(0, Math.ceil(r.y0 - 0.5)), yb = Math.min(H - 1, Math.floor(r.y1 - 0.5));
  if (xa > xb || ya > yb) return [];
  // Band rows / columns along each side; at least the first pixel inside the visible edge.
  const topEnd = Math.min(yb, Math.max(ya, Math.floor(r.y0 + depth - 0.5)));
  const botStart = Math.max(ya, Math.min(yb, Math.ceil(r.y1 - depth - 0.5)));
  const leftEnd = Math.min(xb, Math.max(xa, Math.floor(r.x0 + depth - 0.5)));
  const rightStart = Math.max(xa, Math.min(xb, Math.ceil(r.x1 - depth - 0.5)));
  const hit = (x: number, y: number) => rectId[y * W + x] === id && wearMask[y * W + x] > 0;
  const column = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) if (hit(x, y)) return true;
    return false;
  };
  const row = (y: number, x0: number, x1: number) => {
    for (let x = x0; x <= x1; x++) if (hit(x, y)) return true;
    return false;
  };
  const out: Sample[] = [];
  for (let x = xa; x <= xb; x++) out.push({ covered: column(x, ya, topEnd), x: x + 0.5, y: ya + 0.5 });
  for (let y = ya; y <= yb; y++) out.push({ covered: row(y, rightStart, xb), x: xb + 0.5, y: y + 0.5 });
  for (let x = xb; x >= xa; x--) out.push({ covered: column(x, botStart, yb), x: x + 0.5, y: yb + 0.5 });
  for (let y = yb; y >= ya; y--) out.push({ covered: row(y, xa, leftEnd), x: xa + 0.5, y: y + 0.5 });
  return out;
}

/** Middle points of the uncovered runs longer than `minSamples`, around the closed perimeter. */
function gaps(samples: Sample[], minSamples: number): [number, number][] {
  const n = samples.length;
  const start = samples.findIndex((s) => s.covered);
  if (start < 0) return n > minSamples ? [[samples[0].x, samples[0].y]] : [];
  const out: [number, number][] = [];
  let run = 0;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (!samples[i].covered) {
      run++;
      continue;
    }
    if (run > minSamples) {
      const mid = samples[(start + k - Math.ceil(run / 2) + n) % n];
      out.push([mid.x, mid.y]);
    }
    run = 0;
  }
  return out;
}

/**
 * Edge coverage: with a minimum edge (minEdgeM > 0) every rect keeps a worn rim. Walks each perimeter just inside the
 * visible edge and warns when a stretch longer than 2 cm has no wear.
 */
export function checkCoverage(ctx: CheckContext): CheckResult {
  const { maps, wear, layout } = ctx;
  const base = { id: 'coverage' as const, rectIds: [] as string[] };
  const skip = wearSkipReason(wear, maps.wearMask, maps.width * maps.height, WEAR_FAMILIES[wear.family].loses);
  if (skip) return { ...base, status: 'ok', message: skip };
  if (!(wear.minEdgeM > 0)) {
    return { ...base, status: 'ok', message: 'Sin borde mínimo: no se pide un borde dañado continuo.' };
  }
  const geo = evalGeometry(layout, wear, maps.width);
  const minSamples = COVERAGE_GAP_M * geo.ppm;
  const rectIds: string[] = [];
  const points: [number, number][] = [];
  for (const r of geo.rects) {
    if (r.rimM <= 0) continue;
    const found = gaps(perimeter(ctx, r, geo.ppm), minSamples);
    if (found.length === 0) continue;
    rectIds.push(r.id);
    points.push(...found);
  }
  if (rectIds.length === 0) {
    return { ...base, status: 'ok', message: 'Todos los bordes tienen desgaste continuo.' };
  }
  return {
    ...base, status: 'warn', rectIds, points,
    message: `${rectIds.length === 1 ? 'Un rectángulo tiene' : `${rectIds.length} rectángulos tienen`} ` +
      `tramos de borde de más de ${COVERAGE_GAP_M * 100} cm sin desgaste. Sube el borde mínimo o la intensidad.`,
  };
}
