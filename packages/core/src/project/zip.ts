/** Minimal PKZIP codec: stored and deflate-raw entries, CRC-32, UTF-8 names. No zip64, no encryption. */

export class HspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HspError';
  }
}

export interface ProjectFile {
  path: string;
  bytes: Uint8Array;
  /** Write this entry uncompressed (method 0), e.g. images that are already compressed. */
  store?: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const DOS_DATE_1980 = 0x0021; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;
const DAMAGED = 'El proyecto está dañado';
const TOO_BIG = 'El proyecto es demasiado grande para guardarse (máximo 4 GB)';
/** Max total declared uncompressed size of one archive. */
export const MAX_UNPACKED_TOTAL = 1024 * 1024 * 1024;
/** Deflate cannot exceed ~1032:1; a declared ratio above this is a bomb or damage. */
const MAX_DEFLATE_RATIO = 1032;
const ZIP64 = 'Este proyecto usa un formato de archivo no admitido (zip64)';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new Blob([bytes as BlobPart]).stream();
  const out = await new Response(
    src.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
  ).arrayBuffer();
  return new Uint8Array(out);
}

const deflateRaw = (b: Uint8Array) => pipe(b, new CompressionStream('deflate-raw'));

/** Inflate, aborting as soon as the output grows past `limit` bytes. Returns null when it does. */
async function inflateRaw(raw: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(raw as BufferSource).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function validPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /[\\:\0]/.test(path)) return false;
  return !path.split('/').some((seg) => seg === '..');
}

interface Entry { name: Uint8Array; crc: number; method: number; data: Uint8Array; size: number; offset: number }

export async function writeZip(files: ProjectFile[], opts?: { deflate?: boolean }): Promise<Uint8Array> {
  if (files.length > MAX_ENTRIES) throw new HspError('El proyecto tiene demasiados archivos para guardarse');
  const enc = new TextEncoder();
  const entries: Entry[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    let method = 0;
    let data = f.bytes;
    if (opts?.deflate !== false && !f.store && f.bytes.length > 0) {
      const packed = await deflateRaw(f.bytes);
      if (packed.length < f.bytes.length) { method = 8; data = packed; }
    }
    entries.push({ name, crc: crc32(f.bytes), method, data, size: f.bytes.length, offset });
    offset += 30 + name.length + data.length;
    if (offset > MAX_SIZE) throw new HspError(TOO_BIG);
  }
  const cdSize = entries.reduce((s, e) => s + 46 + e.name.length, 0);
  const total = offset + cdSize + 22;
  if (total > MAX_SIZE) throw new HspError(TOO_BIG);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    dv.setUint32(p, SIG_LOCAL, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, FLAG_UTF8, true);
    dv.setUint16(p + 8, e.method, true);
    dv.setUint16(p + 10, 0, true);
    dv.setUint16(p + 12, DOS_DATE_1980, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.size, true);
    dv.setUint16(p + 26, e.name.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  for (const e of entries) {
    dv.setUint32(p, SIG_CENTRAL, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, FLAG_UTF8, true);
    dv.setUint16(p + 10, e.method, true);
    dv.setUint16(p + 12, 0, true);
    dv.setUint16(p + 14, DOS_DATE_1980, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.size, true);
    dv.setUint16(p + 28, e.name.length, true);
    // extra, comment, disk, internal and external attributes stay 0
    dv.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }
  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, cdSize, true);
  dv.setUint32(p + 16, offset, true);
  return out;
}

export async function readZip(bytes: Uint8Array): Promise<ProjectFile[]> {
  const bad = (why: string) => new HspError(`${DAMAGED}: ${why}`);
  if (bytes.length < 22) throw bad('no es un archivo de proyecto válido');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 + dv.getUint16(eocd + 20, true) !== bytes.length) {
    throw bad('no es un archivo de proyecto válido');
  }
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX_SIZE || cdOffset === MAX_SIZE) throw new HspError(ZIP64);
  if (cdOffset + cdSize > eocd) throw bad('el índice de archivos está cortado');
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out: ProjectFile[] = [];
  const seen = new Set<string>();
  let unpackedTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw bad('el índice de archivos no es válido');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    if (p + 46 + nlen > bytes.length) throw bad('el índice de archivos está cortado');
    let path: string;
    try {
      path = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    } catch {
      throw bad('un nombre de archivo no es válido');
    }
    p += 46 + nlen + elen + clen;
    if (!validPath(path)) throw bad('un nombre de archivo no es seguro');
    if (seen.has(path)) throw bad(`archivo repetido: ${path}`);
    seen.add(path);
    if (flags & FLAG_ENCRYPTED) throw new HspError('Este proyecto está cifrado y no se puede abrir');
    if (csize === MAX_SIZE || usize === MAX_SIZE || lho === MAX_SIZE) throw new HspError(ZIP64);
    if (method !== 0 && method !== 8) throw bad(`${path} usa una compresión no admitida`);
    unpackedTotal += usize;
    if (unpackedTotal > MAX_UNPACKED_TOTAL || (method === 8 && usize > csize * MAX_DEFLATE_RATIO)) {
      throw bad(`${path} declara un tamaño descomprimido excesivo`);
    }
    if (lho + 30 > bytes.length || dv.getUint32(lho, true) !== SIG_LOCAL) throw bad(`falta la cabecera de ${path}`);
    // Sizes come from the central directory, so a data descriptor (flag bit 3) needs no special handling.
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (start + csize > cdOffset) throw bad(`${path} está cortado`);
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else {
      let inflated: Uint8Array | null;
      try {
        inflated = await inflateRaw(raw, usize);
      } catch {
        throw bad(`no se pudo descomprimir ${path}`);
      }
      if (!inflated) throw bad(`${path} es más grande de lo declarado`);
      data = inflated;
    }
    if (data.length !== usize || crc32(data) !== crc) throw bad(`${path} está corrupto`);
    out.push({ path, bytes: data.slice() });
  }
  return out;
}
