import { rectSizeM } from '../layout';
import type { HotspotLayout, HotspotRect } from '../layout';
import { createRng } from '../rng';
import type { Rng } from '../rng';

/** A planar face in its own axes: u = width (right), v = height (up), metres. */
export interface FaceQuad {
  widthM: number;
  heightM: number;
  useOn: 'walls' | 'floors' | 'ceilings';
}

export type FaceUv = [[number, number], [number, number], [number, number], [number, number]];

export interface HotspotFit {
  rectId: string;
  /** The rect is turned 90 degrees on the face: face width runs up the rect's V, face height back along its U. */
  rotated: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  /** UV (0..1, V up, engine convention) of the face corners (0,0) (w,0) (w,h) (0,h). */
  uv: FaceUv;
  /**
   * The rect is a tiling strip (tileU or tileV spanning the atlas) and repeats along that axis in world metres
   * instead of stretching; uv may exceed 1 along that axis only. The cross axis is stretched onto the strip.
   */
  tiled: boolean;
  /** Selection score of the pick (lower is better): the patch score, or the strip's cross-size error. */
  score: number;
}

/** ProBuilder's default Scale Tolerance (±25 %), as a log ratio with its epsilon. */
const MAX_LOG = Math.log(1 + 0.25) + 1e-5;
/** Scores closer than this are a tie, broken by the seeded RNG. */
const TIE_EPSILON = 1e-9;

type TileAxis = 'u' | 'v' | null;

interface Candidate {
  rect: HotspotRect;
  rotated: boolean;
  axis: TileAxis;
  /** ProBuilder's Score: 2·|ln aspect ratio| + 0.5·|ln area ratio|. */
  score: number;
  /** Within the scale tolerance on both face axes. */
  inTolerance: boolean;
  /** Strip only: |ln(cross face / cross strip)| when within the tolerance, else null. */
  stripError: number | null;
}

/** Tiling axis in rect space; a strip must span the whole atlas on that axis (as ProBuilder's GetTilingAxis). */
function tileAxis(l: HotspotLayout, r: HotspotRect): TileAxis {
  if (r.tileU && r.x <= 0 && r.x + r.w >= l.widthPx) return 'u';
  if (r.tileV && r.y <= 0 && r.y + r.h >= l.heightPx) return 'v';
  return null;
}

const usableSize = (m: { w: number; h: number }) => Number.isFinite(m.w) && Number.isFinite(m.h) && m.w > 0 && m.h > 0;

const lerp = (a: number, b: number, f: number) => (1 - f) * a + f * b;

/** Lowest-valued candidate; exact ties go to the seeded RNG. */
function pickBest(cands: Candidate[], value: (c: Candidate) => number, rng: Rng): { c: Candidate; value: number } {
  const finite = cands.filter((c) => Number.isFinite(value(c)));
  if (finite.length === 0) throw new RangeError('matchHotspot: no rect has a finite score for this face');
  const best = Math.min(...finite.map(value));
  const tied = finite.filter((c) => value(c) - best <= TIE_EPSILON);
  const c = tied.length === 1 ? tied[0] : rng.pick(tied);
  return { c, value: value(c) };
}

/**
 * Picks the hotspot rect for a face and maps the face onto it as ProBuilder's Hotspot UV does
 * (`HotspotTexture.FindBestPatch` + `HotspotMapper.Map`, decision 79 / R46):
 * 1. rects within ±25 % of the face on both axes, best `2·|ln(aspectFace/aspectRect)| + 0.5·|ln(areaFace/areaRect)|`;
 * 2. else tiling strips whose cross size is within ±25 %, least cross error;
 * 3. else the closest rect overall by the same score.
 * Rects whose `useOn` excludes the face are dropped first, unless none remains. Each rect is tried unrotated and,
 * with `allowRotation`, turned 90 degrees. Ties and mirroring (only on the axes the rect allows) come from the
 * seeded RNG. The face is stretched onto the rect, shrunk by `inset` px per side, except that a strip repeats in
 * world metres along its tiling axis (and is not inset there).
 *
 * `rotations` (material turned 90 degrees inside each rect) does not change the pick: engines do not see the
 * material's orientation, and the 3D view must show what they would do.
 *
 * Throws a RangeError on a face without positive finite size and on a layout with no rect of positive finite size.
 */
export function matchHotspot(
  face: FaceQuad,
  layout: HotspotLayout,
  rotations: ReadonlyMap<string, boolean>,
  opts?: { seed?: number },
): HotspotFit {
  void rotations;
  const { widthM: fw, heightM: fh } = face;
  if (!(Number.isFinite(fw) && Number.isFinite(fh) && fw > 0 && fh > 0)) {
    throw new RangeError(`matchHotspot: face size must be positive and finite (got ${fw} x ${fh} m)`);
  }

  const usable = layout.rects.filter((r) => usableSize(rectSizeM(layout, r)));
  if (usable.length === 0) throw new RangeError('matchHotspot: layout has no usable rect');
  const allowed = usable.filter((r) => r.useOn === 'any' || r.useOn === face.useOn);
  const pool = allowed.length > 0 ? allowed : usable;

  // Log space throughout, so extreme but finite sizes never overflow to Infinity or NaN.
  const lnFw = Math.log(fw), lnFh = Math.log(fh);
  const candidates: Candidate[] = [];
  for (const rect of pool) {
    const m = rectSizeM(layout, rect);
    const axis = tileAxis(layout, rect);
    for (const rotated of rect.allowRotation ? [false, true] : [false]) {
      // Log of the face / rect size ratio on each face axis.
      const dx = lnFw - Math.log(rotated ? m.h : m.w);
      const dy = lnFh - Math.log(rotated ? m.w : m.h);
      let stripError: number | null = null;
      if (axis) {
        // The strip repeats along face u when its tiling axis and the rotation agree; the cross axis is the other.
        const err = Math.abs((axis === 'u') !== rotated ? dy : dx);
        if (err <= MAX_LOG) stripError = err;
      }
      candidates.push({
        rect, rotated, axis, stripError,
        score: 2 * Math.abs(dx - dy) + 0.5 * Math.abs(dx + dy),
        inTolerance: Math.abs(dx) <= MAX_LOG && Math.abs(dy) <= MAX_LOG,
      });
    }
  }

  const rng = createRng(opts?.seed ?? 0);
  const inTolerance = candidates.filter((c) => c.inTolerance);
  const strips = candidates.filter((c) => c.stripError !== null);
  const { c: pick, value: score } = inTolerance.length > 0
    ? pickBest(inTolerance, (c) => c.score, rng)
    : strips.length > 0
      ? pickBest(strips, (c) => c.stripError as number, rng)
      : pickBest(candidates, (c) => c.score, rng);
  const { rect, rotated, axis } = pick;
  const mirrorX = rect.allowMirrorX && rng.next() < 0.5;
  const mirrorY = rect.allowMirrorY && rng.next() < 0.5;

  // Rect bounds in UV, V up, shrunk by the inset (at most a quarter of the rect) except along the tiling axis.
  let u0 = rect.x / layout.widthPx;
  let u1 = (rect.x + rect.w) / layout.widthPx;
  let v0 = 1 - (rect.y + rect.h) / layout.heightPx;
  let v1 = 1 - rect.y / layout.heightPx;
  if (rect.inset > 0) {
    const du = axis === 'u' ? 0 : Math.min(rect.inset / layout.widthPx, (u1 - u0) * 0.25);
    const dv = axis === 'v' ? 0 : Math.min(rect.inset / layout.heightPx, (v1 - v0) * 0.25);
    [u0, u1, v0, v1] = [u0 + du, u1 - du, v0 + dv, v1 - dv];
  }
  const m = rectSizeM(layout, rect);

  const corners: [number, number][] = [[0, 0], [fw, 0], [fw, fh], [0, fh]];
  const uv = corners.map(([x, y]): [number, number] => {
    // Face point in rect axes, from the rect's bottom-left: turning swaps the axes, 90 degrees as ProBuilder.
    const s = rotated ? fh - y : x;
    const t = rotated ? x : y;
    const sLen = rotated ? fh : fw;
    const tLen = rotated ? fw : fh;
    const u = axis === 'u' ? u0 + (s / m.w) * (u1 - u0) : lerp(u0, u1, s / sLen);
    const v = axis === 'v' ? v0 + (t / m.h) * (v1 - v0) : lerp(v0, v1, t / tLen);
    return [u, v];
  });

  if (mirrorX || mirrorY) {
    // Flip inside the uv bounds, as ProBuilder's mapper does.
    const sumU = Math.min(...uv.map((p) => p[0])) + Math.max(...uv.map((p) => p[0]));
    const sumV = Math.min(...uv.map((p) => p[1])) + Math.max(...uv.map((p) => p[1]));
    for (const p of uv) {
      if (mirrorX) p[0] = sumU - p[0];
      if (mirrorY) p[1] = sumV - p[1];
    }
  }

  return { rectId: rect.id, rotated, mirrorX, mirrorY, uv: uv as FaceUv, tiled: axis !== null, score };
}
