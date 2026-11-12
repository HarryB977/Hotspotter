import type { HotspotLayout } from './layout';
import type { MaterialPeriod } from './period';

export type OrientationRule = 'fixed' | 'longAxis';

export interface MaterialOrientation {
  baseRotation: 0 | 90;
  rule: OrientationRule;
}

export const DEFAULT_ORIENTATION: MaterialOrientation = { baseRotation: 0, rule: 'fixed' };

/** Largest grid unit longAxis layouts may use. */
const MAX_UNIT_M = 1;

export class OrientationUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrientationUnitError';
  }
}

/** Which rects are rotated 90 degrees by the orientation (before placement variation). */
export function rectRotations(l: HotspotLayout, o: MaterialOrientation): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of l.rects) {
    out.set(r.id, (o.baseRotation === 90) !== (o.rule === 'longAxis' && r.h > r.w));
  }
  return out;
}

/** Period in atlas axes: a rotated rect swaps the material's X and Y. */
export function effectivePeriod(p: MaterialPeriod, rotated: boolean): MaterialPeriod {
  if (!rotated) return p;
  return {
    x: p.y, y: p.x, phaseX: p.phaseY, phaseY: p.phaseX, cutAllowedX: p.cutAllowedY, cutAllowedY: p.cutAllowedX,
  };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Grid unit that is a whole number of every strict period (lcm, in integer mm), so rects of any
 * orientation keep whole periods on both atlas axes. Null when no axis is strict.
 */
export function orientationUnit(p: MaterialPeriod): number | null {
  const strict = [
    p.x !== null && !p.cutAllowedX ? p.x : null,
    p.y !== null && !p.cutAllowedY ? p.y : null,
  ].filter((v): v is number => v !== null);
  if (strict.length === 0) return null;
  let lcm = 1;
  for (const v of strict) {
    const mm = Math.max(1, Math.round(v * 1000));
    lcm = (lcm / gcd(lcm, mm)) * mm;
    if (lcm > MAX_UNIT_M * 1000) {
      throw new OrientationUnitError(`Periods have no common grid unit up to ${MAX_UNIT_M} m`);
    }
  }
  return lcm / 1000;
}
