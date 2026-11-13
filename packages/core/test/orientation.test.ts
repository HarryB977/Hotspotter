import { describe, it, expect } from 'vitest';
import { rectRotations, effectivePeriod, orientationUnit, OrientationUnitError } from '../src/orientation';
import { checkProportions, CONTINUOUS } from '../src/period';
import { makeRect } from '../src/layout';
import type { HotspotLayout } from '../src/layout';

function layoutOf(...rects: Array<[string, number, number]>): HotspotLayout {
  return {
    version: 1, widthPx: 1000, heightPx: 1000, worldWidthM: 10,
    groove: { widthM: 0.006, bevelM: 0.003, depthM: 0.004, profile: 'bevel' },
    rects: rects.map(([id, w, h], i) => makeRect({ id, x: 0, y: i * 100, w, h })),
  };
}

describe('rectRotations', () => {
  const l = layoutOf(['wide', 200, 100], ['tall', 100, 200], ['sq', 100, 100]);
  const get = (o: Parameters<typeof rectRotations>[1]) => [...rectRotations(l, o).values()];
  it('fixed/0 rotates nothing, fixed/90 rotates everything', () => {
    expect(get({ baseRotation: 0, rule: 'fixed' })).toEqual([false, false, false]);
    expect(get({ baseRotation: 90, rule: 'fixed' })).toEqual([true, true, true]);
  });
  it('longAxis/0 rotates only rects with h > w; longAxis/90 inverts', () => {
    expect(get({ baseRotation: 0, rule: 'longAxis' })).toEqual([false, true, false]);
    expect(get({ baseRotation: 90, rule: 'longAxis' })).toEqual([true, false, true]);
  });
});

describe('effectivePeriod', () => {
  const p = { x: 0.1, y: null, phaseX: 0.01, phaseY: 0.02, cutAllowedX: true, cutAllowedY: false };
  it('swaps every per-axis field when rotated', () => {
    expect(effectivePeriod(p, true)).toEqual({
      x: null, y: 0.1, phaseX: 0.02, phaseY: 0.01, cutAllowedX: false, cutAllowedY: true,
    });
    expect(effectivePeriod(p, false)).toEqual(p);
  });
});

describe('checkProportions with rotated rects', () => {
  const planks = { ...CONTINUOUS, y: 0.15, cutAllowedY: false };
  const rot = new Map([['a', true]]);
  it('compares the atlas width with the swapped period', () => {
    expect(checkProportions(layoutOf(['a', 60, 200]), planks, rot)).toEqual([]);
  });
  it('flags a rotated width off the period grid on axis x', () => {
    const issues = checkProportions(layoutOf(['a', 62, 200]), planks, rot);
    expect(issues).toHaveLength(1);
    expect(issues[0].axis).toBe('x');
    expect(issues[0].suggestedM).toBeCloseTo(0.6, 6);
  });
  it('does not flag the same rect unrotated on x (period X is null)', () => {
    expect(checkProportions(layoutOf(['a', 62, 200]), planks).filter((i) => i.axis === 'x')).toEqual([]);
  });
});

describe('orientationUnit', () => {
  const strict = (x: number | null, y: number | null) => ({
    ...CONTINUOUS, x, y, cutAllowedX: false, cutAllowedY: false,
  });
  it('is the lcm of the strict periods', () => {
    expect(orientationUnit(strict(0.25, 0.075))).toBeCloseTo(0.75, 6);
  });
  it('is null when nothing is strict', () => {
    expect(orientationUnit(CONTINUOUS)).toBeNull();
  });
  it('throws when the lcm exceeds 1 m', () => {
    expect(() => orientationUnit(strict(0.37, 0.41))).toThrow(OrientationUnitError);
  });
});
