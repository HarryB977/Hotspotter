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
import type { ProportionIssue } from './period';

export type NodeType = 'material' | 'layout' | 'placement' | 'output';

export interface NodeParams {
  material: MaterialSettings;
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

export function createDefaultDoc(material: MaterialSettings): ProjectDoc {
  return {
    version: 1,
    nodes: [
      { id: 'material', type: 'material', params: material },
      { id: 'layout', type: 'layout', params: { mode: 'preset', preset: 'walls' } },
      { id: 'placement', type: 'placement', params: { variation: 0.5, seed: 0 } },
      { id: 'output', type: 'output', params: { resolutionPx: 4096, worldWidthM: 8, groove: { ...DEFAULT_GROOVE } } },
    ],
    edges: [
      { from: 'material', to: 'layout', port: 'period' },
      { from: 'layout', to: 'placement', port: 'layout' },
      { from: 'placement', to: 'output', port: 'placement' },
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
  // Documents saved before bevelM existed bevelled widthM / 2.
  for (const n of raw.nodes as Array<{ type: string; params: Record<string, unknown> }>) {
    const g = n.type === 'output' ? n.params.groove : undefined;
    if (isObj(g) && typeof g.bevelM !== 'number' && typeof g.widthM === 'number') g.bevelM = g.widthM / 2;
  }
  return raw as unknown as ProjectDoc;
}

const LABELS: Record<NodeType, string> = {
  material: 'Material', layout: 'Layout', placement: 'Colocación', output: 'Salida',
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
    : autoLayout({ target: layout.target, widthPx, worldWidthM, period: material.period, seed: layout.seed });
  return { ...base, groove: { ...output.groove } };
}

export interface ComposeInputs {
  layout: HotspotLayout;
  placements: RectPlacement[];
  material: MaterialSettings;
  issues: ProportionIssue[];
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
  });
  return { layout, placements, material, issues: checkProportions(layout, material.period) };
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
