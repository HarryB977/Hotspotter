import { describe, it, expect } from 'vitest';
import { CHECK_IDS, deltaE76, jointMeanRgb, meanRgb, runChecks } from '../src/checks';
import type { CheckContext, CheckResult, EvalMaps } from '../src/checks';
import { makeRect } from '../src/layout';
import type { HotspotLayout } from '../src/layout';
import { CONTINUOUS } from '../src/period';
import { DEFAULT_WEAR } from '../src/wear/params';
import type { WearParams } from '../src/wear/params';
import type { MaterialSettings } from '../src/material';

const GROOVE = { widthM: 0.006, bevelM: 0.003, depthM: 0.004, profile: 'bevel' as const };

/** One rect over the whole atlas: 1 m wide, `n` px at evaluation. */
function layout1m(): HotspotLayout {
  return {
    version: 1, widthPx: 256, heightPx: 256, worldWidthM: 1,
    rects: [makeRect({ id: 'a', x: 0, y: 0, w: 256, h: 256 })], groove: GROOVE,
  };
}

const MATERIAL: MaterialSettings = {
  name: 'm', files: {}, normalConvention: 'gl', roughnessIsGloss: false, tileSizeM: [1, 1], heightScaleM: 0.02,
  period: { ...CONTINUOUS }, allowRotation: false, orientation: { baseRotation: 0, rule: 'fixed' },
};

/** Flat maps of n × n px: rect 1 everywhere, flat normal and height, no wear. */
function flatMaps(n: number): EvalMaps {
  const normal = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) normal.set([128, 128, 255, 255], i * 4);
  return {
    width: n, height: n, rectId: new Uint32Array(n * n).fill(1), wearMask: new Uint8Array(n * n),
    macroHeight: new Float32Array(n * n), heightM: new Float32Array(n * n), normal,
    matNormal: new Float32Array(n * n * 4).map((_, i) => (i % 4 === 2 ? 1 : 0)),
  };
}

function ctxWith(maps: EvalMaps, patch: Partial<CheckContext> = {}, wear: Partial<WearParams> = {}): CheckContext {
  return {
    layout: layout1m(), rotations: new Map(), material: MATERIAL, wear: { ...DEFAULT_WEAR, ...wear },
    exportResolutionPx: 8192, maps, ...patch,
  };
}

function get(results: CheckResult[], id: CheckResult['id']): CheckResult {
  return results.find((r) => r.id === id)!;
}

/** Wear mask on every pixel within `bandPx` of the visible edge, except a gap of `gapM` along the top side. */
function edgeBand(maps: EvalMaps, gapM: number): void {
  const n = maps.width;
  const ppm = n; // 1 m atlas
  const bandPx = Math.ceil(0.006 * ppm) + 1;
  const gap0 = Math.floor(n / 2), gap1 = gap0 + Math.round(gapM * ppm);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const e = Math.min(x, y, n - 1 - x, n - 1 - y);
      if (e > bandPx) continue;
      if (y <= bandPx && x >= gap0 && x < gap1) continue;
      maps.wearMask[y * n + x] = 200;
    }
  }
}

describe('runChecks', () => {
  it('always returns the six checks in CheckId order', () => {
    const r = runChecks(ctxWith(flatMaps(64)));
    expect(r.map((x) => x.id)).toEqual(CHECK_IDS);
    expect(CHECK_IDS).toEqual(['coverage', 'islands', 'normal', 'proportions', 'bleed', 'substrate']);
    for (const x of r) expect(typeof x.message).toBe('string');
  });

  it('coverage warns on a 3 cm gap in the perimeter and not without it, at any resolution', () => {
    for (const n of [256, 512]) {
      const gap = flatMaps(n);
      edgeBand(gap, 0.03);
      const c = get(runChecks(ctxWith(gap)), 'coverage');
      expect(c.status).toBe('warn');
      expect(c.rectIds).toEqual(['a']);
      expect(c.points!.length).toBe(1);
      // The point is the middle of the gap, on the top edge.
      expect(c.points![0][0] / n).toBeCloseTo(0.5 + 0.015, 1);
      expect(c.points![0][1] / n).toBeLessThan(0.02);

      const small = flatMaps(n);
      edgeBand(small, 0.01);
      expect(get(runChecks(ctxWith(small)), 'coverage').status).toBe('ok');

      const full = flatMaps(n);
      edgeBand(full, 0);
      const ok = get(runChecks(ctxWith(full)), 'coverage');
      expect(ok.status).toBe('ok');
      expect(ok.rectIds).toEqual([]);
    }
  });

  it('coverage is skipped with minEdgeM 0, and coverage and islands are ok with the wear off', () => {
    const m = flatMaps(256);
    expect(get(runChecks(ctxWith(m, {}, { minEdgeM: 0 })), 'coverage').status).toBe('ok');
    const off = { ...flatMaps(256), wearMask: new Uint8Array(1) };
    const r = runChecks(ctxWith(off));
    for (const id of ['coverage', 'islands'] as const) {
      expect(get(r, id).status).toBe('ok');
      expect(get(r, id).message).toMatch(/desactivado/);
    }
    // A family that loses no material has no edge to cover.
    expect(get(runChecks(ctxWith(m, {}, { family: 'dent' })), 'coverage').status).toBe('ok');
    // A rim under one evaluation pixel (4 mm at 1.28 px/cm) cannot be checked.
    const skipped = get(runChecks(ctxWith(flatMaps(256), { layout: { ...layout1m(), worldWidthM: 2 } })), 'coverage');
    expect(skipped.status).toBe('ok');
    expect(skipped.message).toMatch(/más fino que un píxel/);
  });

  it('islands (R38): a lost speck beyond wEff, 2·bandM from other wear, warns; chips bridged to the strip do not', () => {
    // 256 px/m: bandM 6 mm = 1.54 px, so lost pixels join across centre distances ≤ 2.54 px (gap ≤ bandM); the strip
    // ends at wEff = 4 cm = 10.24 px from the visible edge, which lies 0.77 px in from the atlas edge.
    const m = flatMaps(256);
    edgeBand(m, 0); // lost to index distance 3 from the atlas edge
    expect(get(runChecks(ctxWith(m)), 'islands').status).toBe('ok');
    // A chip running 20 px in from the top band, connected to it.
    for (let y = 0; y < 24; y++) for (let x = 60; x < 66; x++) m.wearMask[y * 256 + x] = 200;
    // Chips at x 5–10 and x 12–16, each behind a one-pixel gap (3.9 mm < bandM): the outer one lies wholly beyond
    // wEff but is bridged to the strip, so ok.
    for (let y = 60; y < 63; y++) for (let x = 5; x < 17; x++) if (x !== 11) m.wearMask[y * 256 + x] = 200;
    // Faint wear (< 128) is not visibly lost: never an island.
    for (let y = 200; y < 203; y++) for (let x = 200; x < 203; x++) m.wearMask[y * 256 + x] = 100;
    expect(get(runChecks(ctxWith(m)), 'islands').status).toBe('ok');
    // A 3 × 3 px speck at x 20–22, beyond wEff, ≥ 2 · bandM (3.1 px) from all other wear: detached.
    for (let y = 120; y < 123; y++) for (let x = 20; x < 23; x++) m.wearMask[y * 256 + x] = 200;
    const r = get(runChecks(ctxWith(m)), 'islands');
    expect(r.status).toBe('warn');
    expect(r.rectIds).toEqual(['a']);
    expect(r.points).toEqual([[21.5, 121.5]]);
    // No area cap: a 10 × 10 px patch in the middle is an island too.
    for (let y = 120; y < 130; y++) for (let x = 100; x < 110; x++) m.wearMask[y * 256 + x] = 255;
    expect(get(runChecks(ctxWith(m)), 'islands').points).toEqual([[21.5, 121.5], [105, 125]]);
  });

  it('normal errors when more than 0.5 % of the steep pixels point against the slope', () => {
    const n = 128;
    const build = (flipEvery: number) => {
      const m = flatMaps(n);
      const mpp = 1 / n;
      const len = Math.hypot(0.5, 1);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          m.macroHeight[i] = 0.5 * x * mpp; // slope 0.5 towards +x
          m.heightM[i] = m.macroHeight[i];
          // The surface tilts towards −x; a flipped pixel points up the slope.
          const nx = (i % flipEvery === 0 ? 0.5 : -0.5) / len;
          m.normal[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
          m.normal[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        }
      }
      return m;
    };
    const bad = get(runChecks(ctxWith(build(100))), 'normal');
    expect(bad.status).toBe('error');
    expect(bad.points!.length).toBeGreaterThan(0);
    expect(get(runChecks(ctxWith(build(400))), 'normal').status).toBe('ok');
    expect(get(runChecks(ctxWith(flatMaps(n))), 'normal').status).toBe('ok');
  });

  it('normal (R40) only counts pixels where the macro slope beats the material relief', () => {
    const n = 128;
    const mpp = 1 / n;
    /** Macro slope 0.5 towards +x; material relief slope `rel` towards +x; normal tilted towards `nx` sign. */
    const build = (rel: number, nxSign: number) => {
      const m = flatMaps(n);
      const len = Math.hypot(0.5, 1);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          m.macroHeight[i] = 0.5 * x * mpp;
          m.heightM[i] = m.macroHeight[i] + rel * x * mpp;
          m.normal[i * 4] = Math.round(((nxSign * 0.5) / len * 0.5 + 0.5) * 255);
          m.normal[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        }
      }
      return m;
    };
    // The material relief (slope −2: total −1.5, towards −x) dominates and opposes the macro slope: the normal follows
    // the material (tilts towards +x), which is right.
    expect(get(runChecks(ctxWith(build(-2, 1))), 'normal').status).toBe('ok');
    // The macro slope dominates (material relief 0.1) and the normal is inverted: still an error.
    expect(get(runChecks(ctxWith(build(0.1, 1))), 'normal').status).toBe('error');
    // Same with the correct normal: ok.
    expect(get(runChecks(ctxWith(build(0.1, -1))), 'normal').status).toBe('ok');
  });

  it('normal (R41) also takes the material relief from the detail normal', () => {
    const n = 128;
    const mpp = 1 / n;
    /** Macro slope 0.5 towards +x, flat height relief; detail normal of slope `matSlope` towards +x (height falls). */
    const build = (matSlope: number, nxSign: number) => {
      const m = flatMaps(n);
      const len = Math.hypot(0.5, 1);
      for (let i = 0; i < n * n; i++) {
        const x = i % n;
        m.macroHeight[i] = 0.5 * x * mpp;
        m.heightM[i] = m.macroHeight[i];
        // Unnormalised on purpose: the check uses |n.xy| / n.z.
        m.matNormal.set([matSlope, 0, 1, 0], i * 4);
        m.normal[i * 4] = Math.round(((nxSign * 0.5) / len * 0.5 + 0.5) * 255);
        m.normal[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      }
      return m;
    };
    // Relief only in the normal map (slope 1.5, opposing the macro slope): the normal follows it, ok.
    expect(get(runChecks(ctxWith(build(1.5, 1))), 'normal').status).toBe('ok');
    // A weak detail normal (0.1): the macro dominates, and an inverted normal is still an error.
    expect(get(runChecks(ctxWith(build(0.1, 1))), 'normal').status).toBe('error');
    expect(get(runChecks(ctxWith(build(0.1, -1))), 'normal').status).toBe('ok');
  });

  it('proportions uses the rotated period and points at the rect', () => {
    // 0.75 × 1 m with only Y periodic (0.075 m): 1 m is not a multiple, 0.75 m is.
    const layout = { ...layout1m(), rects: [makeRect({ id: 'a', x: 0, y: 0, w: 192, h: 256 })] };
    const material = { ...MATERIAL, period: { ...CONTINUOUS, y: 0.075, cutAllowedY: false } };
    const r = get(runChecks(ctxWith(flatMaps(256), { layout, material })), 'proportions');
    expect(r.status).toBe('warn');
    expect(r.rectIds).toEqual(['a']);
    expect(r.points).toEqual([[96, 128]]);
    // Rotated, the period moves to the 0.75 m X side, which fits it.
    const rotations = new Map([['a', true]]);
    expect(get(runChecks(ctxWith(flatMaps(256), { layout, material, rotations })), 'proportions').status).toBe('ok');
    expect(get(runChecks(ctxWith(flatMaps(256), { layout })), 'proportions').status).toBe('ok');
  });

  it('bleed warns when the visible groove (floor + 2 bevels) is under 4 px at the export resolution', () => {
    const l8 = { ...layout1m(), worldWidthM: 8 };
    const bleed = (layout: HotspotLayout, exportResolutionPx: number) =>
      get(runChecks(ctxWith(flatMaps(64), { layout, exportResolutionPx })), 'bleed');
    // 6 mm + 2 · 3 mm = 12 mm in 8 m: 6.1 px at 4096 (the defaults), 0.77 px at 512.
    expect(bleed(l8, 4096).status).toBe('ok');
    const low = bleed(l8, 512);
    expect(low.status).toBe('warn');
    expect(low.message).toMatch(/mip 2/);
    expect(low.message).toMatch(/la ranura o el bisel/);
    // Without a bevel the 6 mm floor alone is 3.1 px at 4096.
    expect(bleed({ ...l8, groove: { ...GROOVE, bevelM: 0 } }, 4096).status).toBe('warn');
  });

  it('substrate warns when the second set does not match the joints (ΔE76 > 20)', () => {
    const second = { substrate: { ...DEFAULT_WEAR.substrate, source: 'secondSet' as const } };
    const far = { substrateMeanRgb: [200, 60, 40] as [number, number, number], jointMeanRgb: [120, 120, 120] as [number, number, number] };
    expect(get(runChecks(ctxWith(flatMaps(64), far, second)), 'substrate').status).toBe('warn');
    const near = { substrateMeanRgb: [122, 119, 118] as [number, number, number], jointMeanRgb: [120, 120, 120] as [number, number, number] };
    expect(get(runChecks(ctxWith(flatMaps(64), near, second)), 'substrate').status).toBe('ok');
    // Interior substrate, or no means (no pieces / no second set loaded): nothing to compare.
    expect(get(runChecks(ctxWith(flatMaps(64), far)), 'substrate').status).toBe('ok');
    expect(get(runChecks(ctxWith(flatMaps(64), {}, second)), 'substrate').status).toBe('ok');
  });
});

describe('colour helpers', () => {
  it('deltaE76 goes through linear sRGB, XYZ (D65) and Lab', () => {
    expect(deltaE76([120, 120, 120], [120, 120, 120])).toBe(0);
    // Black to white is ΔL = 100.
    expect(deltaE76([0, 0, 0], [255, 255, 255])).toBeCloseTo(100, 1);
    expect(deltaE76([200, 60, 40], [120, 120, 120])).toBeGreaterThan(20);
  });

  it('meanRgb averages RGBA8 pixels', () => {
    expect(meanRgb(new Uint8Array([10, 20, 30, 255, 30, 40, 50, 0]))).toEqual([20, 30, 40]);
  });

  it('jointMeanRgb averages the material base colour where the piece id is 0', () => {
    const base = new Uint8Array([100, 110, 120, 255, 200, 0, 0, 255, 120, 130, 140, 255]);
    expect(jointMeanRgb(base, new Uint32Array([0, 3, 0]))).toEqual([110, 120, 130]);
    expect(jointMeanRgb(base, new Uint32Array([1, 3, 2]))).toBeNull();
  });
});
