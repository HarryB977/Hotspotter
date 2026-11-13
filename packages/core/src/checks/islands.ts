import { WEAR_FAMILIES } from '../wear/params';
import { edgeDistPx, evalGeometry, wearSkipReason } from './geometry';
import type { CheckContext, CheckResult } from './index';

/** wearMask byte above which a pixel counts as lost material. */
const LOST = 127;

/**
 * Islands: 8-connected patches of lost material (wearMask > 127) inside one rect that never reach the edge wear strip
 * (distance to the visible edge < wEff). Each one is a loose speck; `points` are their centroids.
 */
export function checkIslands(ctx: CheckContext): CheckResult {
  const { maps, wear, layout } = ctx;
  const { width: W, height: H, rectId, wearMask } = maps;
  const base = { id: 'islands' as const, rectIds: [] as string[] };
  const skip = wearSkipReason(wear, wearMask, W * H, WEAR_FAMILIES[wear.family].loses);
  if (skip) return { ...base, status: 'ok', message: skip };
  const geo = evalGeometry(layout, wear, W);
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
    const stripPx = r.wEffM * geo.ppm;
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
    if (touches) continue;
    rectIds.add(r.id);
    points.push([sx / n + 0.5, sy / n + 0.5]);
  }
  if (points.length === 0) return { ...base, status: 'ok', message: 'No hay roturas sueltas lejos del borde.' };
  return {
    ...base, status: 'warn', rectIds: [...rectIds], points,
    message: `${points.length === 1 ? 'Hay una rotura suelta' : `Hay ${points.length} roturas sueltas`} ` +
      'lejos del borde, como motas. Baja la intensidad o revisa la máscara.',
  };
}
