import type { MapPixels } from './packing';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const IDAT_MAX = 1 << 20;

/** Encodes straight (non-premultiplied) RGBA8 as an 8-bit colour type 6 PNG, filter 0, so no channel is altered. */
export async function encodePngRgba8(p: MapPixels): Promise<Uint8Array> {
  const { width, height, data } = p;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  for (let o = 0; o < z.length; o += IDAT_MAX) parts.push(chunk('IDAT', z.subarray(o, o + IDAT_MAX)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}
