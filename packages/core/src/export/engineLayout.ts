import type { HotspotLayout } from '../layout';

/**
 * The layout as a target engine gets it (decision 69): with downward runoff a vertical mirror would run the streaks
 * upward, so `allowMirrorY` is cleared. hotspot.json and the 3D view both go through this, so they cannot drift apart.
 * Without runoff it returns `l` itself.
 */
export function engineLayout(l: HotspotLayout, opts: { runoff: boolean }): HotspotLayout {
  if (!opts.runoff) return l;
  return { ...l, rects: l.rects.map((r) => ({ ...r, allowMirrorY: false })) };
}
