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

/** Finite uv, inside [0,1] except along the picked strip's own tiling axis. */
function expectFiniteInside(fit: HotspotFit, layout: HotspotLayout) {
  const r = rectOf(layout, fit);
  const tileU = fit.tiled && r.tileU && r.w === layout.widthPx;
  const tileV = fit.tiled && !tileU && r.tileV;
  for (const [u, v] of fit.uv) {
    expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true);
    if (!tileU) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
    if (!tileV) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  }
  expect(Number.isFinite(fit.score)).toBe(true);
}

describe('matchHotspot', () => {
  it('fits a 0.5 x 1.5 m wall face onto the closest rect, corners on the rect corners with V flipped', () => {
    // walls preset at 8 m: no rect is within ±25 % on both axes and no strip fits, so ProBuilder takes the closest
    // overall. The 0.8 x 2.6 m rect at x = 4.8 m, y = 2.6 m scores 2 |ln(0.333 / 0.3077)| + 0.5 |ln(0.75 / 2.08)| = 0.669.
    const fit = matchHotspot(wall(0.5, 1.5), walls, NO_ROT);
    const r = rectOf(walls, fit);
    expect([r.x, r.y, r.w, r.h]).toEqual([3072, 1331, 410, 1331]);
    expect(fit.rotated).toBe(false);
    expect(fit.tiled).toBe(false);
    expect(fit.mirrorX || fit.mirrorY).toBe(false);
    const u0 = r.x / 4096, u1 = (r.x + r.w) / 4096;
    const vTop = 1 - r.y / 4096, vBottom = 1 - (r.y + r.h) / 4096;
    expectUv(fit, [[u0, vBottom], [u1, vBottom], [u1, vTop], [u0, vTop]]);
    expect(fit.score).toBeCloseTo(2 * Math.abs(Math.log((0.5 / 1.5) / (0.8 / 2.6))) + 0.5 * Math.abs(Math.log(0.75 / 2.08)), 2);
    // Brute force: no rect of the layout scores lower (none allows rotation).
    for (const o of walls.rects) {
      const w = (o.w / 4096) * 8, h = (o.h / 4096) * 8;
      const score = 2 * Math.abs(Math.log((0.5 / 1.5) / (w / h))) + 0.5 * Math.abs(Math.log(0.75 / (w * h)));
      expect(score).toBeGreaterThanOrEqual(fit.score - 1e-12);
    }
  });

  it('a rect within the scale tolerance beats an exactly matching strip (ProBuilder order)', () => {
    // 1 x 0.2 m face: a 1.05 x 0.2 m rect is 5 % off but within ±25 % on both axes, so it wins over the strip,
    // whose cross size matches exactly. Ranking all candidates by score would have picked the strip.
    const strip = makeRect({ id: 'strip', x: 0, y: 0, w: 1000, h: 20, tileU: true });
    const near = makeRect({ id: 'near', x: 0, y: 20, w: 105, h: 20 });
    const fit = matchHotspot(wall(1, 0.2), custom([strip, near]), NO_ROT);
    expect(fit.rectId).toBe('near');
    expect(fit.tiled).toBe(false);
    expect(fit.score).toBeCloseTo(2.5 * Math.log(1.05), 12);
    // Without the near rect, the strip takes the face.
    expect(matchHotspot(wall(1, 0.2), custom([strip]), NO_ROT).rectId).toBe('strip');
  });

  it('shrinks the uv rect by the inset, except along the tiling axis', () => {
    const r = makeRect({ id: 'a', x: 100, y: 200, w: 200, h: 100, inset: 4 });
    const fit = matchHotspot(wall(2, 1), custom([r]), NO_ROT);
    expectUv(fit, [[0.104, 0.704], [0.296, 0.704], [0.296, 0.796], [0.104, 0.796]]);

    // The inset is capped at a quarter of the rect.
    const small = makeRect({ id: 'b', x: 100, y: 200, w: 8, h: 8, inset: 4 });
    const capped = matchHotspot(wall(0.08, 0.08), custom([small]), NO_ROT);
    expectUv(capped, [[0.102, 0.794], [0.106, 0.794], [0.106, 0.798], [0.102, 0.798]]);

    const strip = makeRect({ id: 's', x: 0, y: 0, w: 1000, h: 20, tileU: true, inset: 4 });
    const tiled = matchHotspot(wall(5, 0.2), custom([strip]), NO_ROT);
    expect(tiled.tiled).toBe(true);
    expectUv(tiled, [[0, 0.984], [0.5, 0.984], [0.5, 0.996], [0, 0.996]]);
  });

  it('extreme but finite face sizes still return a finite fit', () => {
    for (const layout of [walls, mixed]) {
      for (const [w, h] of [[1e300, 1e300], [1e-200, 1e-200], [1e300, 1e-200], [1e-200, 0.2]]) {
        expectFiniteInside(matchHotspot(wall(w, h), layout, NO_ROT), layout);
      }
    }
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

  it('a 6 x 2.6 m face takes the storey strip of the walls preset and repeats it in world metres', () => {
    const fit = matchHotspot(wall(6, 2.6), walls, NO_ROT);
    const r = rectOf(walls, fit);
    expect(r.tileU).toBe(true);
    expect(fit.tiled).toBe(true);
    const stripWidthM = (r.w / 4096) * 8;
    expect(span(us(fit))).toBeCloseTo(6 / stripWidthM, 12);
    // The cross axis is stretched onto the strip height.
    expect(Math.min(...vs(fit))).toBeCloseTo(1 - (r.y + r.h) / 4096, 12);
    expect(Math.max(...vs(fit))).toBeCloseTo(1 - r.y / 4096, 12);
    expectFiniteInside(fit, walls);
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
    const fit = matchHotspot(wall(40, 2.6), walls, NO_ROT);
    expect(rectOf(walls, fit).tileU).toBe(true);
    expect(span(us(fit))).toBeCloseTo(5, 12);
    expectFiniteInside(fit, walls);
  });

  it('tiny and huge faces still get finite uv inside [0,1] off the tiled axis', () => {
    for (const layout of [walls, mixed, presetLayout('floors'), presetLayout('generic')]) {
      for (const face of [wall(0.05, 0.05), wall(40, 40), { widthM: 40, heightM: 40, useOn: 'floors' as const }]) {
        expectFiniteInside(matchHotspot(face, layout, NO_ROT), layout);
      }
    }
  });

  it('a corridor skirting with no strip in the layout takes the closest rect', () => {
    const generic = presetLayout('generic');
    expect(generic.rects.some((r) => r.tileU || r.tileV)).toBe(false);
    const fit = matchHotspot(wall(6, 0.2), generic, NO_ROT);
    expect(fit.tiled).toBe(false);
    expectFiniteInside(fit, generic);
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

  it('the seed only changes the pick among in-tolerance rects within 0.15 of the best', () => {
    // walls preset: the two 0.35 x 2.6 m pillar rects score about 0 and are the only ones within ±25 % of a
    // 0.35 x 2.6 m face.
    const windowed = new Set<string>();
    const single = new Set<string>();
    for (let seed = 0; seed < 32; seed++) {
      windowed.add(matchHotspot(wall(0.35, 2.6), walls, NO_ROT, { seed }).rectId);
      // 0.5 x 1.5 m falls through to the closest rect (step 3), which ignores the seed.
      single.add(matchHotspot(wall(0.5, 1.5), walls, NO_ROT, { seed }).rectId);
    }
    expect(windowed.size).toBe(2);
    expect(single.size).toBe(1);
    // Same seed, same answer.
    expect(matchHotspot(wall(0.35, 2.6), walls, NO_ROT, { seed: 7 })).toEqual(
      matchHotspot(wall(0.35, 2.6), walls, NO_ROT, { seed: 7 }),
    );
  });

  it('a rect just outside the 0.15 window is never picked, whatever the seed', () => {
    // 1 x 1 m face; all three rects are within ±25 %. Scores: exact 0, near 2.5 ln 1.05 = 0.122 (inside the
    // window), far 2.5 ln 1.07 = 0.169 (outside).
    const exact = makeRect({ id: 'exact', x: 0, y: 0, w: 100, h: 100 });
    const near = makeRect({ id: 'near', x: 100, y: 0, w: 105, h: 100 });
    const far = makeRect({ id: 'far', x: 205, y: 0, w: 107, h: 100 });
    const layout = custom([exact, near, far]);
    const seen = new Set<string>();
    for (let seed = 0; seed < 64; seed++) seen.add(matchHotspot(wall(1, 1), layout, NO_ROT, { seed }).rectId);
    expect([...seen].sort()).toEqual(['exact', 'near']);
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
