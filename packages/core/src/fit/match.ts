import { rectSizeM } from '../layout';
import type { HotspotLayout, HotspotRect } from '../layout';
import { createRng } from '../rng';

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
  score: number;
}

/** A strip matches a face whose cross size is within this fraction of the strip's (±25 %). */
const STRIP_TOLERANCE = 0.25;
/** Scores closer than this are a tie, broken by the seeded RNG. */
const TIE_EPSILON = 1e-9;

type TileAxis = 'u' | 'v' | null;

interface Candidate {
  rect: HotspotRect;
  rotated: boolean;
  axis: TileAxis;
  score: number;
}

/** Tiling axis in rect space; a strip must span the whole atlas on that axis (as ProBuilder's GetTilingAxis). */
function tileAxis(l: HotspotLayout, r: HotspotRect): TileAxis {
  if (r.tileU && r.x <= 0 && r.x + r.w >= l.widthPx) return 'u';
  if (r.tileV && r.y <= 0 && r.y + r.h >= l.heightPx) return 'v';
  return null;
}

const usableSize = (m: { w: number; h: number }) => Number.isFinite(m.w) && Number.isFinite(m.h) && m.w > 0 && m.h > 0;

const lerp = (a: number, b: number, f: number) => (1 - f) * a + f * b;

/**
 * Picks the hotspot rect for a face and maps the face onto it, the way a destination tool's "fit" does
 * (ProBuilder HotspotMapper): a non-uniform stretch of the face onto the rect, except along a strip's tiling axis,
 * which repeats in world metres. Scoring: `|ln(aspectFace / aspectRect)| + 0.5·|ln(areaFace / areaRect)|`; a strip
 * whose cross size is within ±25 % of the face's scores `|ln(crossFace / crossRect)|` instead. Rects whose `useOn`
 * excludes the face are skipped unless none remains. Ties and mirroring (only on the axes the rect allows) come from
 * the seeded RNG.
 *
 * `rotations` (material turned 90 degrees inside each rect) does not change the pick: engines do not see the
 * material's orientation, and the 3D view must show what they would do (decision 79).
 *
 * Throws on a face without positive finite size and on a layout with no rect of positive finite metre size.
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

  const candidates: Candidate[] = [];
  for (const rect of pool) {
    const m = rectSizeM(layout, rect);
    const axis = tileAxis(layout, rect);
    for (const rotated of rect.allowRotation ? [false, true] : [false]) {
      // Rect size seen in face axes.
      const rw = rotated ? m.h : m.w;
      const rh = rotated ? m.w : m.h;
      let score = Math.abs(Math.log(fw / fh / (rw / rh))) + 0.5 * Math.abs(Math.log((fw * fh) / (rw * rh)));
      if (axis) {
        // The strip repeats along face u when its tiling axis and the rotation agree; the cross axis is the other.
        const alongFaceU = (axis === 'u') !== rotated;
        const ratio = alongFaceU ? fh / rh : fw / rw;
        if (Math.abs(ratio - 1) <= STRIP_TOLERANCE) score = Math.abs(Math.log(ratio));
      }
      candidates.push({ rect, rotated, axis, score });
    }
  }

  const best = Math.min(...candidates.map((c) => c.score));
  const tied = candidates.filter((c) => c.score - best <= TIE_EPSILON);
  const rng = createRng(opts?.seed ?? 0);
  const pick = tied.length === 1 ? tied[0] : rng.pick(tied);
  const { rect, rotated, axis } = pick;
  const mirrorX = rect.allowMirrorX && rng.next() < 0.5;
  const mirrorY = rect.allowMirrorY && rng.next() < 0.5;

  // Rect bounds in UV, V up.
  const u0 = rect.x / layout.widthPx;
  const u1 = (rect.x + rect.w) / layout.widthPx;
  const v0 = 1 - (rect.y + rect.h) / layout.heightPx;
  const v1 = 1 - rect.y / layout.heightPx;
  const m = rectSizeM(layout, rect);

  const corners: [number, number][] = [[0, 0], [fw, 0], [fw, fh], [0, fh]];
  const uv = corners.map(([x, y]): [number, number] => {
    // Face point in rect axes, metres from the rect's bottom-left: turning swaps the axes, 90 degrees as ProBuilder.
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

  return { rectId: rect.id, rotated, mirrorX, mirrorY, uv: uv as FaceUv, tiled: axis !== null, score: pick.score };
}
