import {
  composeInputsFromDoc, encodePngRgba8, packMaps, rectIdImage, toAnvilTable, toHotspotJson,
} from '@hotspotter/core';
import type { CheckResult, ExportPreset, MapPixels } from '@hotspotter/core';
import { composeAtlas, heightToRgba8, readbackR32, readbackRgba8 } from '@hotspotter/engine';
import type { AtlasMaps } from '@hotspotter/engine';
import { composeInputFor, useProject } from '../state/store';

export async function encodePng(p: MapPixels): Promise<Blob> {
  return new Blob([await encodePngRgba8(p)], { type: 'image/png' });
}

export interface ExportOptions {
  dir: string;
  preset: ExportPreset;
  resolutionPx: number;
  /** Check results to record in hotspot.json (id and status); omitted when the evaluation failed. */
  checks?: CheckResult[];
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

/**
 * Composes a fresh atlas at `resolutionPx` from the same inputs as the preview (composeInputFor: wear, dirt, mask,
 * second set, grain axis), uploads the maps, _WearMask, _RectID, hotspot.json and the Anvil csv, and returns the
 * written paths.
 */
export async function exportProject(opts: ExportOptions): Promise<string[]> {
  const state = useProject.getState();
  const { doc, gpuMaterial, gpu } = state;
  if (!doc || !gpuMaterial || !gpu) throw new Error('No project');
  // Resolved at the export resolution, so hotspot.json and the Anvil csv px match the PNGs.
  const inputs = composeInputsFromDoc(doc, opts.resolutionPx);
  const { layout, material: mat, dirt } = inputs;
  // Downward streaks: a vertical mirror (or a rotation) in the engine would turn them (docs/06).
  const runoff = dirt.runoff > 0;
  let maps: AtlasMaps | null = null;
  let heightTex: GPUTexture | null = null;
  try {
    const input = composeInputFor({ ...state, doc, gpuMaterial }, inputs, opts.resolutionPx);
    maps = await composeAtlas(gpu, input);
    // Not exported: free them before the readbacks, which peak in memory at 8192.
    for (const t of [maps.loss, maps.pieceId, maps.jointDistM, maps.border, maps.macroHeight]) t.destroy();
    heightTex = await heightToRgba8(gpu, maps);
    maps.height.destroy();
    // One readback at a time keeps the staging buffers and CPU copies from stacking up at 8192 (R12); each GPU map
    // is freed as soon as its pixels are on the CPU.
    const take = async (t: GPUTexture) => {
      try {
        return await readbackRgba8(gpu, t);
      } finally {
        t.destroy();
      }
    };
    const atlas = maps;
    const heightRgba = heightTex;
    const readAll = async () => {
      const baseColor = await take(atlas.baseColor);
      const normal = await take(atlas.normal);
      const height = await take(heightRgba);
      const roughness = await take(atlas.roughness);
      const metallic = await take(atlas.metallic);
      const ao = await take(atlas.ao);
      return { baseColor, normal, height, roughness, metallic, ao };
    };
    const packed = packMaps(opts.preset, await readAll());
    const pngNames = packed.map((f) => `${mat.name}${f.suffix}.png`);
    const wearName = `${mat.name}_WearMask.png`;
    const rectIdName = `${mat.name}_RectID.png`;
    const total = packed.length + 4;
    const written: string[] = [];
    let i = 0;
    const put = async (name: string, body: Blob | string) => {
      opts.onProgress?.(i++, total, name);
      written.push(await upload(opts.dir, name, body));
    };
    // Shift each file off the list so its pixels can be collected once uploaded.
    for (const name of pngNames) await put(name, await encodePng(packed.shift()!.pixels));

    const { width, height } = atlas.rectId;
    // Without wear the mask is a 1 × 1 placeholder: export it black at full size.
    let wearMask;
    if (atlas.wearMask.width === 1) {
      const data = new Uint8Array(width * height * 4);
      for (let k = 3; k < data.length; k += 4) data[k] = 255;
      wearMask = { width, height, data };
    } else {
      wearMask = await take(atlas.wearMask);
    }
    await put(wearName, await encodePng(wearMask));

    const ids = await readbackR32(gpu, atlas.rectId);
    atlas.rectId.destroy();
    await put(rectIdName, await encodePng(rectIdImage(ids.data as Uint32Array, ids.width, ids.height)));

    const json = toHotspotJson(layout, {
      name: mat.name, heightRangeM: atlas.heightRangeM, maps: [...pngNames, wearName, rectIdName],
      // Omitted when the maps were composed without wear.
      wear: input.wear ? { family: input.wear.family, seed: input.wear.seed } : undefined,
      checks: opts.checks?.map((c) => ({ id: c.id, status: c.status })),
      runoff,
    });
    await put(`${mat.name}.hotspot.json`, json);
    await put(`${mat.name}.anvil.csv`, toAnvilTable(layout, { runoff }));
    opts.onProgress?.(total, total, '');
    return written;
  } finally {
    heightTex?.destroy();
    if (maps) {
      // destroy() is idempotent: the maps already freed above are skipped.
      const m = maps;
      for (const t of [m.baseColor, m.normal, m.height, m.roughness, m.metallic, m.ao, m.rectId, m.wearMask]) {
        t.destroy();
      }
    }
  }
}
