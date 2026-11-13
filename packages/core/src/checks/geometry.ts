import { pxPerMetre } from '../layout';
import type { HotspotLayout } from '../layout';
import type { WearParams } from '../wear/params';

/** A rect at evaluation resolution: its visible (groove-shrunk) bounds and wear widths, as the loss pass sizes them. */
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
    const visibleMinM = Math.max(Math.min(r.w, r.h) / ppmRef - layout.groove.widthM, 0);
    const wEffM = wear ? Math.min(wear.widthM, 0.33 * visibleMinM) : 0;
    return {
      index, id: r.id,
      x0: (r.x + hg) * s, x1: (r.x + r.w - hg) * s, y0: (r.y + hg) * s, y1: (r.y + r.h - hg) * s,
      wEffM, rimM: wear ? Math.min(wear.minEdgeM, 0.5 * wEffM) : 0,
    };
  });
  return { ppm: ppmRef * s, rects };
}

/** Distance (evaluation px) from the centre of pixel (x, y) to the visible edge of `r`; negative on the groove floor. */
export function edgeDistPx(r: EvalRect, x: number, y: number): number {
  const cx = x + 0.5, cy = y + 0.5;
  return Math.min(cx - r.x0, r.x1 - cx, cy - r.y0, r.y1 - cy);
}

/**
 * Why edge-wear checks (coverage, islands) do not apply, in Spanish, or null when they do: the wear is off (1 × 1
 * placeholder maps), its width is 0 (R30), or the family loses no material (wearMask stays 0).
 */
export function wearSkipReason(wear: WearParams, wearMask: Uint8Array, pixels: number, loses: boolean): string | null {
  if (wearMask.length < pixels) return 'El desgaste está desactivado: no hay nada que comprobar.';
  if (wear.widthM <= 0) return 'El desgaste de borde está desactivado (alcance 0): no hay nada que comprobar.';
  if (!loses) return 'Esta familia de desgaste no quita material: no hay roturas que comprobar.';
  return null;
}
