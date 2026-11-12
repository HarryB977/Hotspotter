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
  family: WearFamily;
  /** True once the user picks a family; proposeFamily never overrides it. */
  userSetFamily?: boolean;
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
  cavity: number;
  runoff: number;
  runoffLengthM: number;
  tint: [number, number, number];
}

export const DEFAULT_WEAR: WearParams = {
  family: 'brittle',
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

export const DEFAULT_DIRT: DirtParams = { cavity: 0.4, runoff: 0.3, runoffLengthM: 0.4, tint: [0.25, 0.22, 0.18] };

export function proposeFamily(t: MaterialType, materialName: string): WearFamily {
  if (t === 'pieces') return 'brittle';
  if (t === 'directional') return 'splinter';
  if (/metal|steel|iron|alumin/i.test(materialName)) return 'dent';
  if (/paint|pintur/i.test(materialName)) return 'chipping';
  return 'erosion';
}
