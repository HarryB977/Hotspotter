import { create } from 'zustand';
import {
  CONTINUOUS, analyzeStructure, chooseMaps, classifyMapFile, composeInputsFromDoc, createDefaultDoc, downsample,
  jointMeanRgb, meanRgb, proposeFamily, resolveMaterialName, runChecks, toGray, updateNodeParams, validateLayout,
} from '@hotspotter/core';
import type {
  CheckResult, DocNode, GrayImage, HotspotLayout, LayoutIssue, MapKind, MaterialSettings, MaterialType, NodeParams,
  NodeType, ProjectDoc, ProportionIssue, RectPlacement, StructureResult,
} from '@hotspotter/core';
import {
  composeAtlas, hasMapFromFiles, initGpu, readbackR32, readbackRgba8, uploadMaterial, uploadRgba8, uploadStructure,
  WebGpuUnavailableError,
} from '@hotspotter/engine';
import type { AtlasMaps, ComposeInput, GpuContext, GpuMaterial, GpuStructure, LoadedMaterial } from '@hotspotter/engine';
import { es } from '../i18n/es';

export type PreviewRes = 512 | 1024 | 2048;
export type ActiveMap = MapKind | 'rectId' | 'pieceId' | 'wearMask';

/** Structure analysis of the current material and its GPU maps. */
export interface StructureState {
  result: StructureResult;
  gpu: GpuStructure;
  /** Map the analysis read: the height, or the albedo (inverted luma) when there is no height. */
  source: 'height' | 'baseColor';
}

/**
 * User B/N wear mask (atlas UV). Kept in store state only: the document has no image storage yet, so it is not saved
 * with the project.
 */
export interface MaskState {
  name: string;
  texture: GPUTexture;
}

/**
 * Second PBR set revealed in the loss (wear.substrate.source = 'secondSet'). Store state only, like the mask; it has
 * no document of its own.
 */
export interface SubstrateState {
  name: string;
  gpu: GpuMaterial;
}

/** A composed atlas with the layout and checks it was composed from. */
export interface AtlasResult {
  maps: AtlasMaps;
  /** Inputs the atlas was composed from (by identity, to tell whether it is current). */
  doc: ProjectDoc;
  gpuMaterial: GpuMaterial;
  structure: StructureState | null;
  mask: MaskState | null;
  substrate: SubstrateState | null;
  layout: HotspotLayout;
  placements: RectPlacement[];
  issues: ProportionIssue[];
  /** Structural problems (overlap, out of bounds…) from validateLayout. */
  layoutIssues: LayoutIssue[];
  resolutionPx: number;
  gpuMs: number;
}

/** Results of the last automatic checks and the evaluation size their points refer to. */
export interface ChecksState {
  results: CheckResult[];
  width: number;
  height: number;
}

/** A request to centre the atlas view on a point (atlas UV, 0..1); `seq` changes on every request. */
export interface ViewFocus {
  u: number;
  v: number;
  seq: number;
}

export interface ProjectState {
  doc: ProjectDoc | null;
  material: LoadedMaterial | null;
  gpuMaterial: GpuMaterial | null;
  gpu: GpuContext | null;
  /** WebGPU initialisation failure; shown full screen. */
  error: string | null;
  /** Import failure; shown in the Material panel. */
  importError: string | null;
  importing: boolean;
  /** Files of the last import, including unrecognised and ignored ones. */
  sources: File[];
  /** Preview resolution; the export resolution lives in the output node. */
  previewRes: PreviewRes;
  activeMap: ActiveMap;
  atlas: AtlasResult | null;
  /** Last preview composition failure, shown in the status bar; cleared by the next success. */
  composeError: string | null;
  structure: StructureState | null;
  /** Last structure analysis failure, shown in the structure section; cleared by the next success. */
  structureError: string | null;
  mask: MaskState | null;
  substrate: SubstrateState | null;
  /** Last mask or substrate import failure, shown in the wear section; cleared by the next success. */
  wearError: string | null;
  checks: ChecksState | null;
  /** Last evaluation failure, shown in the checks panel; cleared by the next success. */
  checksError: string | null;
  /** A recomposition or request is newer than `checks`: they describe an older atlas until the next results land. */
  checksPending: boolean;
  viewFocus: ViewFocus | null;
  /** Centres the atlas view on atlas UV (u, v). */
  focusAtlas(u: number, v: number): void;
  /**
   * Composes at EVAL_RES (or reuses the preview atlas when it is at that resolution and current), reads the maps back
   * and runs the automatic checks. Never runs concurrently with itself: requests queue, and a queued request that a
   * newer one supersedes is skipped (resolves null). The results are stored only if no newer request or
   * recomposition came meanwhile, and are returned to the caller either way. `exportResolutionPx` defaults to the
   * output node's. `force` runs the request even if a newer one supersedes it (export needs a result, not a skip); it
   * still resolves null if the evaluation fails.
   */
  runEvaluation(opts?: EvaluationOptions): Promise<CheckResult[] | null>;
  setPreviewRes(r: PreviewRes): void;
  setActiveMap(m: ActiveMap): void;
  /** Shallow-merges params into a node. */
  updateNode<T extends NodeType>(id: string, patch: Partial<NodeParams[T]>): void;
  /** Replaces the layout node params wholesale, so no keys of another mode linger. */
  setLayoutParams(params: NodeParams['layout']): void;
  initGpu(): Promise<void>;
  /**
   * `folder` names the material when the files share no prefix; defaults to the webkitRelativePath folder.
   * 'add' keeps the document and replaces only the map kinds the new files provide.
   */
  importFiles(files: File[], folder?: string, mode?: 'replace' | 'add'): Promise<void>;
  setDoc(d: ProjectDoc): void;
  /** Merges settings; re-uploads the GPU textures when files or normal convention change. */
  updateSettings(patch: Partial<MaterialSettings>): Promise<void>;
  /** Assigns a source file to a map kind (null = ignore it) and rebuilds `settings.files`. */
  assignMap(filename: string, kind: MapKind | null): Promise<void>;
  /**
   * Analyses the material structure (height, else inverted albedo luma, at <= 512 px), uploads it, and sets the
   * structure node and, unless `periodUserSet`, the proposed period. Discarded if the maps change meanwhile.
   * `applyPeriod` (the Detectar button, R25) applies the detected period regardless and clears `periodUserSet`.
   */
  analyze(opts?: { applyPeriod?: boolean }): Promise<void>;
  /** Stores the segmentation threshold (null = automatic) and re-analyses. */
  setStructureThreshold(t: number | null): Promise<void>;
  /** Loads a B/N wear mask (red channel) and enables it in the wear node. */
  importMask(file: File): Promise<void>;
  /** Drops the mask texture and disables the mask in the wear node. */
  clearMask(): void;
  /** Loads a second PBR set (same map classification as the material, no document of its own) as the substrate. */
  importSubstrate(files: File[]): Promise<void>;
  clearSubstrate(): void;
  /** Real size (m) one repeat of the second material covers; recomposes without re-uploading. */
  setSubstrateTileSize(t: [number, number]): void;
}

// TGA and TIFF are not listed: createImageBitmap cannot decode them, so they are ignored.
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;

/** Shared so a drop before the app-start init finishes waits for the same device. */
let gpuReady: Promise<GpuContext> | null = null;
/** Set once the device is lost; it stays the app error (a lost device never comes back). */
let gpuLostError: string | null = null;

/** Decoded bitmaps of the current material, by file name. */
let bitmaps = new Map<string, ImageBitmap>();

/** Bumped by every import; only the latest import may apply its result. */
let importGen = 0;

/** Bumped by imports and by settings changes that re-upload; guards re-uploading updates. */
let generation = 0;

/** Bumped by settings changes and imports, not by analyses (R26); add-mode imports check it for staleness. */
let materialRev = 0;

/** Bumped by every analysis request; only the latest may apply its result. */
let analyzeGen = 0;

/** Bumped by mask imports and clears and by material replacement; only the latest mask import may apply. */
let maskGen = 0;

/** Bumped by substrate imports and clears and by material replacement; only the latest substrate import may apply. */
let substrateGen = 0;

/**
 * maskGen / substrateGen as last bumped by a material replace. An import discarded while its gen still equals this
 * was dropped by the replace (not by a newer import or a clear) and says so, like R21.
 */
let maskReplacedGen = -1;
let substrateReplacedGen = -1;

/** Map kinds of the second material that the colour pass reads (Task 10); the rest is never uploaded. */
const SUBSTRATE_KINDS: MapKind[] = ['baseColor', 'roughness', 'metallic', 'ao'];

/** Longest side read back from a bitmap for the analysis, before the box downsample to ANALYSIS_SIDE. */
const MAX_READ_SIDE = 2048;
const ANALYSIS_SIDE = 512;

/** Grey analysis input from the height map, else from the albedo's inverted luma; null without either. */
function readGray(images: LoadedMaterial['images']): { gray: GrayImage; source: StructureState['source'] } | null {
  const source = images.height ? 'height' : images.baseColor ? 'baseColor' : null;
  if (!source) return null;
  const bmp = images[source]!;
  const k = Math.min(1, MAX_READ_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const gray = toGray(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), w, h,
    source === 'height' ? 'height' : 'invertedLuma');
  return { gray: downsample(gray, ANALYSIS_SIDE), source };
}

function structureNode(doc: ProjectDoc): DocNode<'structure'> | undefined {
  return doc.nodes.find((n): n is DocNode<'structure'> => n.type === 'structure');
}

function wearNode(doc: ProjectDoc): DocNode<'wear'> | undefined {
  return doc.nodes.find((n): n is DocNode<'wear'> => n.type === 'wear');
}

function dirtNode(doc: ProjectDoc): DocNode<'dirt'> | undefined {
  return doc.nodes.find((n): n is DocNode<'dirt'> => n.type === 'dirt');
}

/** Sets the proposed wear family unless the user picked one; returns `doc` itself when nothing changes. */
function withProposedFamily(doc: ProjectDoc, type: MaterialType, materialName: string): ProjectDoc {
  const wear = wearNode(doc);
  if (!wear || wear.params.userSetFamily) return doc;
  const family = proposeFamily(type, materialName);
  return family === wear.params.family ? doc : updateNodeParams<'wear'>(doc, wear.id, { family });
}

async function decode(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/** Resolves bitmaps from `cache`, decoding the rest into `fresh` (the caller commits or closes it). */
async function buildImages(
  files: MaterialSettings['files'],
  sources: File[],
  cache: Map<string, ImageBitmap>,
  fresh: Map<string, ImageBitmap>,
): Promise<LoadedMaterial['images']> {
  const images: LoadedMaterial['images'] = {};
  for (const [kind, name] of Object.entries(files) as [MapKind, string][]) {
    let bmp = cache.get(name) ?? fresh.get(name);
    if (!bmp) {
      const src = sources.find((f) => f.name === name);
      if (!src) continue;
      try {
        bmp = await decode(src);
      } catch {
        throw new Error(es.material.decodeFailed(name));
      }
      fresh.set(name, bmp);
    }
    images[kind] = bmp;
  }
  return images;
}

/** First path segment of a folder pick (`webkitRelativePath`), or undefined. */
function folderOf(files: File[]): string | undefined {
  const rel = files.find((f) => f.webkitRelativePath)?.webkitRelativePath;
  return rel ? rel.split('/')[0] : undefined;
}

function closeAll(m: Map<string, ImageBitmap>): void {
  for (const b of m.values()) b.close();
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

type StoreSet = (partial: Partial<ProjectState>) => void;

/** Add mode of importFiles: re-uploads only the map kinds the new files provide and keeps the document. */
async function addFiles(
  gpu: GpuContext,
  images: File[],
  set: StoreSet,
  get: () => ProjectState,
): Promise<void> {
  const { files: chosen, normalConvention } = chooseMaps(images.map((f) => f.name));
  const kinds = Object.keys(chosen) as MapKind[];
  const startMaterial = get().material;
  const startRev = materialRev;
  if (kinds.length === 0 || !startMaterial) {
    importGen++;
    generation++;
    set({ importError: es.material.noMaps, importing: false });
    return;
  }
  const mine = ++importGen;
  generation++;
  set({ importing: true, importError: null });
  const fresh = new Map<string, ImageBitmap>();
  try {
    const current = startMaterial.settings;
    const patch: Partial<MaterialSettings> = { files: { ...current.files, ...chosen } };
    if (chosen.normal) patch.normalConvention = normalConvention;
    if (chosen.roughness) patch.roughnessIsGloss = classifyMapFile(chosen.roughness)?.isGloss === true;
    // Decode only the new files; a same-named cached bitmap would be stale.
    const loaded = await buildImages(chosen, images, new Map(), fresh);
    const partial = uploadMaterial(gpu, { settings: { ...current, ...patch }, images: loaded });
    if (mine !== importGen) {
      destroyTextures(partial);
      closeAll(fresh);
      return;
    }
    const { material, gpuMaterial, doc, sources } = get();
    // A settings change committed during the decode would be overwritten by this add; drop the add instead.
    // Analysis commits (period) do not bump materialRev and are kept: settings below merge onto fresh state.
    if (!material || !gpuMaterial || !doc || materialRev !== startRev) {
      destroyTextures(partial);
      closeAll(fresh);
      set({ importing: false, importError: es.material.addDiscarded });
      return;
    }
    generation++;
    materialRev++;
    const settings: MaterialSettings = { ...material.settings, ...patch };
    const textures = { ...gpuMaterial.textures };
    for (const [kind, tex] of Object.entries(partial.textures) as [MapKind, GPUTexture][]) {
      if (kinds.includes(kind)) {
        textures[kind].destroy();
        textures[kind] = tex;
      } else {
        tex.destroy();
      }
    }
    const replaced = new Set(images.map((f) => f.name));
    for (const k of kinds) {
      const old = material.settings.files[k];
      if (old && !Object.values(settings.files).includes(old)) {
        bitmaps.get(old)?.close();
        bitmaps.delete(old);
      }
    }
    for (const [name, bmp] of fresh) {
      bitmaps.get(name)?.close();
      bitmaps.set(name, bmp);
    }
    set({
      sources: [...sources.filter((f) => !replaced.has(f.name)), ...images],
      material: { settings, images: { ...material.images, ...loaded } },
      gpuMaterial: {
        textures, settings, hasNormalMap: settings.files.normal !== undefined,
        hasMap: hasMapFromFiles(settings.files),
      },
      doc: withMaterialNode(doc, settings),
      importing: false,
    });
    if (kinds.includes('height') || kinds.includes('baseColor')) await get().analyze();
  } catch (e) {
    closeAll(fresh);
    if (mine === importGen) {
      set({ importError: e instanceof Error ? e.message : String(e), importing: false });
    }
  }
}

export const useProject = create<ProjectState>()((set, get) => ({
  doc: null,
  material: null,
  gpuMaterial: null,
  gpu: null,
  error: null,
  importError: null,
  importing: false,
  sources: [],
  previewRes: 1024,
  activeMap: 'baseColor',
  atlas: null,
  composeError: null,
  structure: null,
  structureError: null,
  mask: null,
  substrate: null,
  wearError: null,
  checks: null,
  checksError: null,
  checksPending: false,
  viewFocus: null,

  focusAtlas(u, v) {
    set({ viewFocus: { u, v, seq: (get().viewFocus?.seq ?? 0) + 1 } });
  },

  runEvaluation(opts) {
    // A forced evaluation (the export's) covers the debounced one; it would only evaluate the same state again.
    if (opts?.force) clearTimeout(evalTimer);
    return requestEvaluation(opts);
  },

  setPreviewRes(r) {
    set({ previewRes: r });
  },

  setActiveMap(m) {
    set({ activeMap: m });
  },

  updateNode(id, patch) {
    const { doc } = get();
    if (doc) set({ doc: updateNodeParams(doc, id, patch) });
  },

  setLayoutParams(params) {
    const { doc } = get();
    if (!doc) return;
    set({ doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === 'layout' ? { ...n, params } : n)) } as ProjectDoc });
  },

  async initGpu() {
    try {
      if (!gpuReady) {
        gpuReady = initGpu();
        // A lost device (out of video memory, a driver reset at 8192) is unusable: say why, in place of a timeout.
        void gpuReady.then((g) => g.device.lost).then((info) => {
          console.error('GPU device lost', info.reason, info.message);
          gpuLostError = es.gpuLost(info.reason, info.message);
          set({ error: gpuLostError });
        }, () => undefined);
      }
      set({ gpu: await gpuReady, error: gpuLostError });
    } catch (e) {
      set({ error: e instanceof WebGpuUnavailableError ? es.webgpuUnavailable : String(e) });
    }
  },

  async importFiles(files, folder, mode = 'replace') {
    await get().initGpu();
    const { gpu } = get();
    if (!gpu) return;
    const images = files.filter((f) => IMAGE_EXT.test(f.name));
    if (mode === 'add' && get().material && get().doc) {
      await addFiles(gpu, images, set, get);
      return;
    }
    const names = images.map((f) => f.name);
    const { files: chosen, normalConvention } = chooseMaps(names);
    if (Object.keys(chosen).length === 0) {
      importGen++;
      generation++;
      set({ importError: es.material.noMaps, importing: false });
      return;
    }
    const mine = ++importGen;
    generation++;
    set({ importing: true, importError: null });
    const fresh = new Map<string, ImageBitmap>();
    try {
      const loaded = await buildImages(chosen, images, new Map(), fresh);
      const rough = chosen.roughness;
      const settings: MaterialSettings = {
        name: resolveMaterialName(names, folder ?? folderOf(files)),
        files: chosen,
        normalConvention,
        roughnessIsGloss: rough ? classifyMapFile(rough)?.isGloss === true : false,
        tileSizeM: [1, 1],
        heightScaleM: 0.02,
        period: { ...CONTINUOUS },
        allowRotation: false,
        orientation: { baseRotation: 0, rule: 'fixed' },
      };
      const material: LoadedMaterial = { settings, images: loaded };
      const gpuMaterial = uploadMaterial(gpu, material);
      if (mine !== importGen) {
        destroyTextures(gpuMaterial);
        closeAll(fresh);
        return;
      }
      generation++;
      materialRev++;
      destroyTextures(get().gpuMaterial);
      closeAll(bitmaps);
      bitmaps = fresh;
      const { structure: oldStructure, mask: oldMask, substrate: oldSubstrate } = get();
      // A new material starts a new document: its mask and substrate go too, and imports still in flight are dropped.
      maskReplacedGen = ++maskGen;
      substrateReplacedGen = ++substrateGen;
      set({
        sources: images, material, gpuMaterial, doc: createDefaultDoc(settings), importing: false,
        structure: null, structureError: null, mask: null, substrate: null, wearError: null,
      });
      oldStructure?.gpu.destroy();
      oldMask?.texture.destroy();
      if (oldSubstrate) destroyTextures(oldSubstrate.gpu);
      await get().analyze();
    } catch (e) {
      closeAll(fresh);
      if (mine === importGen) {
        set({ importError: e instanceof Error ? e.message : String(e), importing: false });
      }
    }
  },

  setDoc(d) {
    set({ doc: d });
  },

  async updateSettings(patch) {
    const { material, gpu, doc, sources } = get();
    if (!material || !gpu) return;
    materialRev++;
    let settings: MaterialSettings = { ...material.settings, ...patch };
    const reupload =
      patch.files !== undefined ||
      (patch.normalConvention !== undefined && patch.normalConvention !== material.settings.normalConvention);
    const next: Partial<ProjectState> = {
      doc: doc ? withMaterialNode(doc, settings) : doc,
    };
    if (reupload) {
      const mine = ++generation;
      const fresh = new Map<string, ImageBitmap>();
      try {
        const images = await buildImages(settings.files, sources, bitmaps, fresh);
        const loaded: LoadedMaterial = { settings, images };
        const gpuMaterial = uploadMaterial(gpu, loaded);
        if (mine !== generation) {
          destroyTextures(gpuMaterial);
          closeAll(fresh);
          return;
        }
        destroyTextures(get().gpuMaterial);
        for (const [k, b] of fresh) bitmaps.set(k, b);
        // Rebuild on the state after the await, so a concurrent analysis commit (period) is not reverted.
        const now = get();
        settings = { ...(now.material?.settings ?? material.settings), ...patch };
        next.doc = now.doc ? withMaterialNode(now.doc, settings) : now.doc;
        next.material = { settings, images };
        next.gpuMaterial = { ...gpuMaterial, settings };
        next.importError = null;
      } catch (e) {
        closeAll(fresh);
        if (mine === generation) set({ importError: e instanceof Error ? e.message : String(e) });
        return;
      }
    } else {
      next.material = { ...material, settings };
      const gm = get().gpuMaterial;
      next.gpuMaterial = gm ? { ...gm, settings } : gm;
    }
    if (patch.name !== undefined && next.doc) {
      next.doc = withProposedFamily(next.doc, get().structure?.result.type ?? 'continuous', settings.name);
    }
    set(next);
    const images = next.material?.images;
    const tile = material.settings.tileSizeM;
    if (
      images?.height !== material.images.height ||
      images?.baseColor !== material.images.baseColor ||
      settings.tileSizeM[0] !== tile[0] ||
      settings.tileSizeM[1] !== tile[1]
    ) {
      await get().analyze();
    }
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

  async analyze(opts) {
    const mine = ++analyzeGen;
    const startImages = get().material?.images;
    // Let the UI paint before the CPU work; anything committed meanwhile is caught below.
    await new Promise((r) => setTimeout(r, 0));
    const { material, gpu, doc } = get();
    if (mine !== analyzeGen || !material || !gpu || !doc) return;
    // The maps changed while this request waited; that change requests its own analysis.
    if (material.images !== startImages) return;
    const node = structureNode(doc);
    let result: StructureResult;
    let source: StructureState['source'];
    try {
      const input = readGray(material.images);
      if (!input) {
        // Neither height nor albedo left: drop the structure of the removed maps (continuous).
        const old = get().structure;
        let nextDoc = old && node ? updateNodeParams(doc, node.id, { analyzed: false }) : doc;
        nextDoc = withProposedFamily(nextDoc, 'continuous', material.settings.name);
        if (old || nextDoc !== doc) set({ structure: null, doc: nextDoc });
        old?.gpu.destroy();
        return;
      }
      source = input.source;
      const threshold = node?.params.threshold ?? null;
      result = analyzeStructure(input.gray, material.settings.tileSizeM, threshold === null ? undefined : { threshold });
    } catch (e) {
      console.error('structure analysis failed', e);
      set({ structureError: es.structure.failed(e instanceof Error ? e.message : String(e)) });
      return;
    }
    const gpuStructure = uploadStructure(gpu, result);
    let settings = material.settings;
    const p = result.period;
    const cur = settings.period;
    const differs = cur.x !== p.x || cur.y !== p.y || cur.phaseX !== p.phaseX || cur.phaseY !== p.phaseY;
    if (opts?.applyPeriod ? differs || settings.periodUserSet : !settings.periodUserSet && differs) {
      settings = {
        ...settings,
        period: { ...cur, x: p.x, y: p.y, phaseX: p.phaseX, phaseY: p.phaseY },
        periodUserSet: opts?.applyPeriod ? false : settings.periodUserSet,
      };
    }
    let nextDoc = settings === material.settings ? doc : withMaterialNode(doc, settings);
    if (node) nextDoc = updateNodeParams(nextDoc, node.id, { type: result.type, analyzed: true });
    nextDoc = withProposedFamily(nextDoc, result.type, settings.name);
    const prev = get().structure;
    const next: Partial<ProjectState> = {
      structure: { result, gpu: gpuStructure, source },
      structureError: null,
      doc: nextDoc,
    };
    if (settings !== material.settings) {
      next.material = { ...material, settings };
      const gm = get().gpuMaterial;
      next.gpuMaterial = gm ? { ...gm, settings } : gm;
    }
    set(next);
    prev?.gpu.destroy();
  },

  async setStructureThreshold(t) {
    const { doc } = get();
    const node = doc && structureNode(doc);
    if (!doc || !node) return;
    set({ doc: updateNodeParams(doc, node.id, { threshold: t }) });
    await get().analyze();
  },

  async importMask(file) {
    await get().initGpu();
    const { gpu } = get();
    if (!gpu || !get().doc) return;
    const mine = ++maskGen;
    let bmp: ImageBitmap;
    try {
      bmp = await decode(file);
    } catch {
      if (mine === maskGen) set({ wearError: es.material.decodeFailed(file.name) });
      else if (maskGen === maskReplacedGen) set({ wearError: es.wear.maskDiscarded });
      return;
    }
    const doc = get().doc;
    if (mine !== maskGen || !doc) {
      bmp.close();
      if (maskGen === maskReplacedGen) set({ wearError: es.wear.maskDiscarded });
      return;
    }
    const texture = uploadRgba8(gpu, bmp, { srgb: false });
    bmp.close();
    const node = wearNode(doc);
    const prev = get().mask;
    set({
      mask: { name: file.name, texture },
      wearError: null,
      doc: node ? updateNodeParams<'wear'>(doc, node.id, { mask: { ...node.params.mask, enabled: true } }) : doc,
    });
    // A compose in flight bound the old texture before its first await; destroy() waits for that submitted work.
    prev?.texture.destroy();
  },

  clearMask() {
    maskGen++;
    const { mask, doc } = get();
    const node = doc && wearNode(doc);
    set({
      mask: null,
      doc: doc && node ? updateNodeParams<'wear'>(doc, node.id, { mask: { ...node.params.mask, enabled: false } }) : doc,
    });
    mask?.texture.destroy();
  },

  async importSubstrate(files) {
    await get().initGpu();
    const { gpu } = get();
    if (!gpu || !get().doc) return;
    const images = files.filter((f) => IMAGE_EXT.test(f.name));
    const names = images.map((f) => f.name);
    const all = chooseMaps(names).files;
    const chosen: MaterialSettings['files'] = {};
    for (const k of SUBSTRATE_KINDS) if (all[k]) chosen[k] = all[k];
    // Without colour maps there is nothing to reveal; an import in flight is kept.
    if (Object.keys(chosen).length === 0) {
      set({ wearError: es.material.noMaps });
      return;
    }
    const mine = ++substrateGen;
    const fresh = new Map<string, ImageBitmap>();
    try {
      const loaded = await buildImages(chosen, images, new Map(), fresh);
      if (mine !== substrateGen) {
        if (substrateGen === substrateReplacedGen) set({ wearError: es.wear.substrateDiscarded });
        return;
      }
      const rough = chosen.roughness;
      const name = resolveMaterialName(names, folderOf(files));
      // Re-importing the same set keeps the size the user gave it (R34); a different set starts at 1 m.
      const current = get().substrate;
      const settings: MaterialSettings = {
        name,
        files: chosen,
        normalConvention: 'gl',
        roughnessIsGloss: rough ? classifyMapFile(rough)?.isGloss === true : false,
        tileSizeM: current?.name === name ? current.gpu.settings.tileSizeM : [1, 1],
        heightScaleM: 0.02,
        period: { ...CONTINUOUS },
        allowRotation: false,
        orientation: { baseRotation: 0, rule: 'fixed' },
      };
      const gpuMaterial = uploadMaterial(gpu, { settings, images: loaded });
      const prev = get().substrate;
      set({ substrate: { name: settings.name, gpu: gpuMaterial }, wearError: null });
      if (prev) destroyTextures(prev.gpu);
    } catch (e) {
      if (mine === substrateGen) set({ wearError: e instanceof Error ? e.message : String(e) });
      else if (substrateGen === substrateReplacedGen) set({ wearError: es.wear.substrateDiscarded });
    } finally {
      // The bitmaps were copied into textures at upload; the substrate never re-reads them.
      closeAll(fresh);
    }
  },

  clearSubstrate() {
    substrateGen++;
    const { substrate } = get();
    set({ substrate: null });
    if (substrate) destroyTextures(substrate.gpu);
  },

  setSubstrateTileSize(t) {
    const { substrate } = get();
    if (!substrate || !(t[0] > 0 && t[1] > 0)) return;
    // Same textures, new identities: the subscription recomposes and nothing is destroyed.
    const gpu = { ...substrate.gpu, settings: { ...substrate.gpu.settings, tileSizeM: t } };
    set({ substrate: { ...substrate, gpu } });
  },
}));

function destroyMaps(m: AtlasMaps): void {
  for (const t of [
    m.baseColor, m.normal, m.height, m.macroHeight, m.roughness, m.metallic, m.ao, m.rectId, m.pieceId, m.jointDistM,
    m.loss, m.border, m.wearMask,
  ]) {
    t.destroy();
  }
}

const RECOMPOSE_DEBOUNCE_MS = 150;
let composeTimer: ReturnType<typeof setTimeout> | undefined;

/** Bumped by every compose request; only the latest may apply its result. */
let composeGen = 0;

/** A compose is running; requests made meanwhile set `composeAgain` and run once when it ends (no stacking). */
let composing = false;
let composeAgain = false;

async function runCompose(): Promise<void> {
  if (composing) {
    composeAgain = true;
    return;
  }
  composing = true;
  try {
    await recompose();
  } finally {
    composing = false;
    if (composeAgain) {
      composeAgain = false;
      void runCompose();
    }
  }
}

/** Compose input for the current state at `resolutionPx`: preview, evaluation and export compose the same atlas. */
export function composeInputFor(
  s: Pick<ProjectState, 'structure' | 'mask' | 'substrate'> & { doc: ProjectDoc; gpuMaterial: GpuMaterial },
  inputs: { layout: HotspotLayout; placements: RectPlacement[] },
  resolutionPx: number,
): ComposeInput {
  const { doc, gpuMaterial, structure, mask, substrate } = s;
  return {
    layout: inputs.layout, material: gpuMaterial, placements: inputs.placements, resolutionPx, structure: structure?.gpu,
    wear: wearNode(doc)?.params,
    dirt: dirtNode(doc)?.params,
    mask: mask?.texture,
    substrateMaterial: substrate?.gpu,
    grainAxis: structure?.result.grainAxis ?? null,
  };
}

async function recompose(): Promise<void> {
  const { doc, gpuMaterial, gpu, previewRes, structure, mask, substrate } = useProject.getState();
  const mine = ++composeGen;
  if (!doc || !gpuMaterial || !gpu) return;
  let maps: AtlasMaps | null = null;
  try {
    const { layout, placements, issues } = composeInputsFromDoc(doc);
    const t0 = performance.now();
    // composeAtlas binds every texture (structure, mask, substrate) before its first await, so a later replacement
    // may destroy them.
    maps = await composeAtlas(
      gpu, composeInputFor({ doc, gpuMaterial, structure, mask, substrate }, { layout, placements }, previewRes),
    );
    await gpu.device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - t0;
    if (mine !== composeGen) {
      destroyMaps(maps);
      return;
    }
    const prev = useProject.getState().atlas;
    useProject.setState({
      atlas: {
        maps, doc, gpuMaterial, structure, mask, substrate, layout, placements, issues,
        layoutIssues: validateLayout(layout),
        resolutionPx: previewRes, gpuMs,
      },
      composeError: null,
    });
    if (prev) destroyMaps(prev.maps);
  } catch (e) {
    if (maps) destroyMaps(maps);
    if (mine === composeGen) {
      console.error('recompose failed', e);
      useProject.setState({ composeError: es.mapBar.composeFailed(e instanceof Error ? e.message : String(e)) });
    }
  }
}

useProject.subscribe((s, prev) => {
  if (
    s.doc === prev.doc && s.gpuMaterial === prev.gpuMaterial && s.previewRes === prev.previewRes &&
    s.structure === prev.structure && s.mask === prev.mask && s.substrate === prev.substrate
  ) {
    return;
  }
  clearTimeout(composeTimer);
  composeTimer = setTimeout(() => void runCompose(), RECOMPOSE_DEBOUNCE_MS);
});

/** Resolution of the evaluation composition the checks run on (docs/04-wear.md). */
export const EVAL_RES = 2048;
const EVALUATION_DEBOUNCE_MS = 600;
let evalTimer: ReturnType<typeof setTimeout> | undefined;

/** Bumped by every evaluation request and by every recomposition; only the latest request may store its results. */
let evalGen = 0;

/** Evaluations run one after another on this chain, never concurrently. */
let evalChain: Promise<unknown> = Promise.resolve();

/** Debug counters (exposed by the test harness): evaluation composes, and evaluations running now / at most. */
export const evalStats = { composes: 0, running: 0, peak: 0 };

/** Mean base colour of each second set, read back once. */
const substrateMeans = new WeakMap<GpuMaterial, Promise<[number, number, number]>>();

function substrateMean(gpu: GpuContext, m: GpuMaterial): Promise<[number, number, number]> {
  let p = substrateMeans.get(m);
  if (!p) {
    p = readbackRgba8(gpu, m.textures.baseColor).then((r) => meanRgb(r.data));
    substrateMeans.set(m, p);
    // A failed read is retried by the next evaluation.
    p.catch(() => substrateMeans.delete(m));
  }
  return p;
}

/** Mean joint colour of the top material in material space (R37), per (GpuMaterial, structure). */
const jointMeans = new WeakMap<GpuMaterial, WeakMap<StructureState, [number, number, number] | null>>();

export function materialJointMean(
  m: GpuMaterial, structure: StructureState, bmp: ImageBitmap | undefined,
): [number, number, number] | null {
  let byStructure = jointMeans.get(m);
  if (!byStructure) jointMeans.set(m, (byStructure = new WeakMap()));
  if (byStructure.has(structure)) return byStructure.get(structure)!;
  let mean: [number, number, number] | null = null;
  if (bmp) {
    // The BaseColor at the analysis size, so each texel lines up with the structure's piece ids.
    const { width: w, height: h, pieceId } = structure.result;
    const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('2D canvas unavailable');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    mean = jointMeanRgb(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), pieceId);
  }
  byStructure.set(structure, mean);
  return mean;
}

export interface EvaluationOptions {
  exportResolutionPx?: number;
  force?: boolean;
}

function requestEvaluation(opts?: EvaluationOptions): Promise<CheckResult[] | null> {
  const mine = ++evalGen;
  if (!useProject.getState().checksPending) useProject.setState({ checksPending: true });
  const run = evalChain.then(() => evaluate(mine, opts));
  evalChain = run.catch(() => undefined);
  return run;
}

async function evaluate(mine: number, opts?: EvaluationOptions): Promise<CheckResult[] | null> {
  // A newer request is queued behind this one and will evaluate a fresher state.
  if (mine !== evalGen && !opts?.force) return null;
  const { doc, gpuMaterial, gpu, structure, mask, substrate, atlas, material } = useProject.getState();
  if (!doc || !gpuMaterial || !gpu) {
    if (mine === evalGen) useProject.setState({ checksPending: false });
    return null;
  }
  evalStats.running++;
  evalStats.peak = Math.max(evalStats.peak, evalStats.running);
  try {
    const inputs = composeInputsFromDoc(doc);
    const current =
      atlas !== null && atlas.resolutionPx === EVAL_RES && atlas.doc === doc && atlas.gpuMaterial === gpuMaterial &&
      atlas.structure === structure && atlas.mask === mask && atlas.substrate === substrate;
    if (!current) evalStats.composes++;
    const compareSubstrate =
      inputs.wear.substrate.source === 'secondSet' && substrate !== null && structure?.result.type === 'pieces';
    // Before the compose, so a failure cannot leak its maps; a failure only skips the substrate comparison.
    let joints: [number, number, number] | null = null;
    if (compareSubstrate) {
      try {
        joints = materialJointMean(gpuMaterial, structure, material?.images.baseColor);
      } catch (e) {
        console.error('joint colour failed', e);
      }
    }
    const maps = current
      ? atlas.maps
      : await composeAtlas(gpu, composeInputFor({ doc, gpuMaterial, structure, mask, substrate }, inputs, EVAL_RES));
    // Every copy is submitted before the first await, so the maps may be destroyed (ours right below, the preview's
    // by a recomposition) while the reads are in flight.
    let reads;
    try {
      reads = Promise.all([
        readbackR32(gpu, maps.rectId),
        readbackR32(gpu, maps.macroHeight),
        readbackRgba8(gpu, maps.normal),
        readbackRgba8(gpu, maps.wearMask),
        joints && compareSubstrate ? substrateMean(gpu, substrate.gpu) : null,
      ]);
    } finally {
      if (!current) destroyMaps(maps);
    }
    const [rectId, macro, normal, wearRgba, subMean] = await reads;
    const { width, height } = rectId;
    // The grey wearMask's red channel; a 1 × 1 placeholder (wear off) stays 1 byte long.
    const wearMask = new Uint8Array(wearRgba.data.length / 4);
    for (let i = 0; i < wearMask.length; i++) wearMask[i] = wearRgba.data[i * 4];
    const maps8 = {
      width, height, rectId: rectId.data as Uint32Array, wearMask, macroHeight: macro.data as Float32Array,
      normal: normal.data,
    };
    const output = doc.nodes.find((n): n is DocNode<'output'> => n.type === 'output');
    const results = runChecks({
      layout: inputs.layout, rotations: inputs.rotations, material: inputs.material, wear: inputs.wear,
      exportResolutionPx: opts?.exportResolutionPx ?? output?.params.resolutionPx ?? EVAL_RES,
      maps: maps8,
      substrateMeanRgb: joints && subMean ? subMean : undefined,
      jointMeanRgb: joints && subMean ? joints : undefined,
    });
    if (mine === evalGen) {
      useProject.setState({ checks: { results, width, height }, checksError: null, checksPending: false });
    }
    return results;
  } catch (e) {
    console.error('evaluation failed', e);
    if (mine === evalGen) {
      useProject.setState({
        checksError: es.checks.failed(e instanceof Error ? e.message : String(e)), checksPending: false,
      });
    }
    return null;
  } finally {
    evalStats.running--;
  }
}

useProject.subscribe((s, prev) => {
  if (s.atlas === prev.atlas || !s.atlas) return;
  // An evaluation in flight describes an older atlas: its results are not stored.
  evalGen++;
  if (!s.checksPending) useProject.setState({ checksPending: true });
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => void requestEvaluation(), EVALUATION_DEBOUNCE_MS);
});
