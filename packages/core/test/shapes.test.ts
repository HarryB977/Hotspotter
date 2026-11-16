import { describe, expect, it } from 'vitest';
import { buildShape, SHAPE_PARTS, STOREY_HEIGHT_M } from '../src/fit/shapes';
import type { ShapeFace, ShapePart, TestShape, Vec3 } from '../src/fit/shapes';

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
const ofPart = (fs: ShapeFace[], part: ShapePart) => fs.filter((f) => f.part === part);
const size = (f: ShapeFace) => [+f.quad.widthM.toFixed(6), +f.quad.heightM.toFixed(6)];

/** World point at local (s, t) metres on a face. */
const at = (f: ShapeFace, s: number, t: number): Vec3 => {
  const [c0, c1, , c3] = f.corners;
  return add(c0, add(scale(sub(c1, c0), s / f.quad.widthM), scale(sub(c3, c0), t / f.quad.heightM)));
};
const inHole = (f: ShapeFace, s: number, t: number) =>
  (f.holes ?? []).some(([s0, t0, s1, t1]) => s > s0 && s < s1 && t > t0 && t < t1);

/** Sample points spread over a face, off its edges: local (s, t) metres and the world point. */
const samples = (f: ShapeFace, n: number) => Array.from({ length: n * n }, (_, k) => {
  const s = (((k % n) + 0.5) / n) * f.quad.widthM, t = ((Math.floor(k / n) + 0.5) / n) * f.quad.heightM;
  return { s, t, p: at(f, s, t) };
});

type Box = [Vec3, Vec3];
const inBox = (p: Vec3, [lo, hi]: Box) => p.every((v, i) => v > lo[i] && v < hi[i]);
const inClosed = (p: Vec3, [lo, hi]: Box) => p.every((v, i) => v >= lo[i] - 1e-9 && v <= hi[i] + 1e-9);

/** wallWithOpenings: the openings cut through everything, each frame's outer box (0.09 around its opening, 0.025 proud). */
const DOOR: Box = [[-1.5, -1, -1], [-0.5, 2.1, 1]];
const WINDOW: Box = [[0.2, 1, -1], [1.4, 2, 1]];
const FRAME_OUTER: Box[] = [[[-1.59, -1, -0.125], [-0.41, 2.19, 0.125]], [[0.11, 0.91, -0.125], [1.49, 2.09, 0.125]]];
const WALL_COLUMNS: Box[] = [[[-2, 0, 0.1], [-1.65, 2.6, 0.25]], [[1.65, 0, 0.1], [2, 2.6, 0.25]]];

/** Solid of each closed shape: inside a union of boxes and outside the cut-outs. */
const SOLIDS: Partial<Record<TestShape, (p: Vec3) => boolean>> = {
  cube: (p) => inBox(p, [[-1, 0, -1], [1, 2, 1]]),
  wallWithOpenings: (p) => WALL_COLUMNS.some((b) => inBox(p, b))
    || ((inBox(p, [[-2, 0, -0.1], [2, 2.6, 0.1]]) || FRAME_OUTER.some((b) => inBox(p, b)))
      && !inBox(p, DOOR) && !inBox(p, WINDOW)),
  column: (p) => inBox(p, [[-0.3, 0, -0.3], [0.3, 0.2, 0.3]]) || inBox(p, [[-0.2, 0.2, -0.2], [0.2, 3.2, 0.2]]),
  stairs: (p) => Array.from({ length: 6 }, (_, i) => i).some((i) =>
    inBox(p, [[-0.6, 0, 0.84 - (i + 1) * 0.28], [0.6, (i + 1) * 0.18, 0.84 - i * 0.28]])),
};

/** Air inside the corridor: its interior minus the skirtings and the columns. */
const COLUMN_Z = [-2, 0, 2];
const corridorColumns: Box[] = COLUMN_Z.flatMap((z): Box[] => [
  [[-1, 0, z - 0.175], [-0.85, 2.6, z + 0.175]], [[0.85, 0, z - 0.175], [1, 2.6, z + 0.175]],
]);
const corridorSkirtings: Box[] = [[[-1, 0, -3], [-0.98, 0.15, 3]], [[0.98, 0, -3], [1, 0.15, 3]]];
const corridorAir = (p: Vec3) => inBox(p, [[-1, 0, -3], [1, 2.6, 3]])
  && !corridorSkirtings.some((b) => inBox(p, b)) && !corridorColumns.some((b) => inBox(p, b));

describe('buildShape', () => {
  it('storey height is 2.6 m', () => {
    expect(STOREY_HEIGHT_M).toBe(2.6);
  });

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
      // Holes are non-empty and lie inside the face.
      for (const [s0, t0, s1, t1] of f.holes ?? []) {
        expect(s0).toBeGreaterThanOrEqual(-1e-9);
        expect(t0).toBeGreaterThanOrEqual(-1e-9);
        expect(s1).toBeLessThanOrEqual(w + 1e-9);
        expect(t1).toBeLessThanOrEqual(h + 1e-9);
        expect(s1).toBeGreaterThan(s0);
        expect(t1).toBeGreaterThan(t0);
      }
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
      expect(inHole(f, f.quad.widthM / 2, f.quad.heightM / 2), `centre of face at ${c} in a hole`).toBe(false);
      expect(solid(add(c, scale(f.normal, EPS))), `front of face at ${c}`).toBe(false);
      // Across the whole face: solid behind it, except inside a hole, which is air on both sides.
      for (const { s, t, p } of samples(f, 40)) {
        const hole = inHole(f, s, t);
        expect(solid(add(p, scale(f.normal, -EPS))), `back of face at ${p}`).toBe(!hole);
        if (hole) expect(solid(add(p, scale(f.normal, EPS))), `front of hole at ${p}`).toBe(false);
      }
    }
  });

  it('corridor: every normal points into the corridor (front side air, back side not)', () => {
    for (const f of buildShape('corridor')) {
      const points = samples(f, 12);
      // Columns and skirtings hide part of each wall, so only most of a face has air in front.
      const front = points.filter(({ p }) => corridorAir(add(p, scale(f.normal, EPS)))).length;
      expect(front / points.length, `front of face at ${center(f)}`).toBeGreaterThan(0.75);
      for (const { p } of points) {
        expect(corridorAir(add(p, scale(f.normal, -EPS))), `back of face at ${p}`).toBe(false);
      }
    }
  });

  it('SHAPE_PARTS lists the parts of each shape in UI order, and every face uses a listed part', () => {
    expect(SHAPE_PARTS).toEqual({
      cube: ['body'],
      wallWithOpenings: ['wall', 'columns', 'frames'],
      corridor: ['wall', 'columns', 'skirting', 'floor', 'ceiling'],
      column: ['body'],
      stairs: ['body'],
    });
    for (const shape of SHAPES) {
      const used = new Set(buildShape(shape).map((f) => f.part));
      // Every face's part is listed, and every listed part has faces.
      expect([...used].sort(), shape).toEqual([...SHAPE_PARTS[shape]].sort());
    }
  });

  it('cube: 2 m, normals point away from its centroid', () => {
    const faces = buildShape('cube');
    // 6 sides of a closed cube.
    expect(faces).toHaveLength(6);
    expect(ofPart(faces, 'body')).toHaveLength(6);
    const centroid: Vec3 = [0, 1, 0];
    for (const f of faces) {
      expect(dot(sub(center(f), centroid), f.normal)).toBeGreaterThan(0);
      expect([f.quad.widthM, f.quad.heightM]).toEqual([2, 2]);
    }
  });

  it('wallWithOpenings: one 4 × 2.6 face per side, with the door and the window as holes', () => {
    const faces = buildShape('wallWithOpenings');
    const big = faces.filter((f) => Math.abs(f.normal[2]) > 0.5 && f.part === 'wall');
    expect(big).toHaveLength(2);
    const front = big.find((f) => f.normal[2] > 0)!;
    const back = big.find((f) => f.normal[2] < 0)!;
    for (const f of big) expect(size(f)).toEqual([4, 2.6]);
    const round = (h: number[]) => h.map((v) => +v.toFixed(6));
    // Front: s runs along +X from x = -2.
    expect(front.holes!.map(round)).toEqual([[0.5, 0, 1.5, 2.1], [2.2, 1, 3.4, 2]]);
    // Back: s runs along -X from x = 2, so each opening is mirrored, s = 2 - x.
    expect(back.holes!.map(round)).toEqual([[2.5, 0, 3.5, 2.1], [0.6, 1, 1.8, 2]]);
    const solidArea = (f: ShapeFace) => area(f) - f.holes!.reduce((s, [s0, t0, s1, t1]) => s + (s1 - s0) * (t1 - t0), 0);
    expect(solidArea(front)).toBeCloseTo(4 * 2.6 - 2.1 - 1.2, 9);
    expect(solidArea(back)).toBeCloseTo(4 * 2.6 - 2.1 - 1.2, 9);
    // Only the two big faces have holes.
    expect(faces.filter((f) => f.holes?.length)).toHaveLength(2);
  });

  it('wallWithOpenings: face counts per part', () => {
    const faces = buildShape('wallWithOpenings');
    // Front + back + 2 ends + top + 2 bottom quads either side of the door.
    expect(ofPart(faces, 'wall')).toHaveLength(7);
    // 2 columns × (front + 2 sides + top).
    expect(ofPart(faces, 'columns')).toHaveLength(8);
    // Window: 4 band quads per side (8) + 4 outer edges per side (8) + 4 linings = 20.
    // Door: 3 band quads per side (6) + 3 outer edges per side (6) + 3 linings = 15.
    expect(ofPart(faces, 'frames')).toHaveLength(35);
    expect(faces).toHaveLength(50);
  });

  it('wallWithOpenings: frames line each opening through its full depth, and no wall face lies in a lining', () => {
    const faces = buildShape('wallWithOpenings');
    const frames = ofPart(faces, 'frames');
    expect(frames.every((f) => f.part === 'frames')).toBe(true);
    // The opening volumes, through the wall and the frames' proud parts.
    const linings: Box[] = [[[-1.5, 0, -0.125], [-0.5, 2.1, 0.125]], [[0.2, 1, -0.125], [1.4, 2, 0.125]]];
    const lining = frames.filter((f) => linings.some((o) => f.corners.every((c) => inClosed(c, o))));
    // Door: 2 jambs + head (no bottom); window: 2 jambs + head + sill.
    expect(lining).toHaveLength(7);
    for (const f of lining) {
      const zs = f.corners.map((c) => c[2]);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.25, 9);
      // The lining faces into its opening.
      const o = linings.find((b) => f.corners.every((c) => inClosed(c, b)))!;
      expect(inBox(add(center(f), scale(f.normal, EPS)), o)).toBe(true);
    }
    // Door: 2·0.25·2.1 + 0.25·1; window: 2·0.25·1 + 2·0.25·1.2.
    expect(sumArea(lining)).toBeCloseTo(1.05 + 0.25 + 0.5 + 0.6, 9);
    for (const f of ofPart(faces, 'wall')) {
      for (const { s, t, p } of samples(f, 20)) {
        if (inHole(f, s, t)) continue;
        expect(linings.some((o) => inBox(p, o)), `wall face point ${p}`).toBe(false);
      }
    }
    // Band fronts: 0.09 wide on the wall face, 0.025 proud of it.
    const bands = frames.filter((f) => Math.abs(f.normal[2]) > 0.5);
    expect(bands).toHaveLength(14);
    for (const f of bands) {
      expect(f.corners[0][2]).toBeCloseTo(0.125 * f.normal[2], 9);
      expect(Math.min(f.quad.widthM, f.quad.heightM)).toBeCloseTo(0.09, 9);
    }
    // Outer edges: 0.025 deep, one per band quad.
    const edges = frames.filter((f) => !lining.includes(f) && Math.abs(f.normal[2]) < 0.5);
    expect(edges).toHaveLength(14);
    for (const f of edges) expect(Math.min(f.quad.widthM, f.quad.heightM)).toBeCloseTo(0.025, 9);
  });

  it('wallWithOpenings: a 0.35 × 0.15 × 2.6 column at each end of the front', () => {
    const columns = ofPart(buildShape('wallWithOpenings'), 'columns');
    const fronts = columns.filter((f) => f.normal[2] > 0.5);
    expect(fronts).toHaveLength(2);
    for (const f of fronts) expect(size(f)).toEqual([0.35, 2.6]);
    expect(fronts.map((f) => +center(f)[0].toFixed(6)).sort((a, b) => a - b)).toEqual([-1.825, 1.825]);
    const sides = columns.filter((f) => Math.abs(f.normal[0]) > 0.5);
    expect(sides).toHaveLength(4);
    for (const f of sides) expect(size(f)).toEqual([0.15, 2.6]);
    expect(columns.filter((f) => f.normal[1] > 0.5)).toHaveLength(2);
    // No back (against the wall) and no bottom.
    expect(columns.some((f) => f.normal[2] < -0.5 || f.normal[1] < -0.5)).toBe(false);
  });

  it('corridor: 2 × 2.6 × 6 with columns and skirtings split around them, open at both ends', () => {
    const faces = buildShape('corridor');
    expect(ofPart(faces, 'floor')).toHaveLength(1);
    expect(ofPart(faces, 'ceiling')).toHaveLength(1);
    // One face per wall.
    expect(ofPart(faces, 'wall')).toHaveLength(2);
    // 3 columns per wall × 2 walls × (front + 2 sides).
    expect(ofPart(faces, 'columns')).toHaveLength(18);
    // 4 segments per wall (split by its 3 columns) × 2 walls × (front + top).
    expect(ofPart(faces, 'skirting')).toHaveLength(16);
    expect(faces).toHaveLength(38);

    expect(size(ofPart(faces, 'floor')[0])).toEqual([2, 6]);
    expect(size(ofPart(faces, 'ceiling')[0])).toEqual([2, 6]);
    for (const f of ofPart(faces, 'wall')) expect(size(f)).toEqual([6, 2.6]);

    const columns = ofPart(faces, 'columns');
    const colFronts = columns.filter((f) => Math.abs(f.normal[0]) > 0.5);
    const colSides = columns.filter((f) => Math.abs(f.normal[2]) > 0.5);
    expect(colFronts).toHaveLength(6);
    expect(colSides).toHaveLength(12);
    for (const f of colFronts) expect(size(f)).toEqual([0.35, 2.6]);
    for (const f of colSides) expect(size(f)).toEqual([0.15, 2.6]);
    expect(colFronts.map((f) => +center(f)[2].toFixed(6) + 0).sort((a, b) => a - b)).toEqual([-2, -2, 0, 0, 2, 2]);

    const skirting = ofPart(faces, 'skirting');
    for (const f of skirting) {
      const zs = f.corners.map((c) => c[2]);
      const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
      for (const z of COLUMN_Z) expect(z1 <= z - 0.175 + 1e-9 || z0 >= z + 0.175 - 1e-9, `skirting ${z0}..${z1}`).toBe(true);
    }
    // Fronts 0.15 high and tops 0.02 deep, spanning each wall minus its columns.
    const skFronts = skirting.filter((f) => Math.abs(f.normal[0]) > 0.5);
    const skTops = skirting.filter((f) => f.normal[1] > 0.5);
    expect(skFronts).toHaveLength(8);
    expect(skTops).toHaveLength(8);
    for (const f of skFronts) expect(f.quad.heightM).toBeCloseTo(0.15, 9);
    for (const f of skTops) expect(f.quad.widthM).toBeCloseTo(0.02, 9);
    expect(skFronts.reduce((s, f) => s + f.quad.widthM, 0)).toBeCloseTo(2 * (6 - 3 * 0.35), 9);
    // Open ends: only the column sides look along the corridor.
    expect(faces.filter((f) => Math.abs(f.normal[2]) > 0.5).every((f) => f.part === 'columns')).toBe(true);
  });

  it('column: 0.4 × 0.4 × 3 shaft on a 0.6 × 0.6 × 0.2 base, the base top a ring around the shaft', () => {
    const faces = buildShape('column');
    // Base: 4 sides + 4 ring quads on top + bottom; shaft: 4 sides + top.
    expect(faces).toHaveLength(14);
    expect(ofPart(faces, 'body')).toHaveLength(14);
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
    expect(ofPart(faces, 'body')).toHaveLength(26);
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
