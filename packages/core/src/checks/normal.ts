import type { CheckContext, CheckResult } from './index';

/** Macro slope (m/m) above which the normal must lean down the slope. */
export const STEEP_SLOPE = 0.2;
/** Fraction of steep pixels allowed to point against the slope. */
export const MAX_AGAINST = 0.005;
const MAX_POINTS = 32;

/**
 * Normal coherence, the same definition as the Task 9 e2e test: Sobel on the macro height (y up, as
 * normalFromHeight.wgsl), and where the slope exceeds 0.2 the final normal must satisfy dot(n.xy, −grad) ≥ 0. More
 * than 0.5 % of steep pixels failing is an error.
 */
export function checkNormal(ctx: CheckContext): CheckResult {
  const { width: w, height: h, macroHeight, normal, rectId } = ctx.maps;
  const mpp = ctx.layout.worldWidthM / w;
  const H = (x: number, y: number) =>
    macroHeight[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  let steep = 0, against = 0;
  const points: [number, number][] = [];
  const rectIds = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const sr = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      const gx = sx / (8 * mpp), gy = -sr / (8 * mpp);
      if (Math.hypot(gx, gy) <= STEEP_SLOPE) continue;
      steep++;
      const i = y * w + x;
      const nx = (normal[i * 4] / 255) * 2 - 1, ny = (normal[i * 4 + 1] / 255) * 2 - 1;
      if (nx * -gx + ny * -gy >= 0) continue;
      against++;
      if (points.length < MAX_POINTS) points.push([x + 0.5, y + 0.5]);
      const r = ctx.layout.rects[rectId[i] - 1];
      if (r) rectIds.add(r.id);
    }
  }
  const frac = steep > 0 ? against / steep : 0;
  const pct = (frac * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  if (frac > MAX_AGAINST) {
    return {
      id: 'normal', status: 'error', rectIds: [...rectIds], points,
      message: `En el ${pct} % de las zonas inclinadas la normal apunta al revés que el relieve (máximo ` +
        `${(MAX_AGAINST * 100).toLocaleString('es-ES')} %): la luz se verá mal ahí.`,
    };
  }
  return { id: 'normal', status: 'ok', rectIds: [], message: 'La normal sigue el relieve.' };
}
