import { createRng } from './rng';
import { pxPerMetre } from './layout';
import type { HotspotLayout, HotspotRect } from './layout';
import type { MaterialPeriod } from './period';
import { rectRotations } from './orientation';
import type { MaterialOrientation } from './orientation';

export interface RectPlacement {
  rectId: string;
  /** Material-space metres at the rect's bottom-left corner. */
  originM: [number, number];
  rotate90: boolean;
}

export interface PlacementOptions {
  /** 0..1 */
  variation: number;
  seed: number;
  materialAllowsRotation: boolean;
  tileSizeM: [number, number];
  orientation: MaterialOrientation;
}

/**
 * Picks a material origin and optional 90 degree rotation for every rect.
 * One rng stream, three draws per rect in rect order (x, y, rotation), so the
 * result is deterministic for a given seed and layout.
 */
export function placeMaterial(
  l: HotspotLayout,
  p: MaterialPeriod,
  o: PlacementOptions,
): RectPlacement[] {
  const rng = createRng(o.seed);
  const ppm = pxPerMetre(l);
  const oriented = rectRotations(l, o.orientation);
  // Origins stay in material axes: the rotated corner maps to originM, so joints on p.x / p.y hold.
  const axisOrigin = (
    period: number | null, phase: number, tileM: number, globalM: number, draw: number,
  ): number => {
    if (period === null) return globalM + o.variation * draw * tileM;
    const kMax = Math.round(o.variation * (tileM / period) * 4);
    return phase + Math.floor(draw * (kMax + 1)) * period;
  };

  return l.rects.map((r) => {
    const dx = rng.next();
    const dy = rng.next();
    const dr = rng.next();
    const globalX = r.x / ppm;
    const globalY = (l.heightPx - (r.y + r.h)) / ppm;
    const canRotate = o.orientation.rule === 'fixed' && r.allowRotation && o.materialAllowsRotation && o.variation > 0;
    return {
      rectId: r.id,
      originM: [
        axisOrigin(p.x, p.phaseX, o.tileSizeM[0], globalX, dx),
        axisOrigin(p.y, p.phaseY, o.tileSizeM[1], globalY, dy),
      ],
      rotate90: (oriented.get(r.id) ?? false) !== (canRotate && dr < 0.5 * o.variation),
    };
  });
}

/**
 * Maps a continuous atlas pixel coordinate to material-space metres.
 * Intended to be mirrored verbatim in WGSL.
 *
 * `px` is top-left origin; callers pass pixel centres as (x + 0.5, y + 0.5).
 * With ppm = pxPerMetre(l), rect-local metres (x right, y UP) measured from
 * the rect's bottom-left corner:
 *   lx = (px.x - r.x) / ppm
 *   ly = (r.y + r.h - px.y) / ppm
 * If pl.rotate90: (lx, ly) -> (ly, -lx).
 * Result = pl.originM + (lx, ly). The rect's bottom-left corner
 * (px = [r.x, r.y + r.h]) therefore maps exactly to originM.
 */
export function atlasPxToMaterialM(
  l: HotspotLayout,
  r: HotspotRect,
  pl: RectPlacement,
  px: [number, number],
): [number, number] {
  const ppm = pxPerMetre(l);
  let lx = (px[0] - r.x) / ppm;
  let ly = (r.y + r.h - px[1]) / ppm;
  if (pl.rotate90) [lx, ly] = [ly, -lx];
  return [pl.originM[0] + lx, pl.originM[1] + ly];
}
