import { describe, it, expect } from 'vitest';
import { medianPieceSizeM } from '../src/structure/pieceSize';
import { proposeWearSize } from '../src/wear/params';
import type { StructureResult } from '../src/structure/analyze';

/**
 * Stack-bond grid of 4 × 8 bricks of 20 × 6.5 cm with 1 cm joints on a 1 m tile at 400 px/m, centred with a joint
 * margin all round, so no brick touches the image border.
 */
function brickGrid(type: StructureResult['type']): StructureResult {
  const size = 400, ppm = 400;
  const brickW = Math.round(0.2 * ppm), brickH = Math.round(0.065 * ppm), joint = Math.round(0.01 * ppm);
  const cols = 4, rows = 8;
  const x0 = Math.round((size - cols * (brickW + joint)) / 2), y0 = Math.round((size - rows * (brickH + joint)) / 2);
  const pieceId = new Uint32Array(size * size);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bx = x0 + c * (brickW + joint), by = y0 + r * (brickH + joint);
      for (let y = by; y < by + brickH; y++) for (let x = bx; x < bx + brickW; x++) pieceId[y * size + x] = r * cols + c + 1;
    }
  }
  return {
    type, period: { x: null, y: null, phaseX: 0, phaseY: 0, confidence: 0 }, threshold: 0.5, suggestedThreshold: 0.5,
    pieceId, jointDistM: new Float32Array(size * size), pieceCount: cols * rows, jointFraction: 0.2, anisotropy: 0,
    grainAxis: null, width: size, height: size,
  };
}

describe('medianPieceSizeM', () => {
  it('measures a 4 × 8 grid of 20 × 6.5 cm bricks on a 1 m tile', () => {
    const s = medianPieceSizeM(brickGrid('pieces'), [1, 1])!;
    expect(Math.abs(s.longM - 0.2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(s.shortM - 0.065)).toBeLessThanOrEqual(0.01);
  });

  it('converts each axis with its own tile size', () => {
    const s = medianPieceSizeM(brickGrid('pieces'), [2, 0.5])!;
    expect(s.longM).toBeCloseTo(0.4, 5);
    expect(s.shortM).toBeCloseTo(0.0325, 5);
  });

  it('is null for a continuous result', () => {
    expect(medianPieceSizeM(brickGrid('continuous'), [1, 1])).toBeNull();
  });

  it('is null with fewer than 4 pieces off the image border', () => {
    const r = brickGrid('pieces');
    // Keep 3 bricks: every other id becomes joint.
    for (let i = 0; i < r.pieceId.length; i++) if (r.pieceId[i] > 3) r.pieceId[i] = 0;
    expect(medianPieceSizeM(r, [1, 1])).toBeNull();
  });

  it('ignores pieces that touch the image border', () => {
    const r = brickGrid('pieces');
    // A 1-px-high sliver along the top row, and a huge piece touching the left border.
    for (let x = 0; x < r.width; x++) r.pieceId[x] = 100;
    for (let y = 100; y < 300; y++) for (let x = 0; x < 3; x++) r.pieceId[y * r.width + x] = 101;
    const s = medianPieceSizeM(r, [1, 1])!;
    expect(s.longM).toBeCloseTo(0.2, 5);
    expect(s.shortM).toBeCloseTo(0.065, 5);
  });
});

describe('proposeWearSize', () => {
  it('keeps the fixed defaults without a piece size', () => {
    expect(proposeWearSize(null)).toEqual({ widthM: 0.04, sizeM: 0.03, intensity: 0.5 });
  });

  it('reaches one piece, breaks on 1.5 short sides, at intensity 0.75', () => {
    const p = proposeWearSize({ longM: 0.2, shortM: 0.065 });
    expect(p.widthM).toBe(0.2);
    expect(p.sizeM).toBeCloseTo(0.0975, 10);
    expect(p.intensity).toBe(0.75);
  });
});
