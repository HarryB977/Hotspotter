import { describe, expect, it } from 'vitest';
import { buildShape } from '@hotspotter/core';
import type { HotspotFit, ShapeFace } from '@hotspotter/core';
import { faceGeometry } from '../src/viewport/three/faceGeometry';

const fit: HotspotFit = { rectId: 'r', uv: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.6], [0.1, 0.6]], tiled: false } as HotspotFit;

/** The face's triangles in its local (s, t) metres, with each vertex's uv. */
function localTriangles(face: ShapeFace) {
  const g = faceGeometry(face, fit);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const index = g.getIndex()!;
  const c = face.corners;
  const { widthM: w, heightM: h } = face.quad;
  const axis = (k: 1 | 3, len: number) => [0, 1, 2].map((i) => (c[k][i] - c[0][i]) / len);
  const [u, v] = [axis(1, w), axis(3, h)];
  const local = (i: number) => {
    const d = [pos.getX(i) - c[0][0], pos.getY(i) - c[0][1], pos.getZ(i) - c[0][2]];
    return {
      s: d[0] * u[0] + d[1] * u[1] + d[2] * u[2],
      t: d[0] * v[0] + d[1] * v[1] + d[2] * v[2],
      uv: [uv.getX(i), uv.getY(i)],
    };
  };
  const tris = [];
  for (let i = 0; i < index.count; i += 3) tris.push([0, 1, 2].map((k) => local(index.getX(i + k))));
  return tris;
}

const area = (t: { s: number; t: number }[]) =>
  Math.abs((t[1].s - t[0].s) * (t[2].t - t[0].t) - (t[2].s - t[0].s) * (t[1].t - t[0].t)) / 2;

describe('faceGeometry', () => {
  const walls = buildShape('wallWithOpenings').filter((f) => f.part === 'wall' && Math.abs(f.normal[2]) === 1);

  it('the wall faces carry the door (on the bottom edge) and the window as holes', () => {
    expect(walls).toHaveLength(2);
    for (const f of walls) {
      expect(f.holes).toHaveLength(2);
      expect(f.holes!.some((h) => h[1] === 0)).toBe(true);
    }
  });

  it('covers the face minus its holes, and no triangle covers an opening', () => {
    for (const face of walls) {
      const tris = localTriangles(face);
      const holes = face.holes!;
      const open = face.quad.widthM * face.quad.heightM - holes.reduce((a, [s0, t0, s1, t1]) => a + (s1 - s0) * (t1 - t0), 0);
      expect(tris.reduce((a, t) => a + area(t), 0)).toBeCloseTo(open, 6);
      for (const tri of tris) {
        // A triangle overlaps a hole iff a point well inside it does (the triangles are halves of grid cells).
        const cs = (tri[0].s + tri[1].s + tri[2].s) / 3;
        const ct = (tri[0].t + tri[1].t + tri[2].t) / 3;
        for (const [s0, t0, s1, t1] of holes) {
          expect(cs > s0 && cs < s1 && ct > t0 && ct < t1).toBe(false);
        }
        // Every vertex lies on the face.
        for (const p of tri) {
          expect(p.s).toBeGreaterThanOrEqual(-1e-6);
          expect(p.s).toBeLessThanOrEqual(face.quad.widthM + 1e-6);
          expect(p.t).toBeGreaterThanOrEqual(-1e-6);
          expect(p.t).toBeLessThanOrEqual(face.quad.heightM + 1e-6);
        }
      }
    }
  });

  it('the door opening is empty: nothing of the face inside its rectangle', () => {
    const front = walls.find((f) => f.normal[2] === 1)!;
    const door = front.holes!.find((h) => h[1] === 0)!;
    expect(door).toEqual([0.5, 0, 1.5, 2.1]);
    const tris = localTriangles(front);
    // Sample the door's interior on a grid: no triangle contains any sample.
    const inside = (tri: { s: number; t: number }[], s: number, t: number) => {
      const sign = (a: { s: number; t: number }, b: { s: number; t: number }) =>
        (b.s - a.s) * (t - a.t) - (b.t - a.t) * (s - a.s);
      const d = [sign(tri[0], tri[1]), sign(tri[1], tri[2]), sign(tri[2], tri[0])];
      return d.every((x) => x > 1e-9) || d.every((x) => x < -1e-9);
    };
    for (let i = 1; i < 20; i++) {
      for (let j = 1; j < 20; j++) {
        const s = door[0] + ((door[2] - door[0]) * i) / 20;
        const t = door[1] + ((door[3] - door[1]) * j) / 20;
        expect(tris.some((tri) => inside(tri, s, t))).toBe(false);
      }
    }
  });

  it('uv is bilinear from the corner uvs at (s / w, t / h)', () => {
    const front = walls.find((f) => f.normal[2] === 1)!;
    const { widthM: w, heightM: h } = front.quad;
    for (const tri of localTriangles(front)) {
      for (const p of tri) {
        expect(p.uv[0]).toBeCloseTo(0.1 + 0.4 * (p.s / w), 5);
        expect(p.uv[1]).toBeCloseTo(0.2 + 0.4 * (p.t / h), 5);
      }
    }
  });

  it('a face without holes stays one quad', () => {
    const cube = buildShape('cube')[0];
    const g = faceGeometry(cube, fit);
    expect(g.getAttribute('position').count).toBe(4);
    expect(g.getIndex()!.count).toBe(6);
  });
});
