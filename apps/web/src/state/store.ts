import { create } from 'zustand';
import {
  CONTINUOUS, chooseMaps, classifyMapFile, createDefaultDoc, materialNameFromFiles,
} from '@hotspotter/core';
import type { MapKind, MaterialSettings, ProjectDoc } from '@hotspotter/core';
import { initGpu, uploadMaterial, WebGpuUnavailableError } from '@hotspotter/engine';
import type { GpuContext, GpuMaterial, LoadedMaterial } from '@hotspotter/engine';
import { es } from '../i18n/es';

export interface ProjectState {
  doc: ProjectDoc | null;
  material: LoadedMaterial | null;
  gpuMaterial: GpuMaterial | null;
  gpu: GpuContext | null;
  error: string | null;
  importing: boolean;
  /** Files of the last import, including unrecognised and ignored ones. */
  sources: File[];
  initGpu(): Promise<void>;
  importFiles(files: File[]): Promise<void>;
  setDoc(d: ProjectDoc): void;
  /** Merges settings; re-uploads the GPU textures when files or normal convention change. */
  updateSettings(patch: Partial<MaterialSettings>): Promise<void>;
  /** Assigns a source file to a map kind (null = ignore it) and rebuilds `settings.files`. */
  assignMap(filename: string, kind: MapKind | null): Promise<void>;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tga|tiff?)$/i;

/** Decoded bitmaps of the current import, by file name. */
/** Shared so a drop before the app-start init finishes waits for the same device. */
let gpuReady: Promise<GpuContext> | null = null;

const bitmaps = new Map<string, ImageBitmap>();

async function decode(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

async function buildImages(
  files: MaterialSettings['files'],
  sources: File[],
): Promise<LoadedMaterial['images']> {
  const images: LoadedMaterial['images'] = {};
  for (const [kind, name] of Object.entries(files) as [MapKind, string][]) {
    let bmp = bitmaps.get(name);
    if (!bmp) {
      const src = sources.find((f) => f.name === name);
      if (!src) continue;
      bmp = await decode(src);
      bitmaps.set(name, bmp);
    }
    images[kind] = bmp;
  }
  return images;
}

function withMaterialNode(doc: ProjectDoc, settings: MaterialSettings): ProjectDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === 'material' ? { ...n, params: settings } : n)),
  } as ProjectDoc;
}

function destroyTextures(m: GpuMaterial | null): void {
  if (m) for (const t of Object.values(m.textures)) t.destroy();
}

export const useProject = create<ProjectState>()((set, get) => ({
  doc: null,
  material: null,
  gpuMaterial: null,
  gpu: null,
  error: null,
  importing: false,
  sources: [],

  async initGpu() {
    try {
      gpuReady ??= initGpu();
      set({ gpu: await gpuReady, error: null });
    } catch (e) {
      set({ error: e instanceof WebGpuUnavailableError ? es.webgpuUnavailable : String(e) });
    }
  },

  async importFiles(files) {
    await get().initGpu();
    const { gpu } = get();
    if (!gpu) return;
    const images = files.filter((f) => IMAGE_EXT.test(f.name));
    const names = images.map((f) => f.name);
    const { files: chosen, normalConvention } = chooseMaps(names);
    if (Object.keys(chosen).length === 0) return;
    set({ importing: true });
    try {
      bitmaps.clear();
      const loaded = await buildImages(chosen, images);
      const rough = chosen.roughness;
      const settings: MaterialSettings = {
        name: materialNameFromFiles(names),
        files: chosen,
        normalConvention,
        roughnessIsGloss: rough ? classifyMapFile(rough)?.isGloss === true : false,
        tileSizeM: [1, 1],
        heightScaleM: 0.02,
        period: { ...CONTINUOUS },
        allowRotation: false,
      };
      const material: LoadedMaterial = { settings, images: loaded };
      destroyTextures(get().gpuMaterial);
      set({
        sources: images,
        material,
        gpuMaterial: uploadMaterial(gpu, material),
        doc: createDefaultDoc(settings),
        error: null,
      });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ importing: false });
    }
  },

  setDoc(d) {
    set({ doc: d });
  },

  async updateSettings(patch) {
    const { material, gpu, doc, sources } = get();
    if (!material || !gpu) return;
    const settings: MaterialSettings = { ...material.settings, ...patch };
    const reupload =
      patch.files !== undefined ||
      (patch.normalConvention !== undefined && patch.normalConvention !== material.settings.normalConvention);
    const next: Partial<ProjectState> = {
      doc: doc ? withMaterialNode(doc, settings) : doc,
    };
    if (reupload) {
      const images = await buildImages(settings.files, sources);
      const loaded: LoadedMaterial = { settings, images };
      destroyTextures(get().gpuMaterial);
      next.material = loaded;
      next.gpuMaterial = uploadMaterial(gpu, loaded);
    } else {
      next.material = { ...material, settings };
      const gm = get().gpuMaterial;
      next.gpuMaterial = gm ? { ...gm, settings } : gm;
    }
    set(next);
  },

  async assignMap(filename, kind) {
    const { material } = get();
    if (!material) return;
    const files: MaterialSettings['files'] = {};
    for (const [k, v] of Object.entries(material.settings.files) as [MapKind, string][]) {
      if (v !== filename) files[k] = v;
    }
    const patch: Partial<MaterialSettings> = { files };
    if (kind) {
      files[kind] = filename;
      const m = classifyMapFile(filename);
      if (kind === 'normal' && m?.normalConvention) patch.normalConvention = m.normalConvention;
    }
    if (files.roughness !== material.settings.files.roughness) {
      patch.roughnessIsGloss = files.roughness ? classifyMapFile(files.roughness)?.isGloss === true : false;
    }
    await get().updateSettings(patch);
  },
}));
