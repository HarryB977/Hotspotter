import type { MapPixels } from './packing';

/** Groove / empty pixels (id 0). */
const GROOVE = 13;

/**
 * Colour of rect id `id` (rect index + 1) in the _RectID map. The atlas view (ID_FS in AtlasView.tsx) uses the same
 * integer hash and byte mapping, so the exported map and the view agree exactly; keep them in sync.
 */
export function rectIdRgb(id: number): [number, number, number] {
  if (id === 0) return [GROOVE, GROOVE, GROOVE];
  let h = Math.imul(id >>> 0, 2654435761) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  const ch = (b: number) => 64 + ((b * 166) >> 8);
  return [ch(h & 255), ch((h >>> 8) & 255), ch((h >>> 16) & 255)];
}

/** RGBA8 image of a row-major rect id map. */
export function rectIdImage(ids: Uint32Array, width: number, height: number): MapPixels {
  const data = new Uint8Array(width * height * 4);
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < ids.length; i++) {
    let c = cache.get(ids[i]);
    if (!c) cache.set(ids[i], (c = rectIdRgb(ids[i])));
    data.set(c, i * 4);
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
