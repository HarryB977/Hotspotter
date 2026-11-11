import { pxPerMetre, type HotspotLayout, type HotspotRect } from '../layout';

export function toHotspotJson(
  l: HotspotLayout,
  meta: { name: string; heightRangeM: [number, number]; maps: string[] },
): string {
  const { widthPx: W, heightPx: H } = l;
  const out = {
    version: 1,
    name: meta.name,
    atlas: { widthPx: W, heightPx: H, worldWidthM: l.worldWidthM, pxPerMetre: pxPerMetre(l) },
    heightRangeM: meta.heightRangeM,
    maps: meta.maps,
    groove: l.groove,
    rects: l.rects.map((r) => ({
      id: r.id,
      px: { x: r.x, y: r.y, w: r.w, h: r.h },
      // UV origin is bottom-left; px origin is top-left.
      uv: { u0: r.x / W, v0: 1 - (r.y + r.h) / H, u1: (r.x + r.w) / W, v1: 1 - r.y / H },
      allowRotation: r.allowRotation,
      allowMirrorX: r.allowMirrorX,
      allowMirrorY: r.allowMirrorY,
      tileU: r.tileU,
      tileV: r.tileV,
      useOn: r.useOn,
      inset: r.inset,
      group: r.group,
    })),
  };
  return JSON.stringify(out, null, 2);
}

export function parseHotspotJson(s: string): HotspotLayout {
  const j = JSON.parse(s);
  if (j.version !== 1) throw new Error(`Unsupported hotspot.json version: ${j.version}`);
  const rects: HotspotRect[] = j.rects.map((r: any) => ({
    id: r.id,
    x: r.px.x,
    y: r.px.y,
    w: r.px.w,
    h: r.px.h,
    allowRotation: r.allowRotation,
    allowMirrorX: r.allowMirrorX,
    allowMirrorY: r.allowMirrorY,
    tileU: r.tileU,
    tileV: r.tileV,
    useOn: r.useOn,
    inset: r.inset,
    group: r.group,
  }));
  return {
    version: 1,
    widthPx: j.atlas.widthPx,
    heightPx: j.atlas.heightPx,
    worldWidthM: j.atlas.worldWidthM,
    rects,
    groove: j.groove,
  };
}
