import { DEFAULT_GROOVE } from './layout';
import type { GrooveSettings, HotspotLayout } from './layout';
import { presetLayout } from './presets';
import type { PresetId } from './presets';
import { autoLayout } from './autoLayout';
import type { AutoTarget } from './autoLayout';
import type { MaterialSettings } from './material';
import { placeMaterial } from './placement';
import type { RectPlacement } from './placement';
import { checkProportions } from './period';
import { DEFAULT_ORIENTATION } from './orientation';
import type { ProportionIssue } from './period';
import type { MaterialType } from './structure/analyze';
import { DEFAULT_WEAR, DEFAULT_DIRT, WEAR_FAMILIES } from './wear/params';
import type { WearParams, DirtParams } from './wear/params';

export type NodeType = 'material' | 'structure' | 'layout' | 'placement' | 'wear' | 'dirt' | 'output';

export interface NodeParams {
  material: MaterialSettings;
  structure: { type: MaterialType; threshold: number | null; analyzed: boolean };
  wear: WearParams;
  dirt: DirtParams;
  layout: { mode: 'preset'; preset: PresetId } | { mode: 'auto'; target: AutoTarget; seed: number };
  placement: { variation: number; seed: number };
  output: { resolutionPx: number; worldWidthM: number; groove: GrooveSettings };
}

export interface DocNode<T extends NodeType = NodeType> { id: string; type: T; params: NodeParams[T] }
export interface DocEdge { from: string; to: string; port: string }
export interface ProjectDoc { version: 1; nodes: DocNode[]; edges: DocEdge[] }
export interface StackEntry { nodeId: string; type: NodeType; label: string }

export class DocParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocParseError';
  }
}

const defaultStructure = (): NodeParams['structure'] => ({ type: 'continuous', threshold: null, analyzed: false });
const defaultWear = (): WearParams => ({
  ...DEFAULT_WEAR, mask: { ...DEFAULT_WEAR.mask }, substrate: { ...DEFAULT_WEAR.substrate },
});
const defaultDirt = (): DirtParams => ({ ...DEFAULT_DIRT, tint: [...DEFAULT_DIRT.tint] });

export function createDefaultDoc(material: MaterialSettings): ProjectDoc {
  return {
    version: 1,
    nodes: [
      { id: 'material', type: 'material', params: material },
      { id: 'structure', type: 'structure', params: defaultStructure() },
      { id: 'layout', type: 'layout', params: { mode: 'preset', preset: 'walls' } },
      { id: 'placement', type: 'placement', params: { variation: 0.5, seed: 0 } },
      { id: 'wear', type: 'wear', params: defaultWear() },
      { id: 'dirt', type: 'dirt', params: defaultDirt() },
      { id: 'output', type: 'output', params: { resolutionPx: 4096, worldWidthM: 8, groove: { ...DEFAULT_GROOVE } } },
    ],
    edges: [
      { from: 'material', to: 'structure', port: 'material' },
      { from: 'structure', to: 'layout', port: 'period' },
      { from: 'layout', to: 'placement', port: 'layout' },
      { from: 'placement', to: 'wear', port: 'placement' },
      { from: 'wear', to: 'dirt', port: 'wear' },
      { from: 'dirt', to: 'output', port: 'dirt' },
    ],
  };
}

export function serializeDoc(d: ProjectDoc): string {
  return JSON.stringify(d);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDoc(s: string): ProjectDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    throw new DocParseError('Invalid JSON');
  }
  if (!isObj(raw) || raw.version !== 1) throw new DocParseError('Unsupported document version');
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new DocParseError('Missing nodes or edges');
  const ids = new Set<string>();
  for (const n of raw.nodes) {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string' || !isObj(n.params)) {
      throw new DocParseError('Malformed node');
    }
    ids.add(n.id);
  }
  for (const e of raw.edges) {
    if (!isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.port !== 'string') {
      throw new DocParseError('Malformed edge');
    }
    if (!ids.has(e.from) || !ids.has(e.to)) throw new DocParseError('Edge references unknown node');
  }
  for (const n of raw.nodes as Array<{ type: string; params: Record<string, unknown> }>) {
    if (n.type === 'material' && !isObj(n.params.orientation)) n.params.orientation = { ...DEFAULT_ORIENTATION };
    // Documents saved before bevelM existed bevelled widthM / 2.
    const g = n.type === 'output' ? n.params.groove : undefined;
    if (isObj(g) && typeof g.bevelM !== 'number' && typeof g.widthM === 'number') g.bevelM = g.widthM / 2;
  }
  migrateV01A(raw as unknown as ProjectDoc);
  return raw as unknown as ProjectDoc;
}

const STRUCTURE_TYPES: MaterialType[] = ['pieces', 'continuous', 'directional'];

function mergeObj<T extends object>(defaults: T, v: unknown): T {
  return { ...defaults, ...(isObj(v) ? v : {}) } as T;
}

/** Fills missing fields of structure/wear/dirt nodes from the defaults (deep for mask, substrate). */
function normalizeNodes(d: ProjectDoc): void {
  for (const n of d.nodes as Array<{ type: string; params: Record<string, unknown> }>) {
    if (n.type === 'structure') {
      const p = mergeObj(defaultStructure(), n.params);
      if (!STRUCTURE_TYPES.includes(p.type)) p.type = 'continuous';
      n.params = p as unknown as Record<string, unknown>;
    } else if (n.type === 'wear') {
      const w = defaultWear();
      const p = mergeObj(w, n.params);
      p.mask = mergeObj(w.mask, n.params.mask);
      p.substrate = mergeObj(w.substrate, n.params.substrate);
      if (!Object.prototype.hasOwnProperty.call(WEAR_FAMILIES, p.family)) p.family = 'brittle';
      if (typeof p.enabled !== 'boolean') p.enabled = true;
      n.params = p as unknown as Record<string, unknown>;
    } else if (n.type === 'dirt') {
      const p = mergeObj(defaultDirt(), n.params);
      const t = (n.params as { tint?: unknown }).tint;
      if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === 'number')) p.tint = [...DEFAULT_DIRT.tint];
      if (typeof p.enabled !== 'boolean') p.enabled = true;
      n.params = p as unknown as Record<string, unknown>;
    }
  }
}

function uniqueId(d: ProjectDoc, base: string): string {
  const taken = new Set(d.nodes.map((n) => n.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

/** Inserts `node` into the edge `from → to`, keeping that edge's port name on both new links. */
function spliceInto(d: ProjectDoc, from: DocNode | undefined, to: DocNode | undefined, node: DocNode): void {
  const i = from && to ? d.edges.findIndex((e) => e.from === from.id && e.to === to.id) : -1;
  if (!from || !to || i < 0) {
    throw new DocParseError(`Cannot insert ${node.type} node: no edge between the ${from?.type ?? '?'} and ${to?.type ?? '?'} nodes`);
  }
  const port = d.edges[i].port;
  node.id = uniqueId(d, node.id);
  d.nodes.splice(d.nodes.indexOf(to), 0, node);
  d.edges.splice(i, 1, { from: from.id, to: node.id, port }, { from: node.id, to: to.id, port });
}

/** v0.1-A documents lack structure, wear and dirt: insert each missing node on its chain edge. */
function migrateV01A(d: ProjectDoc): void {
  normalizeNodes(d);
  const first = (t: NodeType) => d.nodes.find((n) => n.type === t);
  if (!first('structure')) {
    spliceInto(d, first('material'), first('layout'), { id: 'structure', type: 'structure', params: defaultStructure() });
  }
  if (!first('wear')) {
    const target = first('dirt') ?? first('output');
    spliceInto(d, first('placement'), target, { id: 'wear', type: 'wear', params: defaultWear() });
  }
  if (!first('dirt')) {
    spliceInto(d, first('wear'), first('output'), { id: 'dirt', type: 'dirt', params: defaultDirt() });
  }
}

const LABELS: Record<NodeType, string> = {
  material: 'Material', structure: 'Estructura', layout: 'Layout', placement: 'Colocación',
  wear: 'Desgaste', dirt: 'Suciedad', output: 'Salida',
};

/** Linear chain → ordered entries; any branching or off-chain node → `{ custom: true }`. */
export function toStack(d: ProjectDoc): StackEntry[] | { custom: true } {
  const custom = { custom: true as const };
  if (d.nodes.length === 0) return custom;
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const e of d.edges) {
    if (next.has(e.from) || hasIncoming.has(e.to)) return custom;
    next.set(e.from, e.to);
    hasIncoming.add(e.to);
  }
  const starts = d.nodes.filter((n) => !hasIncoming.has(n.id));
  if (starts.length !== 1) return custom;
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const out: StackEntry[] = [];
  let cur: string | undefined = starts[0].id;
  while (cur !== undefined && out.length <= d.nodes.length) {
    const n = byId.get(cur);
    if (!n) return custom;
    out.push({ nodeId: n.id, type: n.type, label: LABELS[n.type] ?? n.type });
    cur = next.get(cur);
  }
  return out.length === d.nodes.length ? out : custom;
}

function findNode<T extends NodeType>(d: ProjectDoc, type: T): DocNode<T> {
  const n = d.nodes.find((x) => x.type === type);
  if (!n) throw new Error(`Document has no ${type} node`);
  return n as DocNode<T>;
}

/** Resolves the layout at the output resolution, or at `opts.widthPx` when given. */
export function resolveLayout(d: ProjectDoc, opts?: { widthPx?: number }): HotspotLayout {
  const material = findNode(d, 'material').params;
  const layout = findNode(d, 'layout').params;
  const output = findNode(d, 'output').params;
  const widthPx = opts?.widthPx ?? output.resolutionPx;
  const { worldWidthM } = output;
  const base = layout.mode === 'preset'
    ? presetLayout(layout.preset, widthPx, worldWidthM)
    : autoLayout({ target: layout.target, widthPx, worldWidthM, period: material.period, seed: layout.seed, orientation: material.orientation });
  return { ...base, groove: { ...output.groove } };
}

export interface ComposeInputs {
  layout: HotspotLayout;
  placements: RectPlacement[];
  material: MaterialSettings;
  issues: ProportionIssue[];
  rotations: Map<string, boolean>;
  structure: NodeParams['structure'];
  wear: WearParams;
  dirt: DirtParams;
}

/** Layout, placements and proportion checks for composing `d`, shared by preview and export. */
export function composeInputsFromDoc(d: ProjectDoc, widthPx?: number): ComposeInputs {
  const layout = resolveLayout(d, { widthPx });
  const material = findNode(d, 'material').params;
  const pl = findNode(d, 'placement').params;
  const placements = placeMaterial(layout, material.period, {
    variation: pl.variation,
    seed: pl.seed,
    materialAllowsRotation: material.allowRotation,
    tileSizeM: material.tileSizeM,
    orientation: material.orientation,
  });
  const rotations = new Map(placements.map((x) => [x.rectId, x.rotate90]));
  const structure = findNode(d, 'structure').params;
  const wear = findNode(d, 'wear').params;
  const dirt = findNode(d, 'dirt').params;
  return { layout, placements, material, rotations, structure, wear, dirt, issues: checkProportions(layout, material.period, rotations) };
}

export function updateNodeParams<T extends NodeType>(
  d: ProjectDoc,
  id: string,
  params: Partial<NodeParams[T]>,
): ProjectDoc {
  return {
    ...d,
    nodes: d.nodes.map((n) => (n.id === id ? ({ ...n, params: { ...n.params, ...params } } as DocNode) : n)),
  };
}
