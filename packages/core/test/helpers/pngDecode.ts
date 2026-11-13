import { inflateSync } from 'node:zlib';

/** Test-only PNG decoder. Non-interlaced greyscale (0), RGB (2) and RGBA (6) at 8 or 16 bits, all filter types. */
export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** Chunk types in file order. */
  chunkTypes: string[];
  /** RGBA8, row 0 = top. 16-bit samples keep their high byte. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 6: 4 };

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) if (png[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  const chunkTypes: string[] = [];
  let ihdr: Uint8Array | undefined;
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (dv.getUint32(o + 8 + len) !== crc32(png.subarray(o + 4, o + 8 + len))) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') ihdr = png.subarray(o + 8, o + 8 + len);
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    chunkTypes.push(type);
    o += 12 + len;
  }
  if (!ihdr) throw new Error('missing IHDR');
  const hv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = hv.getUint32(0), height = hv.getUint32(4);
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  const channels = CHANNELS[colorType];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || interlace !== 0) {
    throw new Error(`unsupported PNG: colour type ${colorType}, depth ${bitDepth}, interlace ${interlace}`);
  }
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      cur[i] = v & 255;
    }
    for (let px = 0; px < width; px++) {
      const s = px * bpp;
      const sample = (ch: number) => cur[s + ch * bytesPerSample]; // high byte first for 16-bit
      const out = (y * width + px) * 4;
      if (channels === 1) {
        const g = sample(0);
        data[out] = g; data[out + 1] = g; data[out + 2] = g; data[out + 3] = 255;
      } else {
        data[out] = sample(0); data[out + 1] = sample(1); data[out + 2] = sample(2);
        data[out + 3] = channels === 4 ? sample(3) : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, bitDepth, colorType, chunkTypes, data };
}
