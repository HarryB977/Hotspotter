import { create } from 'zustand';
import {
  CONTINUOUS, HspError, chooseMaps, classifyMapFile, composeInputsFromDoc, createDefaultDoc, downsample,
  jointMeanRgb, meanRgb, proposeFamily, resolveMaterialName, toGray, updateNodeParams, validateLayout,
} from '@hotspotter/core';
import type {
  CheckResult, DocNode, GrayImage, HotspotLayout, LayoutIssue, MapKind, MaterialSettings, MaterialType, NodeParams,
  NodeType, ProjectDoc, ProportionIssue, RectPlacement, StructureResult,
} from '@hotspotter/core';
import {
  composeAtlas, hasMapFromFiles, initGpu, readbackDetailSlope, readbackR32, readbackRgba8, uploadMaterial, uploadRgba8, uploadStructure,
  WebGpuUnavailableError,
} from '@hotspotter/engine';
import type { AtlasMaps, ComposeInput, GpuContext, GpuMaterial, GpuStructure, LoadedMaterial } from '@hotspotter/engine';
import { es } from '../i18n/es';
import { WorkerCrashedError, workerCall } from '../workers/client';
import { hspFileName, packHsp, putFile, unpackHsp } from '../project/projectIo';

export type PreviewRes = 512 | 1024 | 2048;
export type ActiveMap = MapKind | 'rectId' | 'pieceId' | 'wearMask';

/** Structure analysis of the current material and its GPU maps. */
export interface StructureState {
  result: StructureResult;
  gpu: GpuStructure;
  /** Map the analysis read: the height, or the albedo (inverted luma) when there is no height. */
  source: 'height' | 'baseColor';
}

/** User B/N wear mask (atlas UV). Its original file is saved in the project (.hsp), not in the document. */
export interface MaskState {
  name: string;
  texture: GPUTexture;
  /** The original image file, saved with the project. */
  files: File[];
}

/**
 * Second PBR set revealed in the loss (wear.substrate.source = 'secondSet'). It has no document of its own; its files
 * and tile size are saved in the project (.hsp) beside the document.
 */
export interface SubstrateState {
  name: string;
  gpu: GpuMaterial;
  /** The original image files, saved with the project. */
  files: File[];
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
  /** No structure analysis is queued or running. */
  analysisIdle: boolean;
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
  /**
   * Where the project was last saved or what it was opened from. `dir` is '' for a project opened from a file: the
   * browser does not expose its folder, so Guardar asks for one.
   */
  projectPath: { dir: string; name: string } | null;
  /** The document, material settings, mask or second set changed since the last save, open or new. */
  dirty: boolean;
  /** A project is being read and built (Abrir). */
  opening: boolean;
  /** Last save or open failure, shown in the top bar; cleared by the next success. */
  projectError: string | null;
  /** Empties the project (no material, document, mask or second set) and forgets its path. */
  newProject(): void;
  /**
   * Writes the project as one `.hsp` (document, original images, mask and second set) to `target`, or to
   * `projectPath`; returns the written path. Waits for a running analysis first. Throws with a Spanish message.
   */
  saveProject(target?: { dir: string; name: string }): Promise<string>;
  /**
   * Opens a `.hsp`: builds everything on the side (images, GPU uploads, structure analysis) and swaps it in at once.
   * On failure the current project is untouched and `projectError` says why.
   */
  openProject(file: File): Promise<void>;
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

/** Analysis requests queued or running (ProjectState.analysisIdle is this being 0). */
let analysesInFlight = 0;

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

/** Bumped by every open and by newProject; only the latest open may swap its project in. */
let openGen = 0;

/** Set while a save, open or new marks the state clean, so the dirty tracker ignores that change. */
let markingClean = false;

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

/** The maps of a second set the colour pass reads, chosen from its file names. */
function substrateMaps(names: string[]): MaterialSettings['files'] {
  const all = chooseMaps(names).files;
  const chosen: MaterialSettings['files'] = {};
  for (const k of SUBSTRATE_KINDS) if (all[k]) chosen[k] = all[k];
  return chosen;
}

function substrateSettings(name: string, files: MaterialSettings['files'], tileSizeM: [number, number]): MaterialSettings {
  const rough = files.roughness;
  return {
    name,
    files,
    normalConvention: 'gl',
    roughnessIsGloss: rough ? classifyMapFile(rough)?.isGloss === true : false,
    tileSizeM,
    heightScaleM: 0.02,
    period: { ...CONTINUOUS },
    allowRotation: false,
    orientation: { baseRotation: 0, rule: 'fixed' },
  };
}

/**
 * Applies a structure analysis to the document and settings: the detected period (unless the user set one, or always
 * with `applyPeriod`), the structure type and the proposed wear family.
 */
function withAnalysis(
  doc: ProjectDoc, settings: MaterialSettings, result: StructureResult, applyPeriod: boolean,
): { doc: ProjectDoc; settings: MaterialSettings } {
  const start = settings;
  const p = result.period;
  const cur = settings.period;
  const differs = cur.x !== p.x || cur.y !== p.y || cur.phaseX !== p.phaseX || cur.phaseY !== p.phaseY;
  if (applyPeriod ? differs || settings.periodUserSet : !settings.periodUserSet && differs) {
    settings = {
      ...settings,
      period: { ...cur, x: p.x, y: p.y, phaseX: p.phaseX, phaseY: p.phaseY },
      periodUserSet: applyPeriod ? false : settings.periodUserSet,
    };
  }
  let next = settings === start ? doc : withMaterialNode(doc, settings);
  const node = structureNode(next);
  if (node) next = updateNodeParams(next, node.id, { type: result.type, analyzed: true });
  return { doc: withProposedFamily(next, result.type, settings.name), settings };
}

/** Grey input of the analysis and the analysis itself, on the Worker; null without height or albedo. */
async function runAnalysis(
  images: LoadedMaterial['images'], tileSizeM: [number, number], threshold: number | null, supersede: boolean,
): Promise<{ result: StructureResult | null; source: StructureState['source'] } | null> {
  const input = readGray(images);
  if (!input) return null;
  const result = await workerCall(
    'analyze',
    { gray: input.gray, tileSizeM, threshold: threshold ?? undefined },
    [input.gray.data.buffer],
    { supersede },
  );
  return { result, source: input.source };
}

function analysisError(e: unknown): string {
  return e instanceof WorkerCrashedError ? e.message : es.structure.failed(e instanceof Error ? e.message : String(e));
}

type StoreSet = (partial: Partial<ProjectState>) => void;

/** A save failure, with its Spanish message. */
export class SaveError extends Error {}

/** An open dropped for a newer open, a new project or a lost device; it reports nothing. */
class OpenSuperseded extends Error {}

/** Commits `partial` as the clean state of a save, open or new: `dirty` false, and the dirty tracker skips it. */
function setClean(set: StoreSet, partial: Partial<ProjectState>): void {
  markingClean = true;
  try {
    set({ ...partial, dirty: false });
  } finally {
    markingClean = false;
  }
}

/** Destroys the GPU resources and bitmaps of a replaced project (the same way a replace import does). */
function destroyProject(
  old: Pick<ProjectState, 'gpuMaterial' | 'structure' | 'mask' | 'substrate'>, oldBitmaps: Map<string, ImageBitmap>,
): void {
  // A compose in flight bound these before its first await; destroy() waits for that submitted work.
  destroyTextures(old.gpuMaterial);
  old.structure?.gpu.destroy();
  old.mask?.texture.destroy();
  if (old.substrate) destroyTextures(old.substrate.gpu);
  closeAll(oldBitmaps);
}

/**
 * Discards every request in flight for the current project: imports, re-uploads, mask and second set imports,
 * compositions and evaluations. `replaced` marks mask and second set imports as dropped by a project change (they say
 * so, like a replace import).
 */
function invalidateInFlight(replaced: boolean): void {
  importGen++;
  generation++;
  materialRev++;
  maskGen++;
  substrateGen++;
  if (replaced) {
    maskReplacedGen = maskGen;
    substrateReplacedGen = substrateGen;
  }
  composeGen++;
  evalGen++;
  clearTimeout(evalTimer);
}

/** The Spanish message of a save or open failure. */
function projectFailure(e: unknown, wrap: (msg: string) => string): string {
  if (e instanceof HspError) return e.message;
  return wrap(e instanceof Error ? e.message : String(e));
}

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
  analysisIdle: true,
  mask: null,
  substrate: null,
  wearError: null,
  checks: null,
  checksError: null,
  checksPending: false,
  viewFocus: null,
  projectPath: null,
  dirty: false,
  opening: false,
  projectError: null,

  focusAtlas(u, v) {
    set({ viewFocus: { u, v, seq: (get().viewFocus?.seq ?? 0) + 1 } });
  },

  newProject() {
    // An open still building is dropped too.
    openGen++;
    invalidateInFlight(false);
    clearTimeout(composeTimer);
    const old = get();
    const oldBitmaps = bitmaps;
    bitmaps = new Map();
    setClean(set, {
      doc: null, material: null, gpuMaterial: null, sources: [], importing: false, importError: null,
      structure: null, structureError: null, mask: null, substrate: null, wearError: null,
      atlas: null, composeError: null, checks: null, checksError: null, checksPending: false, viewFocus: null,
      projectPath: null, projectError: null, opening: false,
    });
    destroyProject(old, oldBitmaps);
    // Evaluation reads of the preview atlas were submitted before their first await.
    if (old.atlas) destroyMaps(old.atlas.maps);
  },

  async saveProject(target) {
    try {
      const path = get().projectPath;
      const to = target ?? (path && path.dir !== '' ? path : null);
      if (!to || to.dir.trim() === '' || to.name.trim() === '') throw new SaveError(es.project.noTarget);
      // The saved document carries the structure of the current maps and settings (R43).
      await whenAnalysisIdle();
      const { doc, material, sources, mask, substrate } = get();
      if (!doc || !material) throw new SaveError(es.project.noProject);
      const name = hspFileName(to.name);
      const bytes = await packHsp({
        doc,
        settings: material.settings,
        materialFiles: sources,
        mask: mask ? { name: mask.name, file: mask.files[0] } : null,
        substrate: substrate
          ? { name: substrate.name, tileSizeM: substrate.gpu.settings.tileSizeM, files: substrate.files }
          : null,
      });
      const written = await putFile(to.dir, name, bytes);
      const now = get();
      const next = { projectPath: { dir: to.dir, name }, projectError: null };
      // A change made while the file was being written is not in it: the project stays dirty.
      if (
        now.doc === doc && now.material?.settings === material.settings && now.mask === mask &&
        now.substrate === substrate
      ) {
        setClean(set, next);
      } else {
        set(next);
      }
      return written;
    } catch (e) {
      if (e instanceof SaveError) throw e;
      throw new SaveError(projectFailure(e, es.project.saveFailed));
    }
  },

  async openProject(file) {
    const mine = ++openGen;
    set({ opening: true, projectError: null });
    await get().initGpu();
    const { gpu } = get();
    if (!gpu) {
      if (mine === openGen) set({ opening: false });
      return;
    }
    // Everything is built on the side; the current project is touched only by the swap below.
    const fresh = new Map<string, ImageBitmap>();
    let gpuMaterial: GpuMaterial | null = null;
    let maskTexture: GPUTexture | null = null;
    let substrateGpu: GpuMaterial | null = null;
    let structureGpu: GpuStructure | null = null;
    try {
      const c = await unpackHsp(file);
      const images = await buildImages(c.settings.files, c.materialFiles, new Map(), fresh);
      gpuMaterial = uploadMaterial(gpu, { settings: c.settings, images });

      let mask: MaskState | null = null;
      if (c.mask) {
        let bmp: ImageBitmap;
        try {
          bmp = await decode(c.mask.file);
        } catch {
          throw new Error(es.material.decodeFailed(c.mask.file.name));
        }
        try {
          maskTexture = uploadRgba8(gpu, bmp, { srgb: false });
        } finally {
          bmp.close();
        }
        mask = { name: c.mask.name, texture: maskTexture, files: [c.mask.file] };
      }

      let substrate: SubstrateState | null = null;
      if (c.substrate) {
        const chosen = substrateMaps(c.substrate.files.map((f) => f.name));
        if (Object.keys(chosen).length === 0) throw new HspError(es.project.substrateNoMaps);
        const subFresh = new Map<string, ImageBitmap>();
        try {
          const subImages = await buildImages(chosen, c.substrate.files, new Map(), subFresh);
          const settings = substrateSettings(c.substrate.name, chosen, c.substrate.tileSizeM);
          substrateGpu = uploadMaterial(gpu, { settings, images: subImages });
        } finally {
          // Copied into textures at upload; the second set never re-reads them.
          closeAll(subFresh);
        }
        substrate = { name: c.substrate.name, gpu: substrateGpu, files: c.substrate.files };
      }

      // The analysis re-runs; its threshold and period come from the saved document and settings.
      let doc = c.doc;
      let settings = c.settings;
      let structure: StructureState | null = null;
      let structureError: string | null = null;
      try {
        const analysis = await runAnalysis(
          images, settings.tileSizeM, structureNode(doc)?.params.threshold ?? null, false,
        );
        if (analysis?.result) {
          ({ doc, settings } = withAnalysis(doc, settings, analysis.result, false));
          structureGpu = uploadStructure(gpu, analysis.result);
          structure = { result: analysis.result, gpu: structureGpu, source: analysis.source };
        } else if (!analysis) {
          doc = withProposedFamily(doc, 'continuous', settings.name);
        }
      } catch (e) {
        console.error('structure analysis failed', e);
        structureError = analysisError(e);
      }

      // A newer open or a new project came meanwhile, or the device was lost: drop what was built.
      if (mine !== openGen || get().gpu !== gpu || gpuLostError) throw new OpenSuperseded();

      const old = get();
      const oldBitmaps = bitmaps;
      bitmaps = fresh;
      invalidateInFlight(true);
      setClean(set, {
        doc, material: { settings, images }, gpuMaterial: { ...gpuMaterial, settings }, sources: c.materialFiles,
        importing: false, importError: null, structure, structureError, mask, substrate, wearError: null,
        composeError: null, checks: null, checksError: null, checksPending: false, viewFocus: null,
        projectPath: { dir: '', name: file.name }, projectError: null, opening: false,
      });
      destroyProject(old, oldBitmaps);
    } catch (e) {
      destroyTextures(gpuMaterial);
      maskTexture?.destroy();
      destroyTextures(substrateGpu);
      structureGpu?.destroy();
      closeAll(fresh);
      if (mine !== openGen) return;
      if (e instanceof OpenSuperseded) {
        set({ opening: false });
        return;
      }
      console.error('open project failed', e);
      set({ opening: false, projectError: projectFailure(e, es.project.openFailed) });
    }
  },

  async runEvaluation(opts) {
    if (opts?.force) {
      // The export's evaluation must see the structure of the current maps and settings (R43).
      await whenAnalysisIdle();
      // A forced evaluation covers the debounced one; it would only evaluate the same state again.
      clearTimeout(evalTimer);
    }
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
    if (analysesInFlight++ === 0) set({ analysisIdle: false });
    try {
      const mine = ++analyzeGen;
      const startImages = get().material?.images;
      // Let the UI paint before reading the maps; anything committed meanwhile is caught below.
      await new Promise((r) => setTimeout(r, 0));
      let { material, gpu, doc } = get();
      if (mine !== analyzeGen || !material || !gpu || !doc) return;
      // The maps changed while this request waited; that change requests its own analysis.
      if (material.images !== startImages) return;
      const node = structureNode(doc);
      let analysis: Awaited<ReturnType<typeof runAnalysis>>;
      try {
        analysis = await runAnalysis(material.images, material.settings.tileSizeM, node?.params.threshold ?? null, true);
        if (!analysis) {
          // Neither height nor albedo left: drop the structure of the removed maps (continuous).
          const old = get().structure;
          let nextDoc = old && node ? updateNodeParams(doc, node.id, { analyzed: false }) : doc;
          nextDoc = withProposedFamily(nextDoc, 'continuous', material.settings.name);
          if (old || nextDoc !== doc) set({ structure: null, doc: nextDoc });
          old?.gpu.destroy();
          return;
        }
        // Superseded by a newer analysis before the Worker started it.
        if (!analysis.result) return;
      } catch (e) {
        if (mine !== analyzeGen) return;
        console.error('structure analysis failed', e);
        set({ structureError: analysisError(e) });
        return;
      }
      const { result, source } = analysis;
      // Commit on the state after the Worker returned; a newer request or new maps make this result stale.
      ({ material, gpu, doc } = get());
      if (mine !== analyzeGen || !material || !gpu || !doc || material.images !== startImages) return;
      const gpuStructure = uploadStructure(gpu, result);
      const { doc: nextDoc, settings } = withAnalysis(doc, material.settings, result, opts?.applyPeriod === true);
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
    } finally {
      if (--analysesInFlight === 0) set({ analysisIdle: true });
    }
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
      mask: { name: file.name, texture, files: [file] },
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
    const chosen = substrateMaps(names);
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
      const name = resolveMaterialName(names, folderOf(files));
      // Re-importing the same set keeps the size the user gave it (R34); a different set starts at 1 m.
      const current = get().substrate;
      const settings = substrateSettings(name, chosen, current?.name === name ? current.gpu.settings.tileSizeM : [1, 1]);
      const gpuMaterial = uploadMaterial(gpu, { settings, images: loaded });
      const prev = get().substrate;
      set({ substrate: { name: settings.name, gpu: gpuMaterial, files: images }, wearError: null });
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
    m.loss, m.border, m.wearMask, ...(m.matNormal ? [m.matNormal] : []),
  ]) {
    t.destroy();
  }
}

/** Resolves once no structure analysis is queued or running (R43: the export waits for it). */
export function whenAnalysisIdle(): Promise<void> {
  if (useProject.getState().analysisIdle) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useProject.subscribe((s) => {
      if (!s.analysisIdle) return;
      unsubscribe();
      resolve();
    });
  });
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
  // A section switched off ("Activar") composes as if its node were absent (v0.1-A output for wear).
  const wear = wearNode(doc)?.params;
  const dirt = dirtNode(doc)?.params;
  return {
    layout: inputs.layout, material: gpuMaterial, placements: inputs.placements, resolutionPx, structure: structure?.gpu,
    wear: wear?.enabled ? wear : undefined,
    dirt: dirt?.enabled ? dirt : undefined,
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
    // A preview at EVAL_RES keeps matNormal so it can stand in for the evaluation (R41 normal check).
    maps = await composeAtlas(gpu, {
      ...composeInputFor({ doc, gpuMaterial, structure, mask, substrate }, { layout, placements }, previewRes),
      keepMatNormal: previewRes === EVAL_RES,
    });
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

/**
 * Debug counters (exposed by the test harness): evaluation composes, evaluations running now / at most, and the
 * staging bytes of the last detail-normal slope read.
 */
export const evalStats = { composes: 0, running: 0, peak: 0, detailBytes: 0 };

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
      inputs.wear.enabled && inputs.wear.substrate.source === 'secondSet' && substrate !== null &&
      structure?.result.type === 'pieces';
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
      : await composeAtlas(gpu, {
        ...composeInputFor({ doc, gpuMaterial, structure, mask, substrate }, inputs, EVAL_RES), keepMatNormal: true,
      });
    // Every copy is submitted before the first await, so the maps may be destroyed (ours right below, the preview's
    // by a recomposition) while the reads are in flight.
    let reads;
    try {
      reads = Promise.all([
        readbackR32(gpu, maps.rectId),
        readbackR32(gpu, maps.macroHeight),
        readbackR32(gpu, maps.height),
        maps.matNormal
          ? readbackDetailSlope(gpu, maps.matNormal)
          : Promise.reject(new Error('evaluation maps lack matNormal')),
        readbackRgba8(gpu, maps.normal),
        readbackRgba8(gpu, maps.wearMask),
        joints && compareSubstrate ? substrateMean(gpu, substrate.gpu) : null,
      ]);
    } finally {
      if (!current) destroyMaps(maps);
    }
    const [rectId, macro, total, detail, normal, wearRgba, subMean] = await reads;
    // One f32 per pixel, unpadded: the data is exactly the staging buffer.
    evalStats.detailBytes = detail.data.byteLength;
    const { width, height } = rectId;
    // The grey wearMask's red channel; a 1 × 1 placeholder (wear off) stays 1 byte long.
    const wearMask = new Uint8Array(wearRgba.data.length / 4);
    for (let i = 0; i < wearMask.length; i++) wearMask[i] = wearRgba.data[i * 4];
    const maps8 = {
      width, height, rectId: rectId.data as Uint32Array, wearMask, macroHeight: macro.data as Float32Array,
      heightM: total.data as Float32Array, detailSlope: detail.data,
      normal: normal.data,
    };
    const output = doc.nodes.find((n): n is DocNode<'output'> => n.type === 'output');
    // Every map moves to the Worker; none is read here afterwards.
    const transfer = new Set<ArrayBuffer>();
    for (const a of [maps8.rectId, maps8.wearMask, maps8.macroHeight, maps8.heightM, maps8.detailSlope, maps8.normal]) {
      transfer.add(a.buffer as ArrayBuffer);
    }
    const results = await workerCall('checks', {
      layout: inputs.layout, rotations: inputs.rotations, material: inputs.material, wear: inputs.wear,
      exportResolutionPx: opts?.exportResolutionPx ?? output?.params.resolutionPx ?? EVAL_RES,
      maps: maps8,
      substrateMeanRgb: joints && subMean ? subMean : undefined,
      jointMeanRgb: joints && subMean ? joints : undefined,
    }, [...transfer], { supersede: !opts?.force });
    // Skipped for a newer preview evaluation (never a forced one): that one stores its results.
    if (!results) return null;
    if (mine === evalGen) {
      useProject.setState({ checks: { results, width, height }, checksError: null, checksPending: false });
    }
    return results;
  } catch (e) {
    console.error('evaluation failed', e);
    if (mine === evalGen) {
      useProject.setState({
        checksError: e instanceof WorkerCrashedError
          ? e.message
          : es.checks.failed(e instanceof Error ? e.message : String(e)),
        checksPending: false,
      });
    }
    return null;
  } finally {
    evalStats.running--;
  }
}

// Any change to what a project file holds makes the project dirty, except the commits of save, open and new.
useProject.subscribe((s, prev) => {
  if (markingClean || s.dirty) return;
  if (
    s.doc !== prev.doc || s.material?.settings !== prev.material?.settings || s.mask !== prev.mask ||
    s.substrate !== prev.substrate
  ) {
    useProject.setState({ dirty: true });
  }
});

useProject.subscribe((s, prev) => {
  if (s.atlas === prev.atlas || !s.atlas) return;
  // An evaluation in flight describes an older atlas: its results are not stored.
  evalGen++;
  if (!s.checksPending) useProject.setState({ checksPending: true });
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => void requestEvaluation(), EVALUATION_DEBOUNCE_MS);
});
