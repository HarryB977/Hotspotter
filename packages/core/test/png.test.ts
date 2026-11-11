import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePngRgba8 } from '../src';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function decode(png: Uint8Array) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  const idat: Buffer[] = [];
  const types: string[] = [];
  let ihdr!: Uint8Array;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    expect(dv.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
    if (type === 'IHDR') ihdr = png.subarray(o + 8, o + 8 + len);
    if (type === 'IDAT') idat.push(Buffer.from(png.subarray(o + 8, o + 8 + len)));
    types.push(type);
    o += 12 + len;
  }
  const w = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(0);
  const h = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(4);
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 4 + 1)]).toBe(0);
    data.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  }
  return { w, h, bitDepth: ihdr[8], colorType: ihdr[9], types, data };
}

describe('encodePngRgba8', () => {
  it('round-trips RGBA bytes exactly, including A=0 and partial alpha', async () => {
    const w = 5, h = 3;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 255;
    data.set([200, 100, 50, 0], 0);
    data.set([13, 77, 201, 128], 4);
    const out = decode(await encodePngRgba8({ width: w, height: h, data }));
    expect([out.w, out.h, out.bitDepth, out.colorType]).toEqual([w, h, 8, 6]);
    expect(out.types[0]).toBe('IHDR');
    expect(out.types.at(-1)).toBe('IEND');
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });
});
