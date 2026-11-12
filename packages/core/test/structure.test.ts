import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  analyzeStructure, downsample, estimatePeriod, jointDistance, jointMask, proposeMaterialType, segmentPieces,
  syntheticBrick, syntheticFbm, syntheticGrain, toGray,
} from '../src';
import type { GrayImage } from '../src';
import { decodePng } from './helpers/pngDecode';

const SIZE = 512;
const MPP = 1 / SIZE; // 512 px represent 1 m
const brickOpts = { size: SIZE, courseH: 64, brickW: 128, joint: 6, jointH: 0.1, brickH: 0.8 };
const brick = syntheticBrick(brickOpts);
/** Index into a GrayImage of the texel at (u, v) with v measured y-up from the bottom row. */
const at = (u: number, v: number) => (SIZE - 1 - v) * SIZE + u;

describe('toGray / downsample', () => {
  it('height reads R; invertedLuma inverts Rec.709 luma', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const h = toGray(rgba, 2, 1, 'height');
    expect(Array.from(h.data)).toEqual([1, 0]);
    const l = toGray(rgba, 2, 1, 'invertedLuma');
    expect(l.data[0]).toBeCloseTo(1 - 0.2126, 5);
    expect(l.data[1]).toBeCloseTo(1 - 0.7152, 5);
  });

  it('box-averages down to maxSide and keeps smaller images unchanged', () => {
    const img: GrayImage = { width: 4, height: 2, data: new Float32Array([0, 1, 0.5, 0.5, 1, 0, 0.25, 0.75]) };
    const d = downsample(img, 2);
    expect([d.width, d.height]).toEqual([2, 1]);
    expect(Array.from(d.data)).toEqual([0.5, 0.5]);
    expect(downsample(img, 512)).toEqual(img);
    const big = downsample({ width: 1024, height: 1024, data: new Float32Array(1024 * 1024).fill(0.3) }, 512);
    expect([big.width, big.height]).toEqual([512, 512]);
    expect(big.data[12345]).toBeCloseTo(0.3, 6);
  });
});

describe('synthetic brick (1 × 1 m, 64 px courses, 128 px running bond, 6 px joints)', () => {
  const { mask, threshold } = jointMask(brick.gray);

  it('Otsu threshold separates mortar (0.1) from brick (0.8)', () => {
    expect(threshold).toBeGreaterThan(0.1);
    expect(threshold).toBeLessThanOrEqual(0.8);
    expect(mask[at(100, 16)]).toBe(1);
    expect(mask[at(100, 47)]).toBe(0);
  });

  it('estimatePeriod finds the brick period (not the bond half-period) and the joint centre as phase', () => {
    const p = estimatePeriod(mask, SIZE, SIZE, [1, 1]);
    expect(p.y).not.toBeNull();
    expect(p.x).not.toBeNull();
    expect(Math.abs(p.y! - 0.125)).toBeLessThanOrEqual(0.004);
    expect(Math.abs(p.x! - 0.25)).toBeLessThanOrEqual(0.008);
    // Horizontal joint band covers v ∈ [13, 19) px from the bottom; centre 16 px.
    expect(Math.abs(p.phaseY / MPP - 16)).toBeLessThanOrEqual(1);
    // Course above that joint has vertical joints centred at u = 32 px.
    expect(Math.abs(p.phaseX / MPP - 32)).toBeLessThanOrEqual(1);
    expect(p.confidence).toBeGreaterThan(0.5);
    expect(p.confidence).toBeLessThanOrEqual(1);
  });

  it('segmentPieces counts 32 bricks, wrapping across both image edges', () => {
    const { pieceId, count } = segmentPieces(mask, SIZE, SIZE);
    expect(count).toBe(32);
    expect(pieceId[at(100, 16)]).toBe(0);
    expect(pieceId[at(0, 40)]).toBeGreaterThan(0);
    expect(pieceId[at(0, 40)]).toBe(pieceId[at(SIZE - 1, 40)]);
    expect(pieceId[at(200, 0)]).toBeGreaterThan(0);
    expect(pieceId[at(200, 0)]).toBe(pieceId[at(200, SIZE - 1)]);
  });

  it('jointDistance is 0 on joints, ≈ 29 px at a brick centre, and wraps', () => {
    const { pieceId } = segmentPieces(mask, SIZE, SIZE);
    const d = jointDistance(pieceId, SIZE, SIZE, [MPP, MPP]);
    let nonZeroOnJoint = 0;
    for (let i = 0; i < pieceId.length; i++) if (pieceId[i] === 0 && d[i] !== 0) nonZeroOnJoint++;
    expect(nonZeroOnJoint).toBe(0);
    expect(Math.abs(d[at(96, 47)] - ((64 - 6) / 2) * MPP)).toBeLessThanOrEqual(MPP);
    // Top row: nearest horizontal joint is across the edge (v = 13 → 14 px away), not 45 px below.
    expect(d[at(200, SIZE - 1)]).toBeCloseTo(14 * MPP, 6);
  });

  it('analyzeStructure proposes pieces', () => {
    const r = analyzeStructure(brick.gray, [1, 1]);
    expect(r.type).toBe('pieces');
    expect(r.pieceCount).toBe(32);
    expect(r.jointFraction).toBeGreaterThan(0.03);
    expect(r.jointFraction).toBeLessThan(0.45);
    expect([r.width, r.height]).toEqual([SIZE, SIZE]);
    expect(r.pieceId.length).toBe(SIZE * SIZE);
    expect(r.jointDistM.length).toBe(SIZE * SIZE);
    expect(proposeMaterialType(r)).toBe('pieces');
  });

  it('honours an explicit threshold', () => {
    const none = analyzeStructure(brick.gray, [1, 1], { threshold: 0 });
    expect(none.threshold).toBe(0);
    expect(none.jointFraction).toBe(0);
    expect(none.type).not.toBe('pieces');
    const half = analyzeStructure(brick.gray, [1, 1], { threshold: 0.5 });
    expect(half.threshold).toBe(0.5);
    expect(half.pieceCount).toBe(32);
  });

  it('runs in under 3 s on 512²', () => {
    const t0 = performance.now();
    analyzeStructure(brick.gray, [1, 1]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('Review Focus 1: albedo only (inverted luma)', () => {
  it('coloured synthetic brick gives the same piece count ±2', () => {
    const coloured = syntheticBrick({ ...brickOpts, colour: true });
    const gray = toGray(coloured.rgba, SIZE, SIZE, 'invertedLuma');
    const r = analyzeStructure(gray, [1, 1]);
    expect(Math.abs(r.pieceCount - 32)).toBeLessThanOrEqual(2);
    expect(r.type).toBe('pieces');
  });
});

describe('continuous and directional materials', () => {
  it('isotropic fBm is continuous', () => {
    const r = analyzeStructure(syntheticFbm({ size: SIZE, seed: 7, scale: 8 }), [1, 1]);
    expect(r.type).toBe('continuous');
    expect(r.pieceCount <= 1 || r.jointFraction < 0.03).toBe(true);
    expect(r.anisotropy).toBeLessThan(0.3);
    expect(r.grainAxis).toBeNull();
    expect(r.jointDistM.every((d) => d === Infinity)).toBe(true);
  });

  it('horizontal grain (1:12) is directional along x', () => {
    const r = analyzeStructure(syntheticGrain({ size: SIZE, seed: 3, stretch: 12, axis: 'x' }), [1, 1]);
    expect(r.type).toBe('directional');
    expect(r.grainAxis).toBe('x');
  });

  it('vertical grain is directional along y', () => {
    const r = analyzeStructure(syntheticGrain({ size: SIZE, seed: 3, stretch: 12, axis: 'y' }), [1, 1]);
    expect(r.type).toBe('directional');
    expect(r.grainAxis).toBe('y');
  });

  it('synthetic generators are deterministic', () => {
    expect(syntheticFbm({ size: 64, seed: 1, scale: 4 })).toEqual(syntheticFbm({ size: 64, seed: 1, scale: 4 }));
    expect(syntheticGrain({ size: 64, seed: 1, stretch: 6, axis: 'x' }))
      .toEqual(syntheticGrain({ size: 64, seed: 1, stretch: 6, axis: 'x' }));
  });
});

const PBR = fileURLToPath(new URL('../../../samples/pbr/', import.meta.url));
const hasSamples = existsSync(PBR);

function loadHeight(rel: string): GrayImage {
  const png = decodePng(readFileSync(PBR + rel));
  return downsample(toGray(png.data, png.width, png.height, 'height'), 512);
}

describe.skipIf(!hasSamples)('samples/pbr', () => {
  it('bricks wall 13: pieces with a confident Y period', () => {
    const r = analyzeStructure(loadHeight('bricks wall 13/bricks_wall_13_height_1k.png'), [1, 1]);
    expect(r.type).toBe('pieces');
    expect(r.period.y).not.toBeNull();
    expect(r.period.confidence).toBeGreaterThan(0.5);
  });

  it('concrete wall 01: continuous', () => {
    const r = analyzeStructure(loadHeight('concrete wall 01/concrete_wall_01_height_1k.png'), [1, 1]);
    expect(r.type).toBe('continuous');
  });

  it('wood planks 12: pieces or directional, with a grain axis', () => {
    const r = analyzeStructure(loadHeight('wood planks 12/wood_planks_12_height_1k.png'), [1, 1]);
    expect(['pieces', 'directional']).toContain(r.type);
    expect(r.grainAxis).not.toBeNull();
  });

  it('decodes an RGB 8-bit albedo', () => {
    const png = decodePng(readFileSync(PBR + 'bricks wall 13/bricks_wall_13_basecolor_1k.png'));
    expect([png.width, png.height, png.colorType]).toEqual([1024, 1024, 2]);
    expect(png.data[3]).toBe(255);
  });
});
