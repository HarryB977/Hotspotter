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
    macroHeight: new Float32Array(n * n), normal,
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
  });

  it('islands warns on an isolated blob with its centroid, and ignores damage touching the edge strip', () => {
    const m = flatMaps(256);
    edgeBand(m, 0);
    expect(get(runChecks(ctxWith(m)), 'islands').status).toBe('ok');
    for (let y = 120; y < 130; y++) for (let x = 100; x < 110; x++) m.wearMask[y * 256 + x] = 255;
    const r = get(runChecks(ctxWith(m)), 'islands');
    expect(r.status).toBe('warn');
    expect(r.rectIds).toEqual(['a']);
    expect(r.points).toEqual([[105, 125]]);
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

  it('proportions warns with the rotated period and points at the rect', () => {
    const material = { ...MATERIAL, period: { ...CONTINUOUS, y: 0.075, cutAllowedY: false } };
    const r = get(runChecks(ctxWith(flatMaps(256), { material })), 'proportions');
    expect(r.status).toBe('warn');
    expect(r.rectIds).toEqual(['a']);
    expect(r.points).toEqual([[128, 128]]);
    // 1 m is not a multiple of 0.075 on either axis: rotated, the period moves to X and still warns once.
    const rot = get(runChecks(ctxWith(flatMaps(256), { material, rotations: new Map([['a', true]]) })), 'proportions');
    expect(rot.rectIds).toEqual(['a']);
    expect(get(runChecks(ctxWith(flatMaps(256))), 'proportions').status).toBe('ok');
  });

  it('bleed warns when the groove floor is under 4 px at the export resolution', () => {
    const l8 = { ...layout1m(), worldWidthM: 8 };
    const low = get(runChecks(ctxWith(flatMaps(64), { layout: l8, exportResolutionPx: 512 })), 'bleed');
    expect(low.status).toBe('warn');
    expect(low.message).toMatch(/mip 2/);
    expect(get(runChecks(ctxWith(flatMaps(64), { layout: l8, exportResolutionPx: 8192 })), 'bleed').status).toBe('ok');
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

  it('jointMeanRgb averages joint pixels inside rects, outside the groove floor and the wear', () => {
    const n = 64;
    const maps = flatMaps(n);
    const base = new Uint8Array(n * n * 4);
    const pieceId = new Uint32Array(n * n).fill(1);
    for (let i = 0; i < n * n; i++) base.set([200, 0, 0, 255], i * 4);
    // A joint row in the middle: grey, half of it worn (red).
    for (let x = 0; x < n; x++) {
      const i = 32 * n + x;
      pieceId[i] = 0;
      if (x < n / 2) base.set([100, 110, 120, 255], i * 4);
      else maps.wearMask[i] = 255;
    }
    // The groove floor (5 cm wide → 1.6 px inside the rect at 64 px/m) has pieceId 0 too, and is dark.
    for (let x = 0; x < 2 * n; x++) { pieceId[x] = 0; base.set([0, 0, 0, 255], x * 4); }
    const layout = {
      ...layout1m(), widthPx: n, heightPx: n, rects: [makeRect({ id: 'a', x: 0, y: 0, w: n, h: n })],
      groove: { ...GROOVE, widthM: 0.05 },
    };
    expect(jointMeanRgb({ ...maps, baseColor: base, pieceId }, layout)).toEqual([100, 110, 120]);
    // The groove itself (rect id 0) is never a joint.
    const outside = { ...maps, rectId: new Uint32Array(n * n) };
    expect(jointMeanRgb({ ...outside, baseColor: base, pieceId }, layout)).toBeNull();
    const noJoints = jointMeanRgb({ ...maps, baseColor: base, pieceId: new Uint32Array(n * n).fill(1) }, layout);
    expect(noJoints).toBeNull();
  });
});
