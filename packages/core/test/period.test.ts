import { describe, it, expect } from 'vitest';
import { CONTINUOUS, snapToPeriod, checkProportions } from '../src/period';
import { makeRect } from '../src/layout';
import type { HotspotLayout } from '../src/layout';

function layoutWith(h: number): HotspotLayout {
  return {
    version: 1,
    widthPx: 512,
    heightPx: 512,
    worldWidthM: 1,
    rects: [makeRect({ id: 'a', x: 0, y: 0, w: 100, h })],
    groove: { widthM: 0.006, bevelM: 0.003, depthM: 0.004, profile: 'bevel' },
  };
}

describe('snapToPeriod', () => {
  it('snaps to the nearest multiple', () => {
    expect(snapToPeriod(0.31, 0.075)).toBeCloseTo(0.3, 6);
  });
  it('never returns less than one period', () => {
    expect(snapToPeriod(0.02, 0.075)).toBeCloseTo(0.075, 6);
  });
  it('is unchanged for a null period', () => {
    expect(snapToPeriod(0.31, null)).toBe(0.31);
  });
});

describe('checkProportions', () => {
  const p = { ...CONTINUOUS, y: 0.075, cutAllowedY: false };

  it('accepts a height that matches the period within tolerance', () => {
    expect(checkProportions(layoutWith(154), p)).toEqual([]);
  });
  it('reports a height off the period grid', () => {
    const issues = checkProportions(layoutWith(163.84), p);
    expect(issues).toHaveLength(1);
    expect(issues[0].rectId).toBe('a');
    expect(issues[0].axis).toBe('y');
    expect(issues[0].sizeM).toBeCloseTo(0.32, 6);
    expect(issues[0].suggestedM).toBeCloseTo(0.3, 6);
  });
  it('ignores an axis where cutting is allowed', () => {
    const q = { ...CONTINUOUS, x: 0.075, cutAllowedX: true };
    expect(checkProportions(layoutWith(154), q)).toEqual([]);
  });
  it('returns no issues for a continuous material', () => {
    expect(checkProportions(layoutWith(163.84), CONTINUOUS)).toEqual([]);
  });
});
