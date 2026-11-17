import * as THREE from 'three';
import type { HotspotFit, ShapeFace } from '@hotspotter/core';

/**
 * A face's geometry with its holes cut out, in the face's local frame: s along corners[0]→[1] (0..w), t along
 * corners[0]→[3] (0..h). Position = corners[0] + s·û + t·v̂; uv is bilinear from the four corner uvs at (s/w, t/h),
 * exact because the fit is axis-aligned.
 *
 * The face is cut on a grid through every hole edge and the cells outside the holes are kept, two triangles each.
 * This handles holes on the outline (the door touches the bottom edge, t0 = 0), which earcut
 * (`ShapeUtils.triangulateShape`) cannot take as inner contours: it bridges them to the outline with degenerate
 * edges. The grid has no T-junctions, so neighbouring cells share their vertices exactly. A face without holes is
 * one quad, as before.
 */
export function faceGeometry(face: ShapeFace, fit: HotspotFit): THREE.BufferGeometry {
  const { widthM: w, heightM: h } = face.quad;
  const holes = face.holes ?? [];
  const cuts = (len: number, edges: number[]) =>
    [...new Set([0, len, ...edges.map((e) => Math.min(len, Math.max(0, e)))])].sort((a, b) => a - b);
  const ss = cuts(w, holes.flatMap(([s0, , s1]) => [s0, s1]));
  const ts = cuts(h, holes.flatMap(([, t0, , t1]) => [t0, t1]));

  const [c0, c1, , c3] = face.corners;
  const [uv0, uv1, uv2, uv3] = fit.uv;
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  for (const t of ts) {
    for (const s of ss) {
      const a = w > 0 ? s / w : 0;
      const b = h > 0 ? t / h : 0;
      for (let i = 0; i < 3; i++) position.push(c0[i] + a * (c1[i] - c0[i]) + b * (c3[i] - c0[i]));
      normal.push(...face.normal);
      for (let k = 0; k < 2; k++) {
        uv.push((1 - a) * (1 - b) * uv0[k] + a * (1 - b) * uv1[k] + a * b * uv2[k] + (1 - a) * b * uv3[k]);
      }
    }
  }

  const index: number[] = [];
  const at = (i: number, j: number) => j * ss.length + i;
  for (let j = 0; j + 1 < ts.length; j++) {
    for (let i = 0; i + 1 < ss.length; i++) {
      const s = (ss[i] + ss[i + 1]) / 2;
      const t = (ts[j] + ts[j + 1]) / 2;
      if (holes.some(([s0, t0, s1, t1]) => s > s0 && s < s1 && t > t0 && t < t1)) continue;
      // CCW seen from the normal's side, as the corners run.
      index.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}
