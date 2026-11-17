import type { MaterialType } from '../structure/analyze';

export type WearFamily = 'brittle' | 'chipping' | 'splinter' | 'erosion' | 'dent' | 'edgeOnly';

export interface FamilyShape {
  /** 0 fBm … 1 Voronoi. */
  cellMix: number;
  /** ≥ 1, stretch along the grain. */
  anisotropy: number;
  /** 0 smooth, n depth levels. */
  steps: number;
  /** Reveals the substrate. */
  loses: boolean;
  /** Edge polish strength. */
  polish: number;
}

export const WEAR_FAMILIES: Record<WearFamily, FamilyShape> = {
  brittle: { cellMix: 1, anisotropy: 1, steps: 0, loses: true, polish: 0.2 },
  chipping: { cellMix: 0.6, anisotropy: 1, steps: 2, loses: true, polish: 0.1 },
  splinter: { cellMix: 1, anisotropy: 4, steps: 0, loses: true, polish: 0.1 },
  erosion: { cellMix: 0, anisotropy: 1, steps: 0, loses: true, polish: 0 },
  dent: { cellMix: 0.3, anisotropy: 1, steps: 0, loses: false, polish: 0.6 },
  edgeOnly: { cellMix: 0, anisotropy: 1, steps: 0, loses: false, polish: 1 },
};

export interface WearParams {
  /** Section switch ("Activar"): off composes without wear (1 × 1 wear maps, no wear block in hotspot.json). */
  enabled: boolean;
  family: WearFamily;
  /** True once the user picks a family; proposeFamily never overrides it. */
  userSetFamily?: boolean;
  /** True once the user edits widthM, sizeM or intensity; proposeWearSize never overrides them. */
  userSetWearSize?: boolean;
  intensity: number;
  widthM: number;
  minEdgeM: number;
  sizeM: number;
  depthM: number;
  bandM: number;
  microM: number;
  pieceBias: number;
  seed: number;
  edgeTone: number;
  mask: { enabled: boolean; strength: number; invert: boolean };
  substrate: { source: 'interior' | 'secondSet'; hueShift: number; satMul: number; valMul: number; roughAdd: number };
}

export interface DirtParams {
  /** Section switch ("Activar"): off composes without dirt (no cavity dirt, no runoff). */
  enabled: boolean;
  cavity: number;
  runoff: number;
  runoffLengthM: number;
  tint: [number, number, number];
}

export const DEFAULT_WEAR: WearParams = {
  enabled: true,
  family: 'brittle',
  userSetWearSize: false,
  intensity: 0.5,
  widthM: 0.04,
  minEdgeM: 0.004,
  sizeM: 0.03,
  depthM: 0.006,
  bandM: 0.006,
  microM: 0.0005,
  pieceBias: 0.7,
  seed: 0,
  edgeTone: 0.3,
  mask: { enabled: false, strength: 1, invert: false },
  substrate: { source: 'interior', hueShift: 0, satMul: 0.7, valMul: 0.8, roughAdd: 0.2 },
};

export const DEFAULT_DIRT: DirtParams = {
  enabled: true, cavity: 0.4, runoff: 0, runoffLengthM: 0.4, tint: [0.25, 0.22, 0.18],
};

export function proposeFamily(t: MaterialType, materialName: string): WearFamily {
  if (t === 'pieces') return 'brittle';
  if (t === 'directional') return 'splinter';
  if (/metal|steel|iron|alumin/i.test(materialName)) return 'dent';
  if (/paint|pintur/i.test(materialName)) return 'chipping';
  return 'erosion';
}

/**
 * Proposal from the median piece size (decision 86). The reach is where the damage potential falls to zero, so the
 * typical break is far shorter: a reach of one piece gives breaks of about a third of a piece at the corners.
 */
const REACH_PER_LONG = 1.0;
const BREAK_PER_SHORT = 1.5;
const PIECES_INTENSITY = 0.75;

/**
 * Wear reach (`widthM`), break size (`sizeM`) and intensity proposed from the median piece size. Without pieces,
 * the fixed defaults.
 */
export function proposeWearSize(
  piece: { longM: number; shortM: number } | null,
): { widthM: number; sizeM: number; intensity: number } {
  if (!piece) return { widthM: DEFAULT_WEAR.widthM, sizeM: DEFAULT_WEAR.sizeM, intensity: DEFAULT_WEAR.intensity };
  return { widthM: REACH_PER_LONG * piece.longM, sizeM: BREAK_PER_SHORT * piece.shortM, intensity: PIECES_INTENSITY };
}
