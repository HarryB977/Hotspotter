import { describe, expect, it } from 'vitest';
import { matchHotspot } from '../src/fit/match';
import type { FaceQuad, HotspotFit } from '../src/fit/match';
import { presetLayout } from '../src/presets';
import { DEFAULT_GROOVE, makeRect } from '../src/layout';
import type { HotspotLayout, HotspotRect } from '../src/layout';

const NO_ROT = new Map<string, boolean>();
const walls = presetLayout('walls', 4096, 8);
const mixed = presetLayout('mixed', 4096, 8);

/** 1 m = 100 px, so a 10 m wide atlas of 1000 px. */
function custom(rects: HotspotRect[], heightPx = 1000): HotspotLayout {
  return { version: 1, widthPx: 1000, heightPx, worldWidthM: 10, rects, groove: { ...DEFAULT_GROOVE } };
}

const wall = (widthM: number, heightM: number): FaceQuad => ({ widthM, heightM, useOn: 'walls' });
const rectOf = (l: HotspotLayout, fit: HotspotFit) => l.rects.find((r) => r.id === fit.rectId)!;
const us = (fit: HotspotFit) => fit.uv.map(([u]) => u);
const vs = (fit: HotspotFit) => fit.uv.map(([, v]) => v);
const span = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

function expectUv(fit: HotspotFit, expected: [number, number][]) {
  fit.uv.forEach(([u, v], i) => {
    expect(u).toBeCloseTo(expected[i][0], 12);
    expect(v).toBeCloseTo(expected[i][1], 12);
  });
}

function expectFiniteInside(fit: HotspotFit) {
  for (const [u, v] of fit.uv) {
    expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    if (!fit.tiled) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  }
  expect(Number.isFinite(fit.score)).toBe(true);
}

describe('matchHotspot', () => {
  it('fits a 1 x 2 m wall face onto the closest rect, corners on the rect corners with V flipped', () => {
    // walls preset at 8 m: the 1.2 x 2.6 m rect at x = 5.2 m, y = 0 scores
    // |ln(0.5 / 0.4615)| + 0.5 |ln(2 / 3.12)| = 0.302, the lowest of the layout.
    const fit = matchHotspot(wall(1, 2), walls, NO_ROT);
    const r = rectOf(walls, fit);
    expect([r.x, r.y, r.w, r.h]).toEqual([2662, 0, 615, 1331]);
    expect(fit.rotated).toBe(false);
    expect(fit.tiled).toBe(false);
    expect(fit.mirrorX || fit.mirrorY).toBe(false);
    const u0 = r.x / 4096, u1 = (r.x + r.w) / 4096;
    const vTop = 1 - r.y / 4096, vBottom = 1 - (r.y + r.h) / 4096;
    expectUv(fit, [[u0, vBottom], [u1, vBottom], [u1, vTop], [u0, vTop]]);
    expect(fit.score).toBeCloseTo(Math.abs(Math.log(0.5 / (1.2 / 2.6))) + 0.5 * Math.abs(Math.log(2 / 3.12)), 2);
  });

  it('a rotated pick swaps the rect axes in the uv', () => {
    // One 2 x 1 m rect; a 1 x 2 m face only fits it turned.
    const r = makeRect({ id: 'a', x: 100, y: 200, w: 200, h: 100, allowRotation: true });
    const fit = matchHotspot(wall(1, 2), custom([r]), NO_ROT);
    expect(fit.rotated).toBe(true);
    expect(fit.score).toBeCloseTo(0, 12);
    const u0 = 0.1, u1 = 0.3, vBottom = 0.7, vTop = 0.8;
    // Face width runs up the rect's V, face height runs back along its U (90 degrees, as ProBuilder's fit).
    expectUv(fit, [[u1, vBottom], [u1, vTop], [u0, vTop], [u0, vBottom]]);
    expect(span(us(fit))).toBeCloseTo(0.2, 12);
    expect(span(vs(fit))).toBeCloseTo(0.1, 12);

    const fixed = matchHotspot(wall(1, 2), custom([{ ...r, allowRotation: false }]), NO_ROT);
    expect(fixed.rotated).toBe(false);
    expectUv(fixed, [[u0, vBottom], [u1, vBottom], [u1, vTop], [u0, vTop]]);
  });

  it('a 6 x 0.2 m face takes the tileU strip of the walls preset and repeats it in world metres', () => {
    const fit = matchHotspot(wall(6, 0.2), walls, NO_ROT);
    const r = rectOf(walls, fit);
    expect(r.tileU).toBe(true);
    expect(fit.tiled).toBe(true);
    const stripWidthM = (r.w / 4096) * 8;
    expect(span(us(fit))).toBeCloseTo(6 / stripWidthM, 12);
    // The cross axis is stretched onto the strip height.
    expect(Math.min(...vs(fit))).toBeCloseTo(1 - (r.y + r.h) / 4096, 12);
    expect(Math.max(...vs(fit))).toBeCloseTo(1 - r.y / 4096, 12);
    expectFiniteInside(fit);
  });

  it('a skirting takes the strip whose height is within 25 % and scores |ln(hFace / hRect)|', () => {
    const fit = matchHotspot(wall(6, 0.2), mixed, NO_ROT);
    const r = rectOf(mixed, fit);
    expect(r.tileU).toBe(true);
    expect(r.h).toBe(102); // the 20 cm trim
    expect(fit.tiled).toBe(true);
    expect(fit.score).toBeCloseTo(Math.abs(Math.log(0.2 / (102 / 512))), 12);
    expect(span(us(fit))).toBeCloseTo(0.75, 12);

    const skirting = matchHotspot(wall(6, 0.15), mixed, NO_ROT);
    expect(rectOf(mixed, skirting).h).toBe(82); // the 16 cm trim
    expect(skirting.tiled).toBe(true);
  });

  it('a strip rotated onto a vertical face repeats along the face height', () => {
    const strip = makeRect({ id: 's', x: 0, y: 0, w: 1000, h: 20, tileU: true, allowRotation: true });
    const fit = matchHotspot(wall(0.2, 3), custom([strip]), NO_ROT);
    expect(fit.rotated).toBe(true);
    expect(fit.tiled).toBe(true);
    expect(span(us(fit))).toBeCloseTo(3 / 10, 12);
    expect(span(vs(fit))).toBeCloseTo(0.02, 12);
  });

  it('a face longer than a strip repeats it past 1 on the tiled axis only', () => {
    const fit = matchHotspot(wall(40, 0.8), walls, NO_ROT);
    expect(rectOf(walls, fit).tileU).toBe(true);
    expect(span(us(fit))).toBeCloseTo(5, 12);
    expectFiniteInside(fit);
  });

  it('tiny and huge faces still get finite uv inside [0,1] off the tiled axis', () => {
    for (const layout of [walls, mixed, presetLayout('floors'), presetLayout('generic')]) {
      for (const face of [wall(0.05, 0.05), wall(40, 40), { widthM: 40, heightM: 40, useOn: 'floors' as const }]) {
        expectFiniteInside(matchHotspot(face, layout, NO_ROT));
      }
    }
  });

  it('a corridor skirting with no strip in the layout takes the closest rect', () => {
    const generic = presetLayout('generic');
    expect(generic.rects.some((r) => r.tileU || r.tileV)).toBe(false);
    const fit = matchHotspot(wall(6, 0.2), generic, NO_ROT);
    expect(fit.tiled).toBe(false);
    expectFiniteInside(fit);
  });

  it('a floors face never takes a walls-only rect while a floors or any rect exists', () => {
    const faces = [[1.2, 2.6], [3.2, 2.6], [2, 1.2], [8, 0.8], [0.4, 0.4], [6, 0.2]];
    for (const [w, h] of faces) {
      const fit = matchHotspot({ widthM: w, heightM: h, useOn: 'floors' }, mixed, NO_ROT, { seed: 3 });
      expect(rectOf(mixed, fit).useOn).not.toBe('walls');
    }
    // The walls preset has walls-only rects: a floors face falls back to them.
    const fallback = matchHotspot({ widthM: 1, heightM: 2, useOn: 'floors' }, walls, NO_ROT);
    expect(rectOf(walls, fallback).useOn).toBe('walls');
  });

  it('the seed changes ties only', () => {
    // walls preset: two 0.4 x 2.6 m rects tie exactly for a 0.4 x 2.6 m face.
    const tied = new Set<string>();
    const single = new Set<string>();
    for (let seed = 0; seed < 32; seed++) {
      tied.add(matchHotspot(wall(0.4, 2.6), walls, NO_ROT, { seed }).rectId);
      single.add(matchHotspot(wall(1, 2), walls, NO_ROT, { seed }).rectId);
    }
    expect(tied.size).toBe(2);
    expect(single.size).toBe(1);
    // Same seed, same answer.
    expect(matchHotspot(wall(0.4, 2.6), walls, NO_ROT, { seed: 7 })).toEqual(
      matchHotspot(wall(0.4, 2.6), walls, NO_ROT, { seed: 7 }),
    );
  });

  it('mirrors only along the axes the rect allows, picked by the seed', () => {
    const r = makeRect({ id: 'm', x: 100, y: 200, w: 200, h: 100, allowMirrorX: true });
    const layout = custom([r]);
    const seen = new Set<boolean>();
    for (let seed = 0; seed < 32; seed++) {
      const fit = matchHotspot(wall(2, 1), layout, NO_ROT, { seed });
      expect(fit.mirrorY).toBe(false);
      seen.add(fit.mirrorX);
      const [l, rt] = fit.mirrorX ? [0.3, 0.1] : [0.1, 0.3];
      expectUv(fit, [[l, 0.7], [rt, 0.7], [rt, 0.8], [l, 0.8]]);
    }
    expect([...seen].sort()).toEqual([false, true]);

    const both = custom([{ ...r, allowMirrorX: false, allowMirrorY: true }]);
    const flips = new Set<boolean>();
    for (let seed = 0; seed < 32; seed++) {
      const fit = matchHotspot(wall(2, 1), both, NO_ROT, { seed });
      expect(fit.mirrorX).toBe(false);
      flips.add(fit.mirrorY);
      if (fit.mirrorY) expectUv(fit, [[0.1, 0.8], [0.3, 0.8], [0.3, 0.7], [0.1, 0.7]]);
    }
    expect(flips.size).toBe(2);

    for (let seed = 0; seed < 32; seed++) {
      const fit = matchHotspot(wall(1, 2), walls, NO_ROT, { seed });
      expect(fit.mirrorX || fit.mirrorY).toBe(false);
    }
  });

  it('rejects a face without positive finite size', () => {
    for (const [w, h] of [[0, 1], [1, -1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]]) {
      expect(() => matchHotspot(wall(w, h), walls, NO_ROT)).toThrow(/face size/);
    }
  });

  it('rejects a layout with no usable rect', () => {
    expect(() => matchHotspot(wall(1, 1), custom([]), NO_ROT)).toThrow(/no usable rect/);
    const flat = makeRect({ id: 'z', x: 0, y: 0, w: 0, h: 100 });
    expect(() => matchHotspot(wall(1, 1), custom([flat]), NO_ROT)).toThrow(/no usable rect/);
    expect(() => matchHotspot(wall(1, 1), { ...custom([makeRect({ id: 'a', x: 0, y: 0, w: 10, h: 10 })]), worldWidthM: 0 }, NO_ROT))
      .toThrow(/no usable rect/);
  });
});
