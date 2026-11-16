import * as THREE from 'three';
import { rectIdRgb } from '@hotspotter/core';
import { heightToRgba8, readbackR32, readbackRgba8 } from '@hotspotter/engine';
import type { AtlasMaps, GpuContext } from '@hotspotter/engine';

/**
 * The preview atlas as WebGL textures (decision 80): read back once per atlas, rows flipped so uv (0,0) is the
 * atlas's bottom-left as in the engine's UV convention, wrapping RepeatWrapping on both axes as an engine imports a
 * hotspot sheet.
 */
export interface AtlasTextureSet {
  /** sRGB colour. */
  baseColor: THREE.DataTexture;
  /** GL tangent-space normal, linear. */
  normal: THREE.DataTexture;
  /** R = ao, G = roughness, B = metallic: the channels three's aoMap, roughnessMap and metalnessMap read. */
  orm: THREE.DataTexture;
  /** R = height (the grey of the 2D view), G = wearMask. */
  heightWear: THREE.DataTexture;
  /** Rect and piece ids coloured as the 2D view and the exported _RectID. */
  rectId: THREE.DataTexture;
  pieceId: THREE.DataTexture;
  /** Increases with every set built; tests read it to tell a new set from the old. */
  gen: number;
}

/** Debug counters (exposed by the test harness): sets built, textures alive, maps read back. */
export const atlasTextureStats = { gen: 0, live: 0, reads: 0 };

export interface Image8 {
  width: number;
  height: number;
  data: Uint8Array;
}

/** RGBA8 with the rows in reverse order: the atlas is stored top row first, a GL texture bottom row first. */
function flipped(img: Image8): Uint8Array {
  const { width: w, height: h, data } = img;
  const row = w * 4;
  const out = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) out.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

/**
 * The red channel of `img` as `w` × `h` bytes, rows flipped like `flipped`. A source of another size (the 1 × 1 wear
 * mask without wear) is sampled at the nearest texel.
 */
function redFlipped(img: Image8, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const { width: sw, height: sh, data } = img;
  const same = sw === w && sh === h;
  for (let y = 0; y < h; y++) {
    const sy = same ? h - 1 - y : Math.min(sh - 1, Math.floor(((h - 1 - y + 0.5) * sh) / h));
    const src = sy * sw;
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      const sx = same ? x : Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
      out[dst + x] = data[(src + sx) * 4];
    }
  }
  return out;
}

/** A row-major id map coloured as the 2D view and _RectID (`rectIdRgb`), rows flipped like `flipped`. */
function idsFlipped(ids: Uint32Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  // Neighbouring pixels nearly always share an id: remember the last colour instead of hashing every pixel.
  let last = -1;
  let c: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w;
    for (let x = 0, o = y * w * 4; x < w; x++, o += 4) {
      const id = ids[src + x];
      if (id !== last) {
        last = id;
        c = rectIdRgb(id);
      }
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** One RGBA8 image from up to three single-channel planes (missing ones 0), alpha 255. */
function packed(n: number, r: Uint8Array, g: Uint8Array, b: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out[o] = r[i];
    out[o + 1] = g[i];
    out[o + 2] = b ? b[i] : 0;
    out[o + 3] = 255;
  }
  return out;
}

function texture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // Hotspot sheets are imported with Repeat: a strip that spans the atlas tiles across it, and every other face's uv
  // stays inside its rect, so only texels at the atlas border see the other side, as in an engine.
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  atlasTextureStats.live++;
  return t;
}

/** A texture of an atlas-order (top row first) RGBA8 image, set up as the atlas maps are. */
export function atlasTexture(img: Image8, srgb: boolean): THREE.DataTexture {
  return texture(flipped(img), img.width, img.height, srgb);
}

export function releaseTexture(t: THREE.Texture): void {
  t.dispose();
  atlasTextureStats.live--;
}

export function textureList(set: AtlasTextureSet): THREE.DataTexture[] {
  return [set.baseColor, set.normal, set.orm, set.heightWear, set.rectId, set.pieceId];
}

/** Point filtering (nearest texel, no mipmaps) for pixel art, or the default trilinear filtering. */
export function setPointFilter(set: AtlasTextureSet, point: boolean): void {
  for (const t of textureList(set)) {
    const mag = point ? THREE.NearestFilter : THREE.LinearFilter;
    const min = point ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
    if (t.magFilter === mag && t.minFilter === min) continue;
    t.magFilter = mag;
    t.minFilter = min;
    t.generateMipmaps = !point;
    t.needsUpdate = true;
  }
}

export function disposeAtlasTextures(set: AtlasTextureSet): void {
  for (const t of textureList(set)) releaseTexture(t);
}

/** A read found its atlas superseded (a newer atlas, an unmount): the set is not built. */
class Stale extends Error {}

/** Reads run one after another on this chain, never two at once, so their staging buffers never stack up. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Reads the atlas maps back one at a time and builds the texture set, or resolves null as soon as `isCurrent()`
 * turns false. `isCurrent` is checked right before each read is started, and each read submits its copy before its
 * first await, so a map is never read after the store destroyed it.
 */
export function loadAtlasTextures(
  gpu: GpuContext,
  maps: AtlasMaps,
  isCurrent: () => boolean,
): Promise<AtlasTextureSet | null> {
  const run = async (): Promise<AtlasTextureSet | null> => {
    const start = <T>(read: () => Promise<T>): Promise<T> => {
      if (!isCurrent()) throw new Stale();
      atlasTextureStats.reads++;
      return read();
    };
    const { width: w, height: h } = maps.baseColor;
    // Each map is converted as soon as it lands, so the CPU work is spread between the reads (the main thread keeps
    // drawing frames) and only the converted bytes are kept.
    const rgba = async (t: GPUTexture) => flipped(await start(() => readbackRgba8(gpu, t)));
    const red = async (t: GPUTexture) => redFlipped(await start(() => readbackRgba8(gpu, t)), w, h);
    const ids = async (t: GPUTexture) => {
      const r = await start(() => readbackR32(gpu, t));
      return idsFlipped(r.data as Uint32Array, r.width, r.height);
    };
    try {
      const baseColor = await rgba(maps.baseColor);
      const normal = await rgba(maps.normal);
      const orm = packed(w * h, await red(maps.ao), await red(maps.roughness), await red(maps.metallic));
      const height = await start(async () => {
        const grey = await heightToRgba8(gpu, maps);
        try {
          return redFlipped(await readbackRgba8(gpu, grey), w, h);
        } finally {
          grey.destroy();
        }
      });
      const heightWear = packed(w * h, height, await red(maps.wearMask), null);
      const rectId = await ids(maps.rectId);
      const pieceId = await ids(maps.pieceId);
      if (!isCurrent()) return null;
      return {
        baseColor: texture(baseColor, w, h, true),
        normal: texture(normal, w, h, false),
        orm: texture(orm, w, h, false),
        heightWear: texture(heightWear, w, h, false),
        rectId: texture(rectId, w, h, false),
        pieceId: texture(pieceId, w, h, false),
        gen: ++atlasTextureStats.gen,
      };
    } catch (e) {
      if (e instanceof Stale) return null;
      throw e;
    }
  };
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}
