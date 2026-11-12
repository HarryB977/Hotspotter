import type { MaterialOrientation } from './orientation';
import type { MaterialPeriod } from './period';

export type MapKind = 'baseColor' | 'normal' | 'height' | 'roughness' | 'metallic' | 'ao' | 'opacity';

export interface MapMatch {
  kind: MapKind;
  normalConvention?: 'gl' | 'dx';
  isGloss?: boolean;
}

export interface MaterialSettings {
  name: string;
  files: Partial<Record<MapKind, string>>;
  normalConvention: 'gl' | 'dx';
  roughnessIsGloss: boolean;
  tileSizeM: [number, number];
  heightScaleM: number; // default 0.02
  period: MaterialPeriod;
  allowRotation: boolean;
  orientation: MaterialOrientation;
  /** True once the user edits the period; the structure analysis then stops proposing one. */
  periodUserSet?: boolean;
}

/**
 * Values used when a map is missing. Scalars are linear 0..1; `normal` is the
 * encoded flat normal (RGB 0..1), i.e. (0.5, 0.5, 1).
 */
export const MAP_DEFAULTS: Record<Exclude<MapKind, 'baseColor'>, number | [number, number, number]> = {
  height: 0.5,
  normal: [0.5, 0.5, 1],
  roughness: 0.5,
  metallic: 0,
  ao: 1,
  opacity: 1,
};

interface Pattern {
  /** Matches the map suffix (including its leading separator) at the end of the stem. */
  re: RegExp;
  match: (m: RegExpMatchArray) => MapMatch;
}

const SEP = '(?:^|[_. -])';
const PATTERNS: Pattern[] = [
  { re: new RegExp(`${SEP}normal(?:[_. -]?(gl|dx))?$`, 'i'),
    match: (m) => (m[1] ? { kind: 'normal', normalConvention: m[1].toLowerCase() as 'gl' | 'dx' } : { kind: 'normal' }) },
  { re: new RegExp(`${SEP}(?:base[_. -]?color|color|albedo|diffuse)$`, 'i'), match: () => ({ kind: 'baseColor' }) },
  { re: new RegExp(`${SEP}(?:ambient[_. -]?occlusion|ao)$`, 'i'), match: () => ({ kind: 'ao' }) },
  { re: new RegExp(`${SEP}(?:height|displacement|disp)$`, 'i'), match: () => ({ kind: 'height' }) },
  { re: new RegExp(`${SEP}(?:roughness|rough)$`, 'i'), match: () => ({ kind: 'roughness' }) },
  { re: new RegExp(`${SEP}(?:gloss|glossiness|smoothness)$`, 'i'), match: () => ({ kind: 'roughness', isGloss: true }) },
  { re: new RegExp(`${SEP}(?:metallic|metalness)$`, 'i'), match: () => ({ kind: 'metallic' }) },
  { re: new RegExp(`${SEP}(?:opacity|alpha)$`, 'i'), match: () => ({ kind: 'opacity' }) },
];

/** Filename without extension and without a trailing resolution tag like `_1k`. */
function stem(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '').replace(/_\d+k$/i, '');
}

function classifyStem(s: string): { match: MapMatch; prefix: string } | null {
  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (m) return { match: p.match(m), prefix: s.slice(0, m.index) };
  }
  return null;
}

export function classifyMapFile(filename: string): MapMatch | null {
  return classifyStem(stem(filename))?.match ?? null;
}

/** Common prefix of the recognised map files, minus map suffix and resolution tag. */
export function materialNameFromFiles(filenames: string[]): string {
  const prefixes = filenames
    .map((f) => classifyStem(stem(f))?.prefix)
    .filter((p): p is string => p !== undefined);
  if (prefixes.length === 0) return '';
  let common = prefixes[0];
  for (const p of prefixes) {
    let i = 0;
    while (i < common.length && i < p.length && common[i] === p[i]) i++;
    common = common.slice(0, i);
  }
  return common.replace(/[_. -]+$/, '');
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Makes a material name safe as an export file prefix: drops path separators, `:<>"|?*` and control
 * characters, trims spaces and trailing dots, and suffixes Windows device names (CON → CON_).
 */
export function sanitizeMaterialName(name: string): string {
  const s = name.replace(/[\\/:<>"|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
  return RESERVED_DEVICE.test(s) ? `${s}_` : s;
}

/** Name from the file prefix, else the folder name, else 'material'; always sanitized. */
export function resolveMaterialName(filenames: string[], folder?: string): string {
  return sanitizeMaterialName(materialNameFromFiles(filenames)) || sanitizeMaterialName(folder ?? '') || 'material';
}

/** Lower is better: explicit gl, then unspecified, then dx. */
const normalRank = (c?: 'gl' | 'dx'): number => (c === 'gl' ? 0 : c === undefined ? 1 : 2);

export function chooseMaps(filenames: string[]): {
  files: MaterialSettings['files'];
  normalConvention: 'gl' | 'dx';
} {
  const files: MaterialSettings['files'] = {};
  const best = new Map<MapKind, { rank: number; file: string }>();
  let normalConvention: 'gl' | 'dx' = 'gl';
  for (const f of filenames) {
    const m = classifyMapFile(f);
    if (!m) continue;
    // Prefer true roughness over gloss, and gl over dx; otherwise first file wins.
    const rank = m.kind === 'normal' ? normalRank(m.normalConvention) : m.isGloss ? 1 : 0;
    const cur = best.get(m.kind);
    if (!cur || rank < cur.rank) {
      best.set(m.kind, { rank, file: f });
      files[m.kind] = f;
      if (m.kind === 'normal') normalConvention = m.normalConvention ?? 'gl';
    }
  }
  return { files, normalConvention };
}
