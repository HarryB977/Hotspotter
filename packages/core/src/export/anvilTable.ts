import type { HotspotLayout, UseOn } from '../layout';

const USE_ON: Record<UseOn, string> = {
  walls: 'Walls', floors: 'Floors', ceilings: 'Ceilings', any: 'Any',
};

const yn = (b: boolean) => (b ? 'yes' : 'no');
const cell = (v: string | number) => {
  const s = String(v);
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * `runoff`: the atlas carries downward runoff streaks. Anvil's "Can mirror" is taken as one flag for both axes (not
 * verified, docs/06), so it is written "no": a vertical mirror would make the streaks run upward. "Mirror X ok" is
 * the rect's allowMirrorX, for when a horizontal mirror can be allowed by hand.
 */
export function toAnvilTable(l: HotspotLayout, opts?: { runoff?: boolean }): string {
  const lines = [
    `Sheet Width (m),${l.worldWidthM}`,
    'Name,X,Y,Width,Height,Can rotate,Can mirror,Mirror X ok,Repeats across,Repeats down,Use on',
    ...l.rects.map((r) =>
      [
        r.id, r.x, r.y, r.w, r.h,
        yn(r.allowRotation), yn(!opts?.runoff && (r.allowMirrorX || r.allowMirrorY)), yn(r.allowMirrorX),
        yn(r.tileU), yn(r.tileV), USE_ON[r.useOn],
      ].map(cell).join(','),
    ),
  ];
  return lines.join('\r\n');
}
