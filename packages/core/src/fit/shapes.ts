import type { FaceQuad } from './match';

export type Vec3 = [number, number, number];

export type TestShape = 'cube' | 'wallWithOpenings' | 'corridor' | 'column' | 'stairs';

export interface ShapeFace {
  quad: FaceQuad;
  /**
   * World corners in metres, Y up: the face's local (0,0), (w,0), (w,h), (0,h), so CCW seen from the side the
   * normal points to. Local v runs up world Y on upright faces and along world -Z on horizontal ones.
   */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** Unit normal: the side that is seen and textured. */
  normal: Vec3;
}

type UseOn = FaceQuad['useOn'];

const PX: Vec3 = [1, 0, 0], NX: Vec3 = [-1, 0, 0];
const PY: Vec3 = [0, 1, 0], NY: Vec3 = [0, -1, 0];
const PZ: Vec3 = [0, 0, 1], NZ: Vec3 = [0, 0, -1];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const absDot = (a: Vec3, b: Vec3) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);

/**
 * An axis-aligned rectangle spanning `lo`..`hi` (equal on the normal's axis), seen from `normal`.
 * v is world Y on upright faces and world -Z on horizontal ones; u = v × normal, so (u, v, normal) is right-handed.
 */
function rect(lo: Vec3, hi: Vec3, normal: Vec3, useOn: UseOn): ShapeFace {
  const v = normal[1] !== 0 ? NZ : PY;
  const u = cross(v, normal);
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const w = absDot(size, u), h = absDot(size, v);
  // Corner (0,0) sits at the low end of u and of v.
  const o: Vec3 = [0, 1, 2].map((i) => (u[i] + v[i] < 0 ? hi[i] : lo[i])) as Vec3;
  const at = (s: number, t: number): Vec3 => [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t];
  return { quad: { widthM: w, heightM: h, useOn }, corners: [at(0, 0), at(w, 0), at(w, h), at(0, h)], normal };
}

/** Faces of a box seen from outside, each kept only if `keep` allows its normal. */
function box(lo: Vec3, hi: Vec3, keep: (n: Vec3) => boolean = () => true): ShapeFace[] {
  const out: ShapeFace[] = [];
  const add = (a: Vec3, b: Vec3, n: Vec3, useOn: UseOn) => { if (keep(n)) out.push(rect(a, b, n, useOn)); };
  add([lo[0], lo[1], hi[2]], hi, PZ, 'walls');
  add(lo, [hi[0], hi[1], lo[2]], NZ, 'walls');
  add([hi[0], lo[1], lo[2]], hi, PX, 'walls');
  add(lo, [lo[0], hi[1], hi[2]], NX, 'walls');
  add([lo[0], hi[1], lo[2]], hi, PY, 'floors');
  add(lo, [hi[0], lo[1], hi[2]], NY, 'ceilings');
  return out;
}

/** A closed 2 m cube standing on the ground. */
function cube(): ShapeFace[] {
  return box([-1, 0, -1], [1, 2, 1]);
}

/**
 * A closed 4 × 3 × 0.2 wall with a 1 × 2.1 door and a 1.2 × 1 window (sill at 1). Front and back are split into
 * quads around the openings; the reveals face into the openings (jambs walls, lintel undersides ceilings, sill top
 * floors). The ends, top and bottom (two quads either side of the door) are generated too.
 */
function wallWithOpenings(): ShapeFace[] {
  const [x0, x1, y1, z0, z1] = [-2, 2, 3, -0.1, 0.1];
  const door = { x0: -1.5, x1: -0.5, y0: 0, y1: 2.1 };
  const win = { x0: 0.2, x1: 1.4, y0: 1, y1: 2 };
  // Columns of the face between the openings' edges, each with its solid spans [y0, y1].
  const columns: [number, number, [number, number][]][] = [
    [x0, door.x0, [[0, y1]]],
    [door.x0, door.x1, [[door.y1, y1]]],
    [door.x1, win.x0, [[0, y1]]],
    [win.x0, win.x1, [[0, win.y0], [win.y1, y1]]],
    [win.x1, x1, [[0, y1]]],
  ];
  const faces: ShapeFace[] = [];
  for (const [a, b, spans] of columns) {
    for (const [lo, hi] of spans) {
      faces.push(rect([a, lo, z1], [b, hi, z1], PZ, 'walls'));
      faces.push(rect([a, lo, z0], [b, hi, z0], NZ, 'walls'));
    }
  }
  for (const o of [door, win]) {
    faces.push(rect([o.x0, o.y0, z0], [o.x0, o.y1, z1], PX, 'walls'));
    faces.push(rect([o.x1, o.y0, z0], [o.x1, o.y1, z1], NX, 'walls'));
    faces.push(rect([o.x0, o.y1, z0], [o.x1, o.y1, z1], NY, 'ceilings'));
    if (o.y0 > 0) faces.push(rect([o.x0, o.y0, z0], [o.x1, o.y0, z1], PY, 'floors'));
  }
  faces.push(rect([x0, 0, z0], [x0, y1, z1], NX, 'walls'));
  faces.push(rect([x1, 0, z0], [x1, y1, z1], PX, 'walls'));
  faces.push(rect([x0, y1, z0], [x1, y1, z1], PY, 'floors'));
  faces.push(rect([x0, 0, z0], [door.x0, 0, z1], NY, 'ceilings'));
  faces.push(rect([door.x1, 0, z0], [x1, 0, z1], NY, 'ceilings'));
  return faces;
}

/** Skirting depth out of the corridor walls, metres. */
const SKIRTING_DEPTH = 0.02;
const SKIRTING_HEIGHT = 0.15;

/**
 * A 2 wide × 3 high × 6 long corridor along Z, seen from inside: every normal points into it. Both ends are open
 * so the camera can look in. The walls run the full 3 m; a 0.15 m skirting stands 0.02 m proud of each wall with
 * its front and top faces (its bottom rests on the floor, its back against the wall and its ends are open, so none
 * of those is generated). The wall strip behind a skirting is hidden but not coplanar with any face.
 */
function corridor(): ShapeFace[] {
  const [hw, h, hl] = [1, 3, 3];
  const sx = hw - SKIRTING_DEPTH;
  return [
    rect([-hw, 0, -hl], [hw, 0, hl], PY, 'floors'),
    rect([-hw, h, -hl], [hw, h, hl], NY, 'ceilings'),
    rect([-hw, 0, -hl], [-hw, h, hl], PX, 'walls'),
    rect([hw, 0, -hl], [hw, h, hl], NX, 'walls'),
    rect([-sx, 0, -hl], [-sx, SKIRTING_HEIGHT, hl], PX, 'walls'),
    rect([sx, 0, -hl], [sx, SKIRTING_HEIGHT, hl], NX, 'walls'),
    rect([-hw, SKIRTING_HEIGHT, -hl], [-sx, SKIRTING_HEIGHT, hl], PY, 'floors'),
    rect([sx, SKIRTING_HEIGHT, -hl], [hw, SKIRTING_HEIGHT, hl], PY, 'floors'),
  ];
}

/**
 * A closed 0.4 × 0.4 × 3 shaft standing on a closed 0.6 × 0.6 × 0.2 base. The base top is a ring of four quads
 * around the shaft (front and back strips full width, side strips between them), so no face lies under the shaft.
 */
function column(): ShapeFace[] {
  const [b, s, bh, top] = [0.3, 0.2, 0.2, 3.2];
  return [
    ...box([-b, 0, -b], [b, bh, b], (n) => n[1] <= 0),
    rect([-b, bh, s], [b, bh, b], PY, 'floors'),
    rect([-b, bh, -b], [b, bh, -s], PY, 'floors'),
    rect([-b, bh, -s], [-s, bh, s], PY, 'floors'),
    rect([s, bh, -s], [b, bh, s], PY, 'floors'),
    ...box([-s, bh, -s], [s, top, s], (n) => n[1] >= 0),
  ];
}

/**
 * Six solid steps (0.18 riser, 0.28 tread, 1.2 wide) climbing toward -Z from z = 0.84, each a block down to the
 * ground. Treads are floors; risers, the two stepped sides (one quad per step column) and the back are walls; the
 * underside is ceilings.
 */
function stairs(): ShapeFace[] {
  const [steps, rise, run, hw] = [6, 0.18, 0.28, 0.6];
  const front = (steps * run) / 2;
  const faces: ShapeFace[] = [];
  for (let i = 0; i < steps; i++) {
    const zf = front - i * run, zb = front - (i + 1) * run;
    const y0 = i * rise, y1 = (i + 1) * rise;
    faces.push(rect([-hw, y0, zf], [hw, y1, zf], PZ, 'walls'));
    faces.push(rect([-hw, y1, zb], [hw, y1, zf], PY, 'floors'));
    faces.push(rect([-hw, 0, zb], [-hw, y1, zf], NX, 'walls'));
    faces.push(rect([hw, 0, zb], [hw, y1, zf], PX, 'walls'));
  }
  faces.push(rect([-hw, 0, -front], [hw, steps * rise, -front], NZ, 'walls'));
  faces.push(rect([-hw, 0, -front], [hw, 0, front], NY, 'ceilings'));
  return faces;
}

const BUILDERS: Record<TestShape, () => ShapeFace[]> = { cube, wallWithOpenings, corridor, column, stairs };

/** The faces of a 3D test shape, in metres, standing on the ground plane y = 0 and centred on X and Z. */
export function buildShape(shape: TestShape): ShapeFace[] {
  return BUILDERS[shape]();
}
