import type { HotspotLayout, UseOn } from '../layout';

const USE_ON: Record<UseOn, string> = {
  walls: 'Walls', floors: 'Floors', ceilings: 'Ceilings', any: 'Any',
};

const yn = (b: boolean) => (b ? 'yes' : 'no');
const cell = (v: string | number) => {
  const s = String(v);
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toAnvilTable(l: HotspotLayout): string {
  const lines = [
    `Sheet Width (m),${l.worldWidthM}`,
    'Name,X,Y,Width,Height,Can rotate,Can mirror,Repeats across,Repeats down,Use on',
    ...l.rects.map((r) =>
      [
        r.id, r.x, r.y, r.w, r.h,
        yn(r.allowRotation), yn(r.allowMirrorX || r.allowMirrorY),
        yn(r.tileU), yn(r.tileV), USE_ON[r.useOn],
      ].map(cell).join(','),
    ),
  ];
  return lines.join('\r\n');
}
