import { describe, it, expect } from 'vitest';
import {
  toHotspotJson, parseHotspotJson, toAnvilTable, packMaps, makeRect, DEFAULT_GROOVE,
} from '../src';
import type { HotspotLayout, MapPixels } from '../src';

const layout: HotspotLayout = {
  version: 1, widthPx: 4096, heightPx: 4096, worldWidthM: 8,
  rects: [
    makeRect({ id: 'a', x: 0, y: 0, w: 1024, h: 512, allowRotation: true, allowMirrorX: true, tileU: true, useOn: 'walls', inset: 2, group: 'g' }),
    makeRect({ id: 'b,c', x: 1024, y: 512, w: 256, h: 256, useOn: 'floors' }),
  ],
  groove: { ...DEFAULT_GROOVE },
};
const meta = { name: 'Test', heightRangeM: [0, 0.02] as [number, number], maps: ['baseColor', 'normal'] };

describe('hotspot.json', () => {
  it('writes atlas, heightRangeM, px and uv', () => {
    const j = JSON.parse(toHotspotJson(layout, meta));
    expect(j.version).toBe(1);
    expect(j.name).toBe('Test');
    expect(j.atlas).toEqual({ widthPx: 4096, heightPx: 4096, worldWidthM: 8, pxPerMetre: 512 });
    expect(j.heightRangeM).toEqual([0, 0.02]);
    expect(j.maps).toEqual(['baseColor', 'normal']);
    expect(j.rects[0].px).toEqual({ x: 0, y: 0, w: 1024, h: 512 });
    expect(j.rects[0].uv.v1).toBe(1);
    expect(j.rects[0].uv.v0).toBe(1 - 512 / 4096);
    expect(j.rects[0].uv.u0).toBe(0);
    expect(j.rects[0].uv.u1).toBe(0.25);
  });
  it('round-trips the layout', () => {
    expect(parseHotspotJson(toHotspotJson(layout, meta))).toEqual(layout);
  });
  it('rejects other versions', () => {
    const j = JSON.parse(toHotspotJson(layout, meta));
    j.version = 2;
    expect(() => parseHotspotJson(JSON.stringify(j))).toThrow();
  });
});

describe('Anvil table', () => {
  it('emits sheet width, header and rows with CRLF', () => {
    const lines = toAnvilTable(layout).split('\r\n');
    expect(lines[0]).toBe('Sheet Width (m),8');
    expect(lines[1]).toBe('Name,X,Y,Width,Height,Can rotate,Can mirror,Repeats across,Repeats down,Use on');
    expect(lines[2]).toBe('a,0,0,1024,512,yes,yes,yes,no,Walls');
    expect(lines[3]).toBe('"b,c",1024,512,256,256,no,no,no,no,Floors');
  });
  it('mirrors if either axis allowed', () => {
    const l = { ...layout, rects: [makeRect({ id: 'y', x: 0, y: 0, w: 8, h: 8, allowMirrorY: true })] };
    expect(toAnvilTable(l).split('\r\n')[2]).toBe('y,0,0,8,8,no,yes,no,no,Any');
  });
});

const px = (r: number, g = r, b = r, a = 255): MapPixels => ({ width: 1, height: 1, data: new Uint8Array([r, g, b, a]) });
const maps = {
  baseColor: px(10, 20, 30, 255), normal: px(128, 128, 255), height: px(77),
  roughness: px(100), metallic: px(200), ao: px(50),
};

describe('packMaps', () => {
  it('unity-urp', () => {
    const out = packMaps('unity-urp', maps);
    expect(out.map((f) => f.suffix)).toEqual(['_BaseColor', '_Normal', '_MetallicSmoothness', '_Occlusion', '_Height']);
    expect(Array.from(out[2].pixels.data)).toEqual([200, 0, 0, 155]);
    expect(Array.from(out[3].pixels.data)).toEqual([50, 50, 50, 255]);
    expect(Array.from(out[4].pixels.data)).toEqual([77, 77, 77, 255]);
    expect(Array.from(out[0].pixels.data)).toEqual([10, 20, 30, 255]);
  });
  it('unity-hdrp', () => {
    const out = packMaps('unity-hdrp', maps);
    expect(out.map((f) => f.suffix)).toEqual(['_BaseColor', '_Normal', '_MaskMap', '_Height']);
    expect(Array.from(out[2].pixels.data)).toEqual([200, 50, 255, 155]);
  });
  it('throws on size mismatch', () => {
    const bad = { ...maps, ao: { width: 2, height: 1, data: new Uint8Array(8) } };
    expect(() => packMaps('unity-urp', bad)).toThrow();
  });
});
