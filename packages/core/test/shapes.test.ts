import { describe, expect, it } from 'vitest';
import { buildShape } from '../src/fit/shapes';
import type { ShapeFace, TestShape, Vec3 } from '../src/fit/shapes';

const SHAPES: TestShape[] = ['cube', 'wallWithOpenings', 'corridor', 'column', 'stairs'];
const EPS = 1e-4;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const center = (f: ShapeFace): Vec3 => scale(f.corners.reduce((s, c) => add(s, c), [0, 0, 0] as Vec3), 0.25);
const area = (f: ShapeFace) => f.quad.widthM * f.quad.heightM;
const sumArea = (fs: ShapeFace[]) => fs.reduce((s, f) => s + area(f), 0);

type Box = [Vec3, Vec3];
const inBox = (p: Vec3, [lo, hi]: Box) => p.every((v, i) => v > lo[i] && v < hi[i]);

/** Solid of each closed shape: inside a union of boxes and outside the cut-outs. */
const SOLIDS: Partial<Record<TestShape, (p: Vec3) => boolean>> = {
  cube: (p) => inBox(p, [[-1, 0, -1], [1, 2, 1]]),
  wallWithOpenings: (p) => inBox(p, [[-2, 0, -0.1], [2, 3, 0.1]])
    && !inBox(p, [[-1.5, -1, -1], [-0.5, 2.1, 1]]) // door
    && !inBox(p, [[0.2, 1, -1], [1.4, 2, 1]]), // window
  column: (p) => inBox(p, [[-0.3, 0, -0.3], [0.3, 0.2, 0.3]]) || inBox(p, [[-0.2, 0.2, -0.2], [0.2, 3.2, 0.2]]),
  stairs: (p) => Array.from({ length: 6 }, (_, i) => i).some((i) =>
    inBox(p, [[-0.6, 0, 0.84 - (i + 1) * 0.28], [0.6, (i + 1) * 0.18, 0.84 - i * 0.28]])),
};

/** Air inside the corridor: its interior minus the skirtings. */
const corridorSkirtings: Box[] = [[[-1, 0, -3], [-0.98, 0.15, 3]], [[0.98, 0, -3], [1, 0.15, 3]]];
const corridorAir = (p: Vec3) => inBox(p, [[-1, 0, -3], [1, 3, 3]]) && !corridorSkirtings.some((b) => inBox(p, b));

describe('buildShape', () => {
  it.each(SHAPES)('%s: every face is a rectangle whose corners follow the FaceQuad axes', (shape) => {
    for (const f of buildShape(shape)) {
      const [c0, c1, c2, c3] = f.corners;
      const { widthM: w, heightM: h } = f.quad;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(len(f.normal)).toBeCloseTo(1, 9);
      expect(len(sub(c1, c0))).toBeCloseTo(w, 9);
      expect(len(sub(c3, c0))).toBeCloseTo(h, 9);
      expect(dot(sub(c1, c0), sub(c3, c0))).toBeCloseTo(0, 9);
      const opposite = add(c1, sub(c3, c0));
      for (let i = 0; i < 3; i++) expect(c2[i]).toBeCloseTo(opposite[i], 9);
      // (c1 - c0) x (c3 - c0) = w·h·normal: CCW seen from the normal side.
      const n = scale(cross(sub(c1, c0), sub(c3, c0)), 1 / (w * h));
      for (let i = 0; i < 3; i++) expect(n[i]).toBeCloseTo(f.normal[i], 9);
    }
  });

  it.each(SHAPES)('%s: vertical faces run v up world Y, horizontal faces run v along world -Z', (shape) => {
    for (const f of buildShape(shape)) {
      const v = scale(sub(f.corners[3], f.corners[0]), 1 / f.quad.heightM);
      const expected: Vec3 = Math.abs(f.normal[1]) > 0.5 ? [0, 0, -1] : [0, 1, 0];
      for (let i = 0; i < 3; i++) expect(v[i]).toBeCloseTo(expected[i], 9);
    }
  });

  it.each(SHAPES)('%s: faces up are floors, faces down are ceilings, upright faces are walls', (shape) => {
    for (const f of buildShape(shape)) {
      const want = f.normal[1] > 0.5 ? 'floors' : f.normal[1] < -0.5 ? 'ceilings' : 'walls';
      expect(f.quad.useOn).toBe(want);
    }
  });

  it.each(SHAPES)('%s: no two faces overlap on the same plane', (shape) => {
    const faces = buildShape(shape);
    const bounds = faces.map((f) => [0, 1, 2].map((i) => [
      Math.min(...f.corners.map((c) => c[i])), Math.max(...f.corners.map((c) => c[i])),
    ]));
    for (let a = 0; a < faces.length; a++) {
      for (let b = a + 1; b < faces.length; b++) {
        const axis = faces[a].normal.findIndex((v) => Math.abs(v) > 0.5);
        if (Math.abs(faces[b].normal[axis]) < 0.5) continue;
        if (Math.abs(bounds[a][axis][0] - bounds[b][axis][0]) > 1e-9) continue;
        const overlap = [0, 1, 2].filter((i) => i !== axis).reduce((s, i) =>
          s * Math.max(0, Math.min(bounds[a][i][1], bounds[b][i][1]) - Math.max(bounds[a][i][0], bounds[b][i][0])), 1);
        expect(overlap, `faces ${a} and ${b} of ${shape}`).toBeLessThan(1e-9);
      }
    }
  });

  it.each(Object.keys(SOLIDS) as TestShape[])('%s: each normal leaves the solid (front side empty, back side solid)', (shape) => {
    const solid = SOLIDS[shape]!;
    for (const f of buildShape(shape)) {
      const c = center(f);
      expect(solid(add(c, scale(f.normal, EPS))), `front of face at ${c}`).toBe(false);
      expect(solid(add(c, scale(f.normal, -EPS))), `back of face at ${c}`).toBe(true);
    }
  });

  it('corridor: every normal points into the corridor (front side air, back side not)', () => {
    for (const f of buildShape('corridor')) {
      const c = center(f);
      expect(corridorAir(add(c, scale(f.normal, EPS))), `front of face at ${c}`).toBe(true);
      expect(corridorAir(add(c, scale(f.normal, -EPS))), `back of face at ${c}`).toBe(false);
    }
  });

  it('cube: 2 m, normals point away from its centroid', () => {
    const faces = buildShape('cube');
    // 6 sides of a closed cube.
    expect(faces).toHaveLength(6);
    const centroid: Vec3 = [0, 1, 0];
    for (const f of faces) {
      expect(dot(sub(center(f), centroid), f.normal)).toBeGreaterThan(0);
      expect([f.quad.widthM, f.quad.heightM]).toEqual([2, 2]);
    }
  });

  it('wallWithOpenings: big faces add up to 2·(12 − 2.1 − 1.2), plus the reveals', () => {
    const faces = buildShape('wallWithOpenings');
    // 12 big-face quads (6 per side around the door and window) + 7 reveals (door: 2 jambs + lintel;
    // window: 2 jambs + lintel + sill) + 2 ends + 1 top + 2 bottom quads (split by the door).
    expect(faces).toHaveLength(24);
    const big = faces.filter((f) => Math.abs(f.normal[2]) > 0.5);
    expect(big).toHaveLength(12);
    expect(sumArea(big)).toBeCloseTo(2 * (12 - 2.1 - 1.2), 9);

    const openings: Box[] = [[[-1.5, 0, -0.1], [-0.5, 2.1, 0.1]], [[0.2, 1, -0.1], [1.4, 2, 0.1]]];
    const inClosed = (p: Vec3, [lo, hi]: Box) => p.every((v, i) => v >= lo[i] - 1e-9 && v <= hi[i] + 1e-9);
    const reveals = faces.filter((f) => Math.abs(f.normal[2]) < 0.5 && openings.some((o) => inClosed(center(f), o)));
    expect(reveals).toHaveLength(7);
    // Jambs 2·0.2·2.1 + 2·0.2·1; lintels 0.2·1 + 0.2·1.2; sill 0.2·1.2.
    expect(sumArea(reveals)).toBeCloseTo(0.84 + 0.4 + 0.2 + 0.24 + 0.24, 9);
    expect(reveals.filter((f) => f.quad.useOn === 'walls')).toHaveLength(4);
    expect(reveals.filter((f) => f.quad.useOn === 'ceilings')).toHaveLength(2);
    expect(reveals.filter((f) => f.quad.useOn === 'floors')).toHaveLength(1);

    // Every face of the solid wall: front and back minus openings, reveals, ends 2·0.2·3, top 4·0.2, bottom (4−1)·0.2.
    expect(sumArea(faces)).toBeCloseTo(17.4 + 1.92 + 1.2 + 0.8 + 0.6, 9);
  });

  it('corridor: 2 × 3 × 6 with 0.15 m skirtings, open at both ends', () => {
    const faces = buildShape('corridor');
    // Floor, ceiling, 2 walls, 2 skirting fronts, 2 skirting tops.
    expect(faces).toHaveLength(8);
    const sizes = faces.map((f) => [f.quad.useOn, +f.quad.widthM.toFixed(6), +f.quad.heightM.toFixed(6)]);
    expect(sizes).toEqual(expect.arrayContaining([
      ['floors', 2, 6], ['ceilings', 2, 6], ['walls', 6, 3], ['walls', 6, 3],
      ['walls', 6, 0.15], ['walls', 6, 0.15], ['floors', 0.02, 6], ['floors', 0.02, 6],
    ]));
    // Open ends: no face looks along the corridor's length.
    expect(faces.every((f) => Math.abs(f.normal[2]) < 0.5)).toBe(true);
  });

  it('column: 0.4 × 0.4 × 3 shaft on a 0.6 × 0.6 × 0.2 base, the base top a ring around the shaft', () => {
    const faces = buildShape('column');
    // Base: 4 sides + 4 ring quads on top + bottom; shaft: 4 sides + top.
    expect(faces).toHaveLength(14);
    const ring = faces.filter((f) => f.normal[1] > 0.5 && Math.abs(center(f)[1] - 0.2) < 1e-9);
    expect(ring).toHaveLength(4);
    expect(sumArea(ring)).toBeCloseTo(0.36 - 0.16, 9);
    const shaftSides = faces.filter((f) => Math.abs(f.normal[1]) < 0.5 && f.quad.heightM > 1);
    expect(shaftSides).toHaveLength(4);
    for (const f of shaftSides) {
      expect(f.quad.widthM).toBeCloseTo(0.4, 9);
      expect(f.quad.heightM).toBeCloseTo(3, 9);
    }
  });

  it('stairs: 6 steps of 0.18 × 0.28 × 1.2, treads are floors', () => {
    const faces = buildShape('stairs');
    // 6 risers + 6 treads + 2 sides of 6 step columns each + back + underside.
    expect(faces).toHaveLength(26);
    const treads = faces.filter((f) => f.normal[1] > 0.5);
    expect(treads).toHaveLength(6);
    for (const t of treads) {
      expect(t.quad.useOn).toBe('floors');
      expect(t.quad.widthM).toBeCloseTo(1.2, 9);
      expect(t.quad.heightM).toBeCloseTo(0.28, 9);
    }
    const tops = treads.map((t) => center(t)[1]).sort((a, b) => a - b);
    tops.forEach((y, i) => expect(y).toBeCloseTo((i + 1) * 0.18, 9));
    const risers = faces.filter((f) => f.normal[2] > 0.5);
    expect(risers).toHaveLength(6);
    for (const r of risers) expect(r.quad.heightM).toBeCloseTo(0.18, 9);
    const undersides = faces.filter((f) => f.normal[1] < -0.5);
    expect(undersides.map((f) => f.quad.useOn)).toEqual(['ceilings']);
  });
});
