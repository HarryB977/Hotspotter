import { pxPerMetre, rectSizeM } from './layout';
import type { HotspotLayout } from './layout';

export interface MaterialPeriod {
  /** Metres; null = continuous on that axis. */
  x: number | null;
  y: number | null;
  /** Metres: joint position inside the tile. */
  phaseX: number;
  phaseY: number;
  /** Piece may be cut by the rect edge on that axis. */
  cutAllowedX: boolean;
  cutAllowedY: boolean;
}

export const CONTINUOUS: MaterialPeriod = {
  x: null, y: null, phaseX: 0, phaseY: 0, cutAllowedX: true, cutAllowedY: true,
};

/** Nearest multiple of the period, at least one period; unchanged if period is null. */
export function snapToPeriod(sizeM: number, period: number | null): number {
  if (period === null) return sizeM;
  return Math.max(1, Math.round(sizeM / period)) * period;
}

export type ProportionIssue = { rectId: string; axis: 'x' | 'y'; sizeM: number; suggestedM: number };

export function checkProportions(
  l: HotspotLayout,
  p: MaterialPeriod,
  tolerancePx = 1,
): ProportionIssue[] {
  const ppm = pxPerMetre(l);
  const issues: ProportionIssue[] = [];
  for (const r of l.rects) {
    const size = rectSizeM(l, r);
    const axes = [
      { axis: 'x' as const, sizeM: size.w, sizePx: r.w, period: p.x, cut: p.cutAllowedX },
      { axis: 'y' as const, sizeM: size.h, sizePx: r.h, period: p.y, cut: p.cutAllowedY },
    ];
    for (const a of axes) {
      if (a.period === null || a.cut) continue;
      const suggestedM = snapToPeriod(a.sizeM, a.period);
      if (Math.abs(a.sizePx - suggestedM * ppm) > tolerancePx) {
        issues.push({ rectId: r.id, axis: a.axis, sizeM: a.sizeM, suggestedM });
      }
    }
  }
  return issues;
}
