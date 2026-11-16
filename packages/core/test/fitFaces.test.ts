import { describe, expect, it } from 'vitest';
import { buildShape, engineLayout, faceSeed, fitFaces, makeRect, DEFAULT_GROOVE, toHotspotJson } from '../src';
import type { HotspotLayout, TestShape } from '../src';

const NO_ROT = new Map<string, boolean>();
const SHAPES: TestShape[] = ['cube', 'wallWithOpenings', 'corridor', 'column', 'stairs'];

/** 1 m = 100 px. Three identical 2 × 2 m rects that may mirror on both axes, plus strips, so faces tie. */
function tied(): HotspotLayout {
  const m = { allowMirrorX: true, allowMirrorY: true };
  return {
    version: 1, widthPx: 1000, heightPx: 1000, worldWidthM: 10, groove: { ...DEFAULT_GROOVE },
    rects: [
      makeRect({ id: 'a', x: 0, y: 0, w: 200, h: 200, ...m }),
      makeRect({ id: 'b', x: 200, y: 0, w: 200, h: 200, ...m }),
      makeRect({ id: 'c', x: 400, y: 0, w: 200, h: 200, ...m }),
      makeRect({ id: 'u', x: 0, y: 400, w: 1000, h: 20, tileU: true, allowRotation: true, ...m }),
      makeRect({ id: 's', x: 0, y: 600, w: 100, h: 300, allowRotation: true, ...m }),
    ],
  };
}

describe('engineLayout', () => {
  it('clears allowMirrorY with runoff and keeps every other field', () => {
    const l = tied();
    const e = engineLayout(l, { runoff: true });
    expect(e.rects.every((r) => !r.allowMirrorY)).toBe(true);
    expect(e.rects.map((r) => ({ ...r, allowMirrorY: true }))).toEqual(l.rects);
    // The input is not touched.
    expect(l.rects.every((r) => r.allowMirrorY)).toBe(true);
  });
  it('is the layout itself without runoff', () => {
    const l = tied();
    expect(engineLayout(l, { runoff: false })).toBe(l);
  });
  it('gives hotspot.json its mirror flags', () => {
    const l = tied();
    for (const runoff of [false, true]) {
      const j = JSON.parse(toHotspotJson(l, { name: 't', heightRangeM: [0, 0], maps: [], runoff }));
      expect(j.rects.map((r: { allowMirrorY: boolean }) => r.allowMirrorY))
        .toEqual(engineLayout(l, { runoff }).rects.map((r) => r.allowMirrorY));
    }
  });
});

describe('faceSeed', () => {
  it('is a deterministic u32 that differs per face and per seed', () => {
    const seeds = new Set<number>();
    for (const s of [0, 1, 7]) {
      for (let i = 0; i < 50; i++) {
        const v = faceSeed(s, i);
        expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
        expect(faceSeed(s, i)).toBe(v);
        seeds.add(v);
      }
    }
    expect(seeds.size).toBe(150);
  });
});

describe('fitFaces', () => {
  const key = (f: { rectId: string; mirrorX: boolean; mirrorY: boolean }) => `${f.rectId}:${f.mirrorX}:${f.mirrorY}`;

  it('is deterministic for the same shape and seed', () => {
    for (const shape of SHAPES) {
      const faces = buildShape(shape);
      expect(fitFaces(faces, tied(), NO_ROT, { seed: 3, runoff: false }))
        .toEqual(fitFaces(faces, tied(), NO_ROT, { seed: 3, runoff: false }));
    }
  });

  it('seeds each face on its own, so tied faces do not all make the same pick', () => {
    // The cube's four 2 × 2 m walls tie on the three 2 × 2 rects.
    const faces = buildShape('cube');
    const fits = fitFaces(faces, tied(), NO_ROT, { seed: 0, runoff: false });
    const walls = fits.filter((_, i) => faces[i].quad.useOn === 'walls');
    expect(walls).toHaveLength(4);
    expect(new Set(walls.map(key)).size).toBeGreaterThan(1);
    // Another seed gives another arrangement.
    const other = fitFaces(faces, tied(), NO_ROT, { seed: 1, runoff: false });
    expect(other.map(key)).not.toEqual(fits.map(key));
  });

  it('never mirrors vertically with runoff, as the export', () => {
    let mirroredWithout = 0;
    for (const shape of SHAPES) {
      const faces = buildShape(shape);
      for (let seed = 0; seed < 8; seed++) {
        const on = fitFaces(faces, tied(), NO_ROT, { seed, runoff: true });
        expect(on.some((f) => f.mirrorY)).toBe(false);
        mirroredWithout += fitFaces(faces, tied(), NO_ROT, { seed, runoff: false }).filter((f) => f.mirrorY).length;
      }
    }
    expect(mirroredWithout).toBeGreaterThan(0);
  });
});
