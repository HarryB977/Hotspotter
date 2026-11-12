import { composeInputsFromDoc, encodePngRgba8, packMaps, toAnvilTable, toHotspotJson } from '@hotspotter/core';
import type { ExportPreset, MapPixels } from '@hotspotter/core';
import { composeAtlas, heightToRgba8, readbackRgba8 } from '@hotspotter/engine';
import type { AtlasMaps } from '@hotspotter/engine';
import { useProject } from '../state/store';

export async function encodePng(p: MapPixels): Promise<Blob> {
  return new Blob([await encodePngRgba8(p)], { type: 'image/png' });
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
    headers: { 'Content-Type': 'application/octet-stream', 'X-Hotspotter': '1' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  });
  const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !json.path) throw new ExportUploadError(json.error ?? `HTTP ${res.status}`);
  return json.path;
}

/** Composes a fresh atlas at `resolutionPx`, uploads maps, hotspot.json and Anvil csv, returns written paths. */
export async function exportProject(opts: ExportOptions): Promise<string[]> {
  const { doc, gpuMaterial, gpu, structure } = useProject.getState();
  if (!doc || !gpuMaterial || !gpu) throw new Error('No project');
  // Resolved at the export resolution, so hotspot.json and the Anvil csv px match the PNGs.
  const { layout, placements, material: mat } = composeInputsFromDoc(doc, opts.resolutionPx);
  let maps: AtlasMaps | null = null;
  let heightTex: GPUTexture | null = null;
  try {
    maps = await composeAtlas(gpu, {
      layout, material: gpuMaterial, placements, resolutionPx: opts.resolutionPx, structure: structure?.gpu,
    });
    heightTex = heightToRgba8(gpu, maps);
    // One readback at a time keeps the staging buffers and CPU copies from stacking up at 8192.
    const atlas = maps;
    const heightRgba = heightTex;
    const readAll = async () => {
      const baseColor = await readbackRgba8(gpu, atlas.baseColor);
      const normal = await readbackRgba8(gpu, atlas.normal);
      const height = await readbackRgba8(gpu, heightRgba);
      const roughness = await readbackRgba8(gpu, atlas.roughness);
      const metallic = await readbackRgba8(gpu, atlas.metallic);
      const ao = await readbackRgba8(gpu, atlas.ao);
      return { baseColor, normal, height, roughness, metallic, ao };
    };
    const packed = packMaps(opts.preset, await readAll());
    const pngNames = packed.map((f) => `${mat.name}${f.suffix}.png`);
    const total = packed.length + 2;
    const written: string[] = [];
    let i = 0;
    const put = async (name: string, body: Blob | string) => {
      opts.onProgress?.(i++, total, name);
      written.push(await upload(opts.dir, name, body));
    };
    // Shift each file off the list so its pixels can be collected once uploaded.
    for (const name of pngNames) await put(name, await encodePng(packed.shift()!.pixels));
    const json = toHotspotJson(layout, { name: mat.name, heightRangeM: maps.heightRangeM, maps: pngNames });
    await put(`${mat.name}.hotspot.json`, json);
    await put(`${mat.name}.anvil.csv`, toAnvilTable(layout));
    opts.onProgress?.(total, total, '');
    return written;
  } finally {
    heightTex?.destroy();
    if (maps) {
      const m = maps;
      for (const t of [m.baseColor, m.normal, m.height, m.roughness, m.metallic, m.ao, m.rectId, m.pieceId, m.jointDistM, m.loss]) {
        t.destroy();
      }
    }
  }
}
