import { describe, it, expect } from 'vitest';
import { placeMaterial, atlasPxToMaterialM } from '../src/placement';
import { makeRect, pxPerMetre } from '../src/layout';
import type { HotspotLayout } from '../src/layout';
import { CONTINUOUS } from '../src/period';
import type { MaterialPeriod } from '../src/period';

const layout: HotspotLayout = {
  version: 1, widthPx: 2048, heightPx: 2048, worldWidthM: 4,
  groove: { widthM: 0.006, depthM: 0.004, profile: 'bevel' },
  rects: [
    makeRect({ id: 'a', x: 0, y: 0, w: 1024, h: 512, allowRotation: true }),
    makeRect({ id: 'b', x: 1024, y: 0, w: 1024, h: 512, allowRotation: true }),
    makeRect({ id: 'c', x: 0, y: 512, w: 512, h: 1024 }),
    makeRect({ id: 'd', x: 512, y: 700, w: 700, h: 300, allowRotation: true }),
  ],
};
const ppm = pxPerMetre(layout);
const opts = { variation: 1, seed: 7, materialAllowsRotation: true, tileSizeM: [0.6, 0.6] as [number, number] };
const periodic: MaterialPeriod = { x: 0.3, y: 0.075, phaseX: 0.02, phaseY: 0.01, cutAllowedX: true, cutAllowedY: true };
const mod = (v: number, m: number) => ((v % m) + m) % m;
const corner = (r: { x: number; y: number; h: number }): [number, number] => [r.x, r.y + r.h];

describe('placeMaterial', () => {
  it('starts every rect on a joint when periods are set', () => {
    for (const variation of [0, 0.5, 1]) {
      const pls = placeMaterial(layout, periodic, { ...opts, variation });
      layout.rects.forEach((r, i) => {
        const [x, y] = atlasPxToMaterialM(layout, r, pls[i], corner(r));
        const ry = mod(y - periodic.phaseY, 0.075);
        const rx = mod(x - periodic.phaseX, 0.3);
        expect(Math.min(ry, 0.075 - ry)).toBeCloseTo(0, 9);
        expect(Math.min(rx, 0.3 - rx)).toBeCloseTo(0, 9);
      });
    }
  });

  it('keeps scale constant: 512 px advances exactly 1 m', () => {
    const pls = placeMaterial(layout, CONTINUOUS, { ...opts, variation: 0 });
    const r = layout.rects[0];
    const a = atlasPxToMaterialM(layout, r, pls[0], [r.x + 10, r.y + 10]);
    const b = atlasPxToMaterialM(layout, r, pls[0], [r.x + 10 + 512, r.y + 10]);
    expect(b[0] - a[0]).toBeCloseTo(1, 12);
    expect(b[1] - a[1]).toBeCloseTo(0, 12);
    const c = atlasPxToMaterialM(layout, r, pls[0], [r.x + 10, r.y + 10 + 512]);
    expect(a[1] - c[1]).toBeCloseTo(1, 12);
  });

  it('is continuous across a shared edge with variation 0 and CONTINUOUS', () => {
    const pls = placeMaterial(layout, CONTINUOUS, { ...opts, variation: 0 });
    const [a, b] = layout.rects;
    const left = atlasPxToMaterialM(layout, a, pls[0], [1024, 100.5]);
    const right = atlasPxToMaterialM(layout, b, pls[1], [1024, 100.5]);
    expect(right[0]).toBeCloseTo(left[0], 9);
    expect(right[1]).toBeCloseTo(left[1], 9);
    expect(ppm).toBe(512);
  });

  it('varies origins with variation 1; period offsets are multiples of the period', () => {
    const cont = placeMaterial(layout, CONTINUOUS, opts);
    const base = placeMaterial(layout, CONTINUOUS, { ...opts, variation: 0 });
    expect(cont.some((p, i) => p.originM[0] !== base[i].originM[0])).toBe(true);

    const per = placeMaterial(layout, periodic, opts);
    expect(new Set(per.map((p) => p.originM.join(','))).size).toBeGreaterThan(1);
    for (const p of per) {
      const kx = (p.originM[0] - periodic.phaseX) / 0.3;
      const ky = (p.originM[1] - periodic.phaseY) / 0.075;
      expect(kx).toBeCloseTo(Math.round(kx), 9);
      expect(ky).toBeCloseTo(Math.round(ky), 9);
    }
  });

  it('only rotates when rect, material and variation allow it', () => {
    const many = { ...layout, rects: Array.from({ length: 60 }, (_, i) =>
      makeRect({ id: `r${i}`, x: 0, y: 0, w: 8, h: 8, allowRotation: i % 2 === 0 })) };
    const on = placeMaterial(many, CONTINUOUS, opts);
    expect(on.some((p) => p.rotate90)).toBe(true);
    on.forEach((p, i) => { if (i % 2 === 1) expect(p.rotate90).toBe(false); });
    expect(placeMaterial(many, CONTINUOUS, { ...opts, materialAllowsRotation: false }).every((p) => !p.rotate90)).toBe(true);
    expect(placeMaterial(many, CONTINUOUS, { ...opts, variation: 0 }).every((p) => !p.rotate90)).toBe(true);
  });

  it('rotate90 maps the bottom-left corner to originM and keeps scale', () => {
    const r = layout.rects[0];
    const pl = { rectId: r.id, originM: [1, 2] as [number, number], rotate90: true };
    const o = atlasPxToMaterialM(layout, r, pl, corner(r));
    expect(o[0]).toBeCloseTo(1, 12);
    expect(o[1]).toBeCloseTo(2, 12);
    const m = atlasPxToMaterialM(layout, r, pl, [r.x + 512, r.y + r.h]);
    expect(m[0]).toBeCloseTo(1, 12);
    expect(m[1]).toBeCloseTo(1, 12);
  });

  it('is deterministic for a fixed seed', () => {
    expect(placeMaterial(layout, periodic, opts)).toEqual(placeMaterial(layout, periodic, opts));
    expect(placeMaterial(layout, periodic, opts)).not.toEqual(placeMaterial(layout, periodic, { ...opts, seed: 8 }));
  });
});
