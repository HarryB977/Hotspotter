import { describe, expect, it } from 'vitest';
import { autoLayout } from '../src/autoLayout';
import type { AutoTarget } from '../src/autoLayout';
import { CONTINUOUS, checkProportions } from '../src/period';
import { pxPerMetre, validateLayout } from '../src/layout';
import type { HotspotLayout } from '../src/layout';

const PERIOD = { ...CONTINUOUS, x: 0.25, y: 0.075, cutAllowedX: false, cutAllowedY: false };
const TARGETS: AutoTarget[] = ['walls', 'floors', 'trims', 'mixed'];
const base = { widthPx: 1024, worldWidthM: 8 };

/** Covered pixel area of rects inside the region anchored at the bottom-left, and area outside it. */
function coverage(l: HotspotLayout, regionW: number, regionH: number) {
  const top = l.heightPx - regionH;
  let inside = 0;
  let outside = 0;
  for (const r of l.rects) {
    const ix = Math.max(0, Math.min(r.x + r.w, regionW) - r.x);
    const iy = Math.max(0, r.y + r.h - Math.max(r.y, top));
    inside += ix * iy;
    outside += r.w * r.h - ix * iy;
  }
  return { inside, outside };
}

describe('autoLayout', () => {
  for (const target of TARGETS) {
    it(`${target}: valid, proportioned, fully covers the period-aligned region`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const l = autoLayout({ ...base, target, period: PERIOD, seed });
        expect(validateLayout(l)).toEqual([]);
        expect(checkProportions(l, PERIOD)).toEqual([]);
        const ppm = pxPerMetre(l);
        const regionW = Math.round(Math.floor(8 / 0.25) * 0.25 * ppm);
        const regionH = Math.round(Math.floor(8 / 0.075 + 1e-9) * 0.075 * ppm);
        const c = coverage(l, regionW, regionH);
        expect(c.inside).toBe(regionW * regionH);
        expect(c.outside).toBe(0);
        expect(l.rects.length).toBeGreaterThanOrEqual(8);
        expect(l.rects.length).toBeLessThanOrEqual(48);
      }
    });
  }

  it('is deterministic per seed and differs between seeds', () => {
    const o = { ...base, target: 'mixed' as const, period: PERIOD };
    expect(autoLayout({ ...o, seed: 7 })).toEqual(autoLayout({ ...o, seed: 7 }));
    expect(autoLayout({ ...o, seed: 7 })).not.toEqual(autoLayout({ ...o, seed: 8 }));
  });

  it('trims: more than half of the rects tile in U', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const l = autoLayout({ ...base, target: 'trims', period: PERIOD, seed });
      expect(l.rects.filter((r) => r.tileU).length).toBeGreaterThan(l.rects.length / 2);
    }
  });

  it('CONTINUOUS covers the whole atlas and respects minSizeM (trim bands are exempt)', () => {
    const minSizeM = 0.3;
    for (const target of TARGETS) {
      const l = autoLayout({ ...base, target, period: CONTINUOUS, seed: 3, minSizeM });
      expect(validateLayout(l)).toEqual([]);
      const c = coverage(l, l.widthPx, l.heightPx);
      expect(c.inside).toBe(l.widthPx * l.heightPx);
      const minPx = minSizeM * pxPerMetre(l) - 1;
      for (const r of l.rects) {
        expect(r.w).toBeGreaterThanOrEqual(minPx);
        if (!r.tileU) expect(r.h).toBeGreaterThanOrEqual(minPx);
      }
    }
  });
});
