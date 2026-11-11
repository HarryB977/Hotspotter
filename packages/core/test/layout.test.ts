import { describe, expect, it } from 'vitest';
import { makeRect, pxPerMetre, rectSizeM, validateLayout, DEFAULT_GROOVE } from '../src/layout';
import type { HotspotLayout, HotspotRect } from '../src/layout';

function layout(rects: HotspotRect[], widthPx = 200, heightPx = 100): HotspotLayout {
  return { version: 1, widthPx, heightPx, worldWidthM: 8, rects, groove: DEFAULT_GROOVE };
}

describe('validateLayout', () => {
  it('accepts edge-sharing rects', () => {
    const l = layout([
      makeRect({ id: 'a', x: 0, y: 0, w: 100, h: 100 }),
      makeRect({ id: 'b', x: 100, y: 0, w: 100, h: 100 }),
    ]);
    expect(validateLayout(l)).toEqual([]);
  });

  it('reports overlap with both ids', () => {
    const l = layout([
      makeRect({ id: 'a', x: 0, y: 0, w: 100, h: 100 }),
      makeRect({ id: 'b', x: 50, y: 0, w: 100, h: 100 }),
    ]);
    expect(validateLayout(l)).toEqual([{ kind: 'overlap', rectIds: ['a', 'b'] }]);
  });

  it('reports outOfBounds', () => {
    const l = layout([makeRect({ id: 'a', x: 150, y: 0, w: 100, h: 50 })]);
    expect(validateLayout(l)).toEqual([{ kind: 'outOfBounds', rectIds: ['a'] }]);
  });

  it('reports tileNotFullSpan for tileU narrower than the atlas', () => {
    const l = layout([makeRect({ id: 'a', x: 0, y: 0, w: 100, h: 50, tileU: true })]);
    expect(validateLayout(l)).toEqual([{ kind: 'tileNotFullSpan', rectIds: ['a'] }]);
  });

  it('reports tileNotFullSpan for tileV shorter than the atlas', () => {
    const l = layout([makeRect({ id: 'a', x: 0, y: 0, w: 50, h: 50, tileV: true })]);
    expect(validateLayout(l)).toEqual([{ kind: 'tileNotFullSpan', rectIds: ['a'] }]);
  });

  it('reports tooSmall when w or h is below 4 px', () => {
    const l = layout([
      makeRect({ id: 'a', x: 0, y: 0, w: 3, h: 50 }),
      makeRect({ id: 'b', x: 10, y: 0, w: 50, h: 3 }),
    ]);
    expect(validateLayout(l)).toEqual([
      { kind: 'tooSmall', rectIds: ['a'] },
      { kind: 'tooSmall', rectIds: ['b'] },
    ]);
  });
});

describe('metrics', () => {
  it('pxPerMetre is 512 for 4096 px over 8 m', () => {
    expect(pxPerMetre(layout([], 4096, 4096))).toBe(512);
  });

  it('rectSizeM converts px to metres', () => {
    const l = layout([], 4096, 4096);
    expect(rectSizeM(l, makeRect({ id: 'a', x: 0, y: 0, w: 512, h: 256 }))).toEqual({ w: 1, h: 0.5 });
  });
});

describe('makeRect', () => {
  it('fills defaults', () => {
    expect(makeRect({ id: 'a', x: 1, y: 2, w: 3, h: 4 })).toEqual({
      id: 'a', x: 1, y: 2, w: 3, h: 4,
      allowRotation: false, allowMirrorX: false, allowMirrorY: false,
      tileU: false, tileV: false, useOn: 'any', inset: 0, group: '',
    });
  });
});
