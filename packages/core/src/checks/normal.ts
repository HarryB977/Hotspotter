import type { CheckContext, CheckResult } from './index';

/** Macro slope (m/m) above which the normal must lean down the slope. */
export const STEEP_SLOPE = 0.2;
/** Fraction of steep pixels allowed to point against the slope. */
export const MAX_AGAINST = 0.005;
const MAX_POINTS = 32;

/**
 * Normal coherence (R40, R41): Sobel on the macro height and on the material's own relief (final height − macro
 * height), y up as normalFromHeight.wgsl. The material slope is the larger of that relief's and the detail normal's
 * (|n_mat.xy| / n_mat.z, from matNormal): a normal map can carry much more relief than its height map. As in
 * normalFromHeight.wgsl, the detail normal fades towards (0, 0, 1) by wearMask (only when it is full size: a 1 × 1
 * placeholder means no wear). Only pixels where the macro slope exceeds 0.2 AND beats the material slope count:
 * there the final normal must satisfy dot(n.xy, −grad macro) ≥ 0. Where the material relief is steeper, the normal
 * rightly follows the material and is not judged. More than 0.5 % of the counted pixels failing is an error.
 */
export function checkNormal(ctx: CheckContext): CheckResult {
  const { width: w, height: h, macroHeight, heightM, matNormal, normal, rectId, wearMask } = ctx.maps;
  const fade = wearMask.length === w * h;
  /** Slope |d.xy| / d.z of the detail normal at pixel i, faded by the wear like normalFromHeight.wgsl. */
  const detailSlope = (i: number): number => {
    let dx = matNormal[i * 4], dy = matNormal[i * 4 + 1], dz = matNormal[i * 4 + 2];
    if (fade) {
      const l = Math.hypot(dx, dy, dz) || 1;
      const t = wearMask[i] / 255;
      dx = (dx / l) * (1 - t);
      dy = (dy / l) * (1 - t);
      dz = (dz / l) * (1 - t) + t;
    }
    // Normalising the mixed vector does not change |xy| / z.
    return Math.hypot(dx, dy) / Math.max(dz, 1e-3);
  };
  const mpp = ctx.layout.worldWidthM / w;
  const at = (x: number, y: number) => Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x));
  /** Sobel gradient (m/m, y up) of `f` at (x, y). */
  const grad = (f: (i: number) => number, x: number, y: number): [number, number] => {
    const F = (dx: number, dy: number) => f(at(x + dx, y + dy));
    const sx = (F(1, -1) + 2 * F(1, 0) + F(1, 1)) - (F(-1, -1) + 2 * F(-1, 0) + F(-1, 1));
    const sr = (F(-1, 1) + 2 * F(0, 1) + F(1, 1)) - (F(-1, -1) + 2 * F(0, -1) + F(1, -1));
    return [sx / (8 * mpp), -sr / (8 * mpp)];
  };
  const macro = (i: number) => macroHeight[i];
  const relief = (i: number) => heightM[i] - macroHeight[i];
  let steep = 0, against = 0;
  const points: [number, number][] = [];
  const rectIds = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [gx, gy] = grad(macro, x, y);
      const g = Math.hypot(gx, gy);
      if (g <= STEEP_SLOPE) continue;
      const i = y * w + x;
      const [rx, ry] = grad(relief, x, y);
      const matSlope = Math.max(Math.hypot(rx, ry), detailSlope(i));
      if (g <= matSlope) continue;
      steep++;
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
      message: `En el ${pct} % de las zonas donde manda la pendiente del bisel o del desgaste la normal apunta ` +
        `al revés que el relieve (máximo ` +
        `${(MAX_AGAINST * 100).toLocaleString('es-ES')} %): la luz se verá mal ahí.`,
    };
  }
  return { id: 'normal', status: 'ok', rectIds: [], message: 'La normal sigue el relieve.' };
}
