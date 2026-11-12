import { describe, it, expect } from 'vitest';
import { encodePngRgba8 } from '../src';
import { decodePng } from './helpers/pngDecode';

describe('encodePngRgba8', () => {
  it('round-trips RGBA bytes exactly, including A=0 and partial alpha', async () => {
    const w = 5, h = 3;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 255;
    data.set([200, 100, 50, 0], 0);
    data.set([13, 77, 201, 128], 4);
    const out = decodePng(await encodePngRgba8({ width: w, height: h, data }));
    expect([out.width, out.height, out.bitDepth, out.colorType]).toEqual([w, h, 8, 6]);
    expect(out.chunkTypes[0]).toBe('IHDR');
    expect(out.chunkTypes.at(-1)).toBe('IEND');
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });
});
