import { engineLayout } from '../export/engineLayout';
import type { HotspotLayout } from '../layout';
import { matchHotspot } from './match';
import type { HotspotFit } from './match';
import type { ShapeFace } from './shapes';

/** Seed of face `index`: an integer hash (murmur3 fmix32) of the project seed and the index, as a u32. */
export function faceSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Fits every face of a test shape as the export's engine would see the layout (`engineLayout`: no vertical mirror
 * with runoff). Each face draws from its own seeded RNG (`faceSeed`), so faces that tie do not all make the same
 * pick and mirror; the result is deterministic for the same faces, layout and seed.
 */
export function fitFaces(
  faces: readonly ShapeFace[],
  layout: HotspotLayout,
  rotations: ReadonlyMap<string, boolean>,
  opts: { seed: number; runoff: boolean },
): HotspotFit[] {
  const l = engineLayout(layout, { runoff: opts.runoff });
  return faces.map((f, i) => matchHotspot(f.quad, l, rotations, { seed: faceSeed(opts.seed, i) }));
}
