import type { HotspotLayout } from '../layout';
import type { HotspotFit } from './match';
import type { ShapeFace } from './shapes';

/**
 * How much a fit stretches the material on a face: face metres / rect metres along the face's u (width) and
 * v (height) axes, so 1 is the material at its real size. Each face axis is compared with the rect side it maps to
 * (turned when `fit.rotated`), in metres at `worldWidthM / widthPx`. A face axis along the fit's tiling axis repeats
 * in world metres and counts as 1.
 *
 * Throws a RangeError when the fit's rect is not in the layout.
 */
export function faceBrickScale(face: ShapeFace, fit: HotspotFit, layout: HotspotLayout): [number, number] {
  const rect = layout.rects.find((r) => r.id === fit.rectId);
  if (!rect) throw new RangeError(`faceBrickScale: rect ${fit.rectId} is not in the layout`);
  const mPerPx = layout.worldWidthM / layout.widthPx;
  // Rect metres along atlas u (0) and atlas v (1).
  const rectM = [rect.w * mPerPx, rect.h * mPerPx];
  // Same rule as the matcher: a full-width tileU strip tiles along u, otherwise the strip is tileV.
  const tiledAxis = !fit.tiled ? null : rect.tileU && rect.x <= 0 && rect.x + rect.w >= layout.widthPx ? 0 : 1;
  // Turned, face width runs along atlas v and face height along atlas u.
  const [axisU, axisV] = fit.rotated ? [1, 0] : [0, 1];
  const ratio = (faceM: number, axis: number) => (axis === tiledAxis ? 1 : faceM / rectM[axis]);
  return [ratio(face.quad.widthM, axisU), ratio(face.quad.heightM, axisV)];
}
