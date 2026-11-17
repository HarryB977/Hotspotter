import { pxPerMetre, seamlessAxes } from '../layout';
import type { HotspotLayout } from '../layout';
import type { WearParams } from '../wear/params';

/**
 * A rect at evaluation resolution: its visible bounds (shrunk by half the groove, except on a seamless axis) and wear
 * widths, as rectId.wgsl draws it and the loss pass sizes it.
 */
export interface EvalRect {
  /** Index in layout.rects; the rect id map holds index + 1. */
  index: number;
  id: string;
  /** Visible rect in evaluation px (continuous coordinates, pixel centres at +0.5). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Edge wear width: min(widthM, 0.33 · visible short side), metres. */
  wEffM: number;
  /** Guaranteed rim: min(minEdgeM, 0.5 · wEff), metres (R28). */
  rimM: number;
  /** Seamless tiling strip (decision 89): its left and right (u) or top and bottom (v) edges are no edge. */
  seamU: boolean;
  seamV: boolean;
}

export interface EvalGeometry {
  /** Evaluation px per metre. */
  ppm: number;
  rects: EvalRect[];
}

/**
 * Rect bounds and wear widths at an evaluation width of `widthPx`, matching wearLoss.wgsl. Without `wear` the widths
 * are 0.
 */
export function evalGeometry(layout: HotspotLayout, wear: WearParams | null, widthPx: number): EvalGeometry {
  const ppmRef = pxPerMetre(layout);
  const s = widthPx / layout.widthPx;
  const hg = 0.5 * layout.groove.widthM * ppmRef;
  const rects = layout.rects.map((r, index) => {
    const seam = seamlessAxes(layout, r);
    // The short side across the edges that exist: a seamless axis has none.
    const sidePx = Math.min(seam.u ? Infinity : r.w, seam.v ? Infinity : r.h);
    const visibleMinM = Math.max(sidePx / ppmRef - layout.groove.widthM, 0);
    const wEffM = wear ? Math.min(wear.widthM, 0.33 * visibleMinM) : 0;
    const hx = seam.u ? 0 : hg, hy = seam.v ? 0 : hg;
    return {
      index, id: r.id,
      x0: (r.x + hx) * s, x1: (r.x + r.w - hx) * s, y0: (r.y + hy) * s, y1: (r.y + r.h - hy) * s,
      wEffM, rimM: wear ? Math.min(wear.minEdgeM, 0.5 * wEffM) : 0,
      seamU: seam.u, seamV: seam.v,
    };
  });
  return { ppm: ppmRef * s, rects };
}

/**
 * Distance (evaluation px) from the centre of pixel (x, y) to the visible edge of `r`; negative on the groove floor.
 * The edges on a seamless axis do not count (Infinity when both axes are seamless), as visibleEdgePx in common.wgsl.
 */
export function edgeDistPx(r: EvalRect, x: number, y: number): number {
  const cx = x + 0.5, cy = y + 0.5;
  return Math.min(
    r.seamU ? Infinity : Math.min(cx - r.x0, r.x1 - cx),
    r.seamV ? Infinity : Math.min(cy - r.y0, r.y1 - cy),
  );
}

/**
 * Why edge-wear checks (coverage, islands) do not apply, in Spanish, or null when they do: the wear is off (its
 * switch, or 1 × 1 placeholder maps), its width is 0 (R30), or the family loses no material (wearMask stays 0).
 */
export function wearSkipReason(wear: WearParams, wearMask: Uint8Array, pixels: number, loses: boolean): string | null {
  if (!wear.enabled || wearMask.length < pixels) return 'El desgaste está desactivado: no hay nada que comprobar.';
  if (wear.widthM <= 0) return 'El desgaste de borde está desactivado (alcance 0): no hay nada que comprobar.';
  if (!loses) return 'Esta familia de desgaste no quita material: no hay roturas que comprobar.';
  return null;
}
