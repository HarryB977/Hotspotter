import type { StructureResult } from './analyze';

/** Fewest whole pieces (off the image border) a piece size is measured from. */
const MIN_PIECES = 4;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Median long and short side, in metres, of the pixel bounding boxes of the pieces that do not touch the image
 * border (those are cut by the tile edge). Null unless the result is `pieces` with at least 4 such pieces.
 */
export function medianPieceSizeM(
  r: StructureResult, tileSizeM: [number, number],
): { longM: number; shortM: number } | null {
  if (r.type !== 'pieces') return null;
  const { width: w, height: h, pieceId } = r;
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = pieceId[y * w + x];
      if (id === 0) continue;
      const b = boxes.get(id);
      if (!b) boxes.set(id, { x0: x, y0: y, x1: x, y1: y });
      else {
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y > b.y1) b.y1 = y;
      }
    }
  }
  const mx = tileSizeM[0] / w, my = tileSizeM[1] / h;
  const longs: number[] = [], shorts: number[] = [];
  for (const b of boxes.values()) {
    if (b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1) continue;
    const a = (b.x1 - b.x0 + 1) * mx, c = (b.y1 - b.y0 + 1) * my;
    longs.push(Math.max(a, c));
    shorts.push(Math.min(a, c));
  }
  if (longs.length < MIN_PIECES) return null;
  return { longM: median(longs), shortM: median(shorts) };
}
