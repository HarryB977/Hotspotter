import { createRng } from '../rng';
import type { GrayImage } from './analyze';

export interface SyntheticBrickOptions {
  /** Square side in px; must be a multiple of `brickW` and of 2 · `courseH` to tile. */
  size: number;
  /** Course height in px (joint included). */
  courseH: number;
  /** Brick length in px (joint included). */
  brickW: number;
  /** Joint width in px. */
  joint: number;
  /** Height value of joints and of bricks, 0..1. */
  jointH: number;
  brickH: number;
  /** Albedo with per-brick red tints and light mortar instead of a grey copy of the height. */
  colour?: boolean;
}

/**
 * Tileable running-bond brick (half-brick offset per course). In y-up texel coordinates (v from the bottom row),
 * horizontal joint bands are centred on v = courseH/4 + k·courseH and, within course c (which sits on the joint
 * at v = courseH/4 + c·courseH), vertical joints are centred on u = brickW/4 + (c mod 2)·brickW/2 + k·brickW.
 * The offsets make bricks straddle both image edges.
 */
export function syntheticBrick(opts: SyntheticBrickOptions): { gray: GrayImage; rgba: Uint8Array } {
  const { size, courseH, brickW, joint, jointH, brickH, colour = false } = opts;
  const offY = courseH / 4, offX = brickW / 4;
  const courses = Math.round(size / courseH), perCourse = Math.round(size / brickW);
  const rng = createRng(0xb41c);
  const tints = Array.from({ length: courses * perCourse }, () => 0.85 + 0.3 * rng.next());
  const mod = (a: number, m: number) => ((a % m) + m) % m;
  const data = new Float32Array(size * size);
  const rgba = new Uint8Array(size * size * 4);
  for (let r = 0; r < size; r++) {
    const vc = size - 1 - r + 0.5;
    const course = Math.floor((vc - offY) / courseH);
    const dy = mod(vc - offY + courseH / 2, courseH) - courseH / 2;
    const lineX = offX + mod(course, 2) * (brickW / 2);
    for (let x = 0; x < size; x++) {
      const uc = x + 0.5;
      const dx = mod(uc - lineX + brickW / 2, brickW) - brickW / 2;
      const isJoint = Math.abs(dy) < joint / 2 || Math.abs(dx) < joint / 2;
      const i = r * size + x;
      data[i] = isJoint ? jointH : brickH;
      const o = i * 4;
      if (!colour) {
        const g = Math.round(data[i] * 255);
        rgba.set([g, g, g, 255], o);
      } else if (isJoint) {
        rgba.set([205, 200, 190, 255], o);
      } else {
        const b = mod(Math.floor((uc - lineX) / brickW), perCourse);
        const t = tints[mod(course, courses) * perCourse + b];
        rgba.set([Math.round(150 * t), Math.round(62 * t), Math.round(48 * t), 255], o);
      }
    }
  }
  return { gray: { width: size, height: size, data }, rgba };
}

/** Tileable value noise on a `cx` × `cy` lattice, sampled at (u, v) ∈ [0, 1)², quintic interpolation. */
function valueNoise(lattice: Float32Array, cx: number, cy: number, u: number, v: number): number {
  const fx = u * cx, fy = v * cy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  const at = (x: number, y: number) => lattice[(y % cy) * cx + (x % cx)];
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Sum of tileable value-noise octaves (lattice `cx·2^o` × `cy·2^o`, amplitude 2^−o), min–max normalised. */
function fbmImage(size: number, seed: number, cx: number, cy: number, octaves: number): GrayImage {
  const rng = createRng(seed);
  const layers = Array.from({ length: octaves }, (_, o) => {
    const lx = cx << o, ly = cy << o;
    const lattice = new Float32Array(lx * ly);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
    return { lx, ly, lattice, amp: 0.5 ** o };
  });
  const data = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (const l of layers) s += l.amp * valueNoise(l.lattice, l.lx, l.ly, (x + 0.5) / size, (y + 0.5) / size);
      data[y * size + x] = s;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = (data[i] - lo) / (hi - lo);
  return { width: size, height: size, data };
}

/** Isotropic tileable fBm; `scale` = lattice cells across the tile in the base octave. */
export function syntheticFbm(opts: { size: number; seed: number; scale: number }): GrayImage {
  return fbmImage(opts.size, opts.seed, opts.scale, opts.scale, 4);
}

const GRAIN_CELLS = 48;

/** Tileable grain: fBm whose features are `stretch` times longer along `axis` than across it. */
export function syntheticGrain(opts: { size: number; seed: number; stretch: number; axis: 'x' | 'y' }): GrayImage {
  const along = Math.max(1, Math.round(GRAIN_CELLS / opts.stretch));
  return opts.axis === 'x'
    ? fbmImage(opts.size, opts.seed, along, GRAIN_CELLS, 3)
    : fbmImage(opts.size, opts.seed, GRAIN_CELLS, along, 3);
}
