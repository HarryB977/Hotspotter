import type { FaceQuad } from './match';

export type Vec3 = [number, number, number];

export type TestShape = 'cube' | 'wallWithOpenings' | 'corridor' | 'column' | 'stairs';

/** A named part of a test shape; the 3D view chooses per part whether it gets the hotspot texture. */
export type ShapePart = 'body' | 'wall' | 'columns' | 'frames' | 'skirting' | 'floor' | 'ceiling';

/** Storey height in metres: the walls, columns and corridor of the test shapes are this tall. */
export const STOREY_HEIGHT_M = 2.6;

/** Parts present in each shape, in UI order. */
export const SHAPE_PARTS: Record<TestShape, readonly ShapePart[]> = {
  cube: ['body'],
  wallWithOpenings: ['wall', 'columns', 'frames'],
  corridor: ['wall', 'columns', 'skirting', 'floor', 'ceiling'],
  column: ['body'],
  stairs: ['body'],
};

export interface ShapeFace {
  quad: FaceQuad;
  /**
   * World corners in metres, Y up: the face's local (0,0), (w,0), (w,h), (0,h), so CCW seen from the side the
   * normal points to. Local v runs up world Y on upright faces and along world -Z on horizontal ones.
   */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** Unit normal: the side that is seen and textured. */
  normal: Vec3;
  part: ShapePart;
  /** Openings cut through the face, as local rects [s0, t0, s1, t1] in metres (s along corners[0]→[1], t along [0]→[3]). */
  holes?: [number, number, number, number][];
}

type Box = [Vec3, Vec3];

const PX: Vec3 = [1, 0, 0], NX: Vec3 = [-1, 0, 0];
const PY: Vec3 = [0, 1, 0], NY: Vec3 = [0, -1, 0];
const PZ: Vec3 = [0, 0, 1], NZ: Vec3 = [0, 0, -1];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * An axis-aligned rectangle spanning `lo`..`hi` (equal on the normal's axis), seen from `normal`.
 * v is world Y on upright faces and world -Z on horizontal ones; u = v × normal, so (u, v, normal) is right-handed.
 * Faces up are floors, faces down ceilings, upright faces walls. Each of `openings` (a world box through the face)
 * becomes a hole in the face's local metres.
 */
function rect(lo: Vec3, hi: Vec3, normal: Vec3, part: ShapePart, openings: Box[] = []): ShapeFace {
  const v = normal[1] !== 0 ? NZ : PY;
  const u = cross(v, normal);
  const useOn = normal[1] > 0 ? 'floors' : normal[1] < 0 ? 'ceilings' : 'walls';
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const w = Math.abs(dot(size, u)), h = Math.abs(dot(size, v));
  // Corner (0,0) sits at the low end of u and of v.
  const o: Vec3 = [0, 1, 2].map((i) => (u[i] + v[i] < 0 ? hi[i] : lo[i])) as Vec3;
  const at = (s: number, t: number): Vec3 => [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t];
  const face: ShapeFace = { quad: { widthM: w, heightM: h, useOn }, corners: [at(0, 0), at(w, 0), at(w, h), at(0, h)], normal, part };
  if (openings.length > 0) {
    const local = (p: Vec3, axis: Vec3) => dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], axis);
    const range = (a: Vec3, b: Vec3, axis: Vec3) => [local(a, axis), local(b, axis)].sort((x, y) => x - y);
    face.holes = openings.map(([a, b]) => {
      const [s0, s1] = range(a, b, u), [t0, t1] = range(a, b, v);
      return [s0, t0, s1, t1];
    });
  }
  return face;
}

/** Faces of a box seen from outside, each kept only if `keep` allows its normal. */
function box(lo: Vec3, hi: Vec3, part: ShapePart, keep: (n: Vec3) => boolean = () => true): ShapeFace[] {
  const out: ShapeFace[] = [];
  const add = (a: Vec3, b: Vec3, n: Vec3) => { if (keep(n)) out.push(rect(a, b, n, part)); };
  add([lo[0], lo[1], hi[2]], hi, PZ);
  add(lo, [hi[0], hi[1], lo[2]], NZ);
  add([hi[0], lo[1], lo[2]], hi, PX);
  add(lo, [lo[0], hi[1], hi[2]], NX);
  add([lo[0], hi[1], lo[2]], hi, PY);
  add(lo, [hi[0], lo[1], hi[2]], NY);
  return out;
}

/** A closed 2 m cube standing on the ground. */
function cube(): ShapeFace[] {
  return box([-1, 0, -1], [1, 2, 1], 'body');
}

/** Section of the columns against a wall, metres: width along the wall and how far it stands proud of it. */
const COLUMN_WIDTH = 0.35;
const COLUMN_DEPTH = 0.15;
/** Width of a frame on each wall face and how far it stands proud of the face, metres. */
const FRAME_WIDTH = 0.09;
const FRAME_PROUD = 0.025;

interface Opening { x0: number; x1: number; y0: number; y1: number }

/**
 * The frame of an opening through a wall spanning z0..z1. On each wall face, a band FRAME_WIDTH wide around the
 * opening, FRAME_PROUD proud of the face: its front (head and sill strips full width, jambs between them) and its
 * outer edges. Inside, a lining over each side of the opening through the full depth, both bands included, facing
 * into the opening. An opening on the ground (y0 = 0) is a door: nothing along its bottom.
 */
function frame(o: Opening, z0: number, z1: number): ShapeFace[] {
  const door = o.y0 <= 0;
  const [zb, zf] = [z0 - FRAME_PROUD, z1 + FRAME_PROUD];
  const [ox0, ox1] = [o.x0 - FRAME_WIDTH, o.x1 + FRAME_WIDTH];
  const [oy0, oy1] = [door ? 0 : o.y0 - FRAME_WIDTH, o.y1 + FRAME_WIDTH];
  const faces: ShapeFace[] = [];
  for (const [front, wall, n] of [[zf, z1, PZ], [zb, z0, NZ]] as [number, number, Vec3][]) {
    faces.push(rect([ox0, o.y1, front], [ox1, oy1, front], n, 'frames'));
    if (!door) faces.push(rect([ox0, oy0, front], [ox1, o.y0, front], n, 'frames'));
    faces.push(rect([ox0, o.y0, front], [o.x0, o.y1, front], n, 'frames'));
    faces.push(rect([o.x1, o.y0, front], [ox1, o.y1, front], n, 'frames'));
    const [za, zz] = [Math.min(front, wall), Math.max(front, wall)];
    faces.push(rect([ox0, oy0, za], [ox0, oy1, zz], NX, 'frames'));
    faces.push(rect([ox1, oy0, za], [ox1, oy1, zz], PX, 'frames'));
    faces.push(rect([ox0, oy1, za], [ox1, oy1, zz], PY, 'frames'));
    if (!door) faces.push(rect([ox0, oy0, za], [ox1, oy0, zz], NY, 'frames'));
  }
  faces.push(rect([o.x0, o.y0, zb], [o.x0, o.y1, zf], PX, 'frames'));
  faces.push(rect([o.x1, o.y0, zb], [o.x1, o.y1, zf], NX, 'frames'));
  faces.push(rect([o.x0, o.y1, zb], [o.x1, o.y1, zf], NY, 'frames'));
  if (!door) faces.push(rect([o.x0, o.y0, zb], [o.x1, o.y0, zf], PY, 'frames'));
  return faces;
}

/**
 * A closed 4 × 2.6 × 0.2 wall with a 1 × 2.1 door and a 1.2 × 1 window (sill at 1). Front and back are one face
 * each with the openings as holes; the ends, the top and the bottom (two quads either side of the door) are
 * generated too. There are no wall reveals: a frame lines each opening. A column stands against the front at each
 * end with its front, sides and top (its back rests on the wall, its bottom on the ground).
 */
function wallWithOpenings(): ShapeFace[] {
  const [x0, x1, y1, z0, z1] = [-2, 2, STOREY_HEIGHT_M, -0.1, 0.1];
  const door: Opening = { x0: -1.5, x1: -0.5, y0: 0, y1: 2.1 };
  const win: Opening = { x0: 0.2, x1: 1.4, y0: 1, y1: 2 };
  const holes = [door, win].map((o): Box => [[o.x0, o.y0, z0], [o.x1, o.y1, z1]]);
  const columnFaces = (n: Vec3) => n[2] >= 0 && n[1] >= 0;
  return [
    rect([x0, 0, z1], [x1, y1, z1], PZ, 'wall', holes),
    rect([x0, 0, z0], [x1, y1, z0], NZ, 'wall', holes),
    rect([x0, 0, z0], [x0, y1, z1], NX, 'wall'),
    rect([x1, 0, z0], [x1, y1, z1], PX, 'wall'),
    rect([x0, y1, z0], [x1, y1, z1], PY, 'wall'),
    rect([x0, 0, z0], [door.x0, 0, z1], NY, 'wall'),
    rect([door.x1, 0, z0], [x1, 0, z1], NY, 'wall'),
    ...box([x0, 0, z1], [x0 + COLUMN_WIDTH, y1, z1 + COLUMN_DEPTH], 'columns', columnFaces),
    ...box([x1 - COLUMN_WIDTH, 0, z1], [x1, y1, z1 + COLUMN_DEPTH], 'columns', columnFaces),
    ...frame(door, z0, z1),
    ...frame(win, z0, z1),
  ];
}

/** Skirting depth out of the corridor walls, metres. */
const SKIRTING_DEPTH = 0.02;
const SKIRTING_HEIGHT = 0.15;
/** Centres along Z of the corridor's columns, the same on both walls. */
const CORRIDOR_COLUMNS_Z = [-2, 0, 2];

/**
 * A 2 wide × 2.6 high × 6 long corridor along Z, seen from inside: every normal points into it. Both ends are open
 * so the camera can look in. Each wall is one face. Three columns stand against each wall from floor to ceiling,
 * with the face toward the corridor and both sides. Between the columns, a 0.15 m skirting stands 0.02 m proud of
 * each wall with its front and top faces (its bottom rests on the floor, its back against the wall and its ends are
 * open or against a column, so none of those is generated). The wall behind a skirting or a column is hidden but
 * not coplanar with any face.
 */
function corridor(): ShapeFace[] {
  const [hw, h, hl] = [1, STOREY_HEIGHT_M, 3];
  const cw = COLUMN_WIDTH / 2;
  // Skirting segments along Z: from each end or column side to the next.
  const cuts = [-hl, ...CORRIDOR_COLUMNS_Z.flatMap((z) => [z - cw, z + cw]), hl];
  const faces: ShapeFace[] = [
    rect([-hw, 0, -hl], [hw, 0, hl], PY, 'floor'),
    rect([-hw, h, -hl], [hw, h, hl], NY, 'ceiling'),
  ];
  for (const side of [-1, 1]) {
    const inward: Vec3 = side < 0 ? PX : NX;
    const wx = side * hw, sx = side * (hw - SKIRTING_DEPTH), cx = side * (hw - COLUMN_DEPTH);
    faces.push(rect([wx, 0, -hl], [wx, h, hl], inward, 'wall'));
    for (const z of CORRIDOR_COLUMNS_Z) {
      faces.push(rect([cx, 0, z - cw], [cx, h, z + cw], inward, 'columns'));
      faces.push(rect([Math.min(wx, cx), 0, z - cw], [Math.max(wx, cx), h, z - cw], NZ, 'columns'));
      faces.push(rect([Math.min(wx, cx), 0, z + cw], [Math.max(wx, cx), h, z + cw], PZ, 'columns'));
    }
    for (let i = 0; i < cuts.length; i += 2) {
      const [za, zb] = [cuts[i], cuts[i + 1]];
      faces.push(rect([sx, 0, za], [sx, SKIRTING_HEIGHT, zb], inward, 'skirting'));
      faces.push(rect([Math.min(wx, sx), SKIRTING_HEIGHT, za], [Math.max(wx, sx), SKIRTING_HEIGHT, zb], PY, 'skirting'));
    }
  }
  return faces;
}

/**
 * A closed 0.4 × 0.4 × 3 shaft standing on a closed 0.6 × 0.6 × 0.2 base. The base top is a ring of four quads
 * around the shaft (front and back strips full width, side strips between them), so no face lies under the shaft.
 */
function column(): ShapeFace[] {
  const [b, s, bh, top] = [0.3, 0.2, 0.2, 3.2];
  return [
    ...box([-b, 0, -b], [b, bh, b], 'body', (n) => n[1] <= 0),
    rect([-b, bh, s], [b, bh, b], PY, 'body'),
    rect([-b, bh, -b], [b, bh, -s], PY, 'body'),
    rect([-b, bh, -s], [-s, bh, s], PY, 'body'),
    rect([s, bh, -s], [b, bh, s], PY, 'body'),
    ...box([-s, bh, -s], [s, top, s], 'body', (n) => n[1] >= 0),
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
    faces.push(rect([-hw, y0, zf], [hw, y1, zf], PZ, 'body'));
    faces.push(rect([-hw, y1, zb], [hw, y1, zf], PY, 'body'));
    faces.push(rect([-hw, 0, zb], [-hw, y1, zf], NX, 'body'));
    faces.push(rect([hw, 0, zb], [hw, y1, zf], PX, 'body'));
  }
  faces.push(rect([-hw, 0, -front], [hw, steps * rise, -front], NZ, 'body'));
  faces.push(rect([-hw, 0, -front], [hw, 0, front], NY, 'body'));
  return faces;
}

const BUILDERS: Record<TestShape, () => ShapeFace[]> = { cube, wallWithOpenings, corridor, column, stairs };

/** The faces of a 3D test shape, in metres, standing on the ground plane y = 0 and centred on X and Z. */
export function buildShape(shape: TestShape): ShapeFace[] {
  return BUILDERS[shape]();
}
