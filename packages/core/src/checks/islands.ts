import { WEAR_FAMILIES } from '../wear/params';
import { edgeDistPx, evalGeometry, wearSkipReason } from './geometry';
import type { CheckContext, CheckResult } from './index';

/** wearMask byte from which a pixel counts as visibly lost (R38). */
const LOST = 128;

/**
 * Islands (R38, with its beyond-wEff fallback): patches of visibly lost wear (wearMask ≥ 128) inside one rect that never
 * reach the edge-wear strip (no pixel closer to the visible edge than wEff). Gaps up to bandM are bridged before
 * labelling, as if the mask were dilated by bandM / 2: two lost pixels of the same rect join when their centres are at
 * most bandM · ppm + 1 px apart (edge-to-edge gap ≤ bandM), and never less than 8-connected. No area cap. Each island
 * is a loose speck; `points` are their centroids. Loose specks inside the strip are not flagged (deferred, docs/09).
 */
export function checkIslands(ctx: CheckContext): CheckResult {
  const { maps, wear, layout } = ctx;
  const { width: W, height: H, rectId, wearMask } = maps;
  const base = { id: 'islands' as const, rectIds: [] as string[] };
  const skip = wearSkipReason(wear, wearMask, W * H, WEAR_FAMILIES[wear.family].loses);
  if (skip) return { ...base, status: 'ok', message: skip };
  const geo = evalGeometry(layout, wear, W);
  const reach = Math.max(wear.bandM * geo.ppm + 1, Math.SQRT2);
  const k = Math.floor(reach);
  const offsets: [number, number][] = [];
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) if ((dx || dy) && dx * dx + dy * dy <= reach * reach) offsets.push([dx, dy]);
  }
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const rectIds = new Set<string>();
  const points: [number, number][] = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (seen[i0] || wearMask[i0] < LOST) continue;
    const id = rectId[i0];
    const r = geo.rects[id - 1];
    seen[i0] = 1;
    if (!r) continue;
    // A rect without edge wear (wEff 0) has no strip: every patch on it is loose.
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
      for (const [dx, dy] of offsets) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const j = yy * W + xx;
        if (seen[j] || wearMask[j] < LOST || rectId[j] !== id) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    if (touches) continue;
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
