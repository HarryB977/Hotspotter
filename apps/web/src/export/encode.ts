import { packMaps, placeMaterial, resolveLayout, toAnvilTable, toHotspotJson } from '@hotspotter/core';
import type { ExportPreset, MapPixels, MaterialSettings, NodeParams } from '@hotspotter/core';
import { composeAtlas, heightToRgba8, readbackRgba8 } from '@hotspotter/engine';
import type { AtlasMaps } from '@hotspotter/engine';
import { useProject } from '../state/store';

export async function encodePng(p: MapPixels): Promise<Blob> {
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const bytes = new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  ctx.putImageData(new ImageData(bytes, p.width, p.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export interface ExportOptions {
  dir: string;
  preset: ExportPreset;
  resolutionPx: number;
  /** Called before each file upload with the 0-based index, the total and the file name. */
  onProgress?: (index: number, total: number, name: string) => void;
}

/** Thrown with the server's message when an upload is rejected. */
export class ExportUploadError extends Error {}

async function upload(dir: string, name: string, body: Blob | string): Promise<string> {
  const q = new URLSearchParams({ dir, name });
  const res = await fetch(`/api/export/file?${q}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  });
  const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !json.path) throw new ExportUploadError(json.error ?? `HTTP ${res.status}`);
  return json.path;
}

/** Composes a fresh atlas at `resolutionPx`, uploads maps, hotspot.json and Anvil csv, returns written paths. */
export async function exportProject(opts: ExportOptions): Promise<string[]> {
  const { doc, gpuMaterial, gpu } = useProject.getState();
  if (!doc || !gpuMaterial || !gpu) throw new Error('No project');
  const layout = resolveLayout(doc);
  const mat = doc.nodes.find((n) => n.id === 'material')!.params as MaterialSettings;
  const pl = doc.nodes.find((n) => n.id === 'placement')!.params as NodeParams['placement'];
  const placements = placeMaterial(layout, mat.period, {
    variation: pl.variation,
    seed: pl.seed,
    materialAllowsRotation: mat.allowRotation,
    tileSizeM: mat.tileSizeM,
  });
  let maps: AtlasMaps | null = null;
  let heightTex: GPUTexture | null = null;
  try {
    maps = await composeAtlas(gpu, { layout, material: gpuMaterial, placements, resolutionPx: opts.resolutionPx });
    heightTex = heightToRgba8(gpu, maps);
    const [baseColor, normal, height, roughness, metallic, ao] = await Promise.all([
      readbackRgba8(gpu, maps.baseColor),
      readbackRgba8(gpu, maps.normal),
      readbackRgba8(gpu, heightTex),
      readbackRgba8(gpu, maps.roughness),
      readbackRgba8(gpu, maps.metallic),
      readbackRgba8(gpu, maps.ao),
    ]);
    const packed = packMaps(opts.preset, { baseColor, normal, height, roughness, metallic, ao });
    const pngNames = packed.map((f) => `${mat.name}${f.suffix}.png`);
    const total = packed.length + 2;
    const written: string[] = [];
    let i = 0;
    const put = async (name: string, body: Blob | string) => {
      opts.onProgress?.(i++, total, name);
      written.push(await upload(opts.dir, name, body));
    };
    for (let k = 0; k < packed.length; k++) await put(pngNames[k], await encodePng(packed[k].pixels));
    const json = toHotspotJson(layout, { name: mat.name, heightRangeM: maps.heightRangeM, maps: pngNames });
    await put(`${mat.name}.hotspot.json`, json);
    await put(`${mat.name}.anvil.csv`, toAnvilTable(layout));
    opts.onProgress?.(total, total, '');
    return written;
  } finally {
    heightTex?.destroy();
    if (maps) {
      for (const t of [maps.baseColor, maps.normal, maps.height, maps.roughness, maps.metallic, maps.ao, maps.rectId]) {
        t.destroy();
      }
    }
  }
}
