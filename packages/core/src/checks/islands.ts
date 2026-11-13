import { WEAR_FAMILIES } from '../wear/params';
import { edgeDistPx, evalGeometry, wearSkipReason } from './geometry';
import type { CheckContext, CheckResult } from './index';

/** wearMask byte above which a pixel counts as worn. */
const LOST = 0;

/**
 * Islands (R36): 8-connected patches of wear (wearMask > 0) inside one rect that never reach the guaranteed rim band
 * (no pixel closer to the visible edge than 1.6 · rimM + 1 px; the rim's irregular inner contour reaches 1.6 · rimM).
 * Only patches smaller than (sizeM / 2)² count: a bigger detached patch is a break of its own. Each island is a loose
 * speck; `points` are their centroids.
 */
export function checkIslands(ctx: CheckContext): CheckResult {
  const { maps, wear, layout } = ctx;
  const { width: W, height: H, rectId, wearMask } = maps;
  const base = { id: 'islands' as const, rectIds: [] as string[] };
  const skip = wearSkipReason(wear, wearMask, W * H, WEAR_FAMILIES[wear.family].loses);
  if (skip) return { ...base, status: 'ok', message: skip };
  const geo = evalGeometry(layout, wear, W);
  const maxAreaPx = (0.5 * wear.sizeM * geo.ppm) ** 2;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const rectIds = new Set<string>();
  const points: [number, number][] = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (seen[i0] || wearMask[i0] <= LOST) continue;
    const id = rectId[i0];
    const r = geo.rects[id - 1];
    seen[i0] = 1;
    if (!r) continue;
    // A rect without a rim (no edge wear) cannot hold a connected chip: every patch on it is loose.
    const stripPx = 1.6 * r.rimM * geo.ppm + 1;
    let top = 0;
    stack[top++] = i0;
    let touches = false, n = 0, sx = 0, sy = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % W, y = (i - x) / W;
      n++;
      sx += x;
      sy += y;
      if (!touches && edgeDistPx(r, x, y) < stripPx) touches = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (seen[j] || wearMask[j] <= LOST || rectId[j] !== id) continue;
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }
    // Detached chips the size of a break are real damage (the loss pass breaks anywhere within wEff); only
    // patches smaller than (sizeM / 2)² are loose specks.
    if (touches || n >= maxAreaPx) continue;
    rectIds.add(r.id);
    points.push([sx / n + 0.5, sy / n + 0.5]);
  }
  if (points.length === 0) return { ...base, status: 'ok', message: 'No hay roturas sueltas separadas del borde.' };
  return {
    ...base, status: 'warn', rectIds: [...rectIds], points,
    message: `${points.length === 1 ? 'Hay una rotura suelta' : `Hay ${points.length} roturas sueltas`} ` +
      'separadas del borde, como motas. Baja la intensidad o revisa la máscara.',
  };
}
