import * as THREE from 'three';
import { rectIdImage } from '@hotspotter/core';
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
 * Packs the red channel of each source into the channels of one flipped RGBA8 image of `w` × `h` (alpha 255). A
 * source of another size (the 1 × 1 wear mask without wear) is sampled at the nearest texel.
 */
function packed(w: number, h: number, sources: (Image8 | null)[]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o + 3] = 255;
      sources.forEach((s, c) => {
        if (!s) return;
        const sx = Math.min(s.width - 1, Math.floor(((x + 0.5) * s.width) / w));
        const sy = Math.min(s.height - 1, Math.floor(((h - 1 - y + 0.5) * s.height) / h));
        out[o + c] = s.data[(sy * s.width + sx) * 4];
      });
    }
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
    const rgba = (t: GPUTexture) => start(() => readbackRgba8(gpu, t));
    const ids = async (t: GPUTexture): Promise<Image8> => {
      const r = await start(() => readbackR32(gpu, t));
      return rectIdImage(r.data as Uint32Array, r.width, r.height);
    };
    try {
      const baseColor = await rgba(maps.baseColor);
      const normal = await rgba(maps.normal);
      const roughness = await rgba(maps.roughness);
      const metallic = await rgba(maps.metallic);
      const ao = await rgba(maps.ao);
      const height = await start(async () => {
        const grey = await heightToRgba8(gpu, maps);
        try {
          return await readbackRgba8(gpu, grey);
        } finally {
          grey.destroy();
        }
      });
      const wearMask = await rgba(maps.wearMask);
      const rectId = await ids(maps.rectId);
      const pieceId = await ids(maps.pieceId);
      if (!isCurrent()) return null;
      const { width: w, height: h } = baseColor;
      return {
        baseColor: atlasTexture(baseColor, true),
        normal: atlasTexture(normal, false),
        orm: texture(packed(w, h, [ao, roughness, metallic]), w, h, false),
        heightWear: texture(packed(w, h, [height, wearMask]), w, h, false),
        rectId: atlasTexture(rectId, false),
        pieceId: atlasTexture(pieceId, false),
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
