import type { HotspotLayout } from '../layout';
import type { MaterialSettings } from '../material';
import { checkProportions } from '../period';
import type { WearParams } from '../wear/params';
import { checkBleed } from './bleed';
import { checkCoverage } from './coverage';
import { checkIslands } from './islands';
import { checkNormal } from './normal';
import { checkSubstrate } from './substrate';

export { deltaE76, jointMeanRgb, meanRgb } from './substrate';

export type CheckId = 'coverage' | 'islands' | 'normal' | 'proportions' | 'bleed' | 'substrate';
export type CheckStatus = 'ok' | 'warn' | 'error';

export const CHECK_IDS: readonly CheckId[] = ['coverage', 'islands', 'normal', 'proportions', 'bleed', 'substrate'];

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** Plain Spanish for a non-artist. */
  message: string;
  rectIds: string[];
  /** Where to look, in atlas px at the evaluation resolution (continuous coordinates). */
  points?: [number, number][];
}

/** Maps of the evaluation composition, read back from the GPU. Row-major, top-left origin. */
export interface EvalMaps {
  width: number;
  height: number;
  /** Rect index + 1; 0 = groove / empty. */
  rectId: Uint32Array;
  /** One byte per pixel (the grey wearMask); shorter than width · height (1 × 1 placeholder) when the wear is off. */
  wearMask: Uint8Array;
  /** Metres: groove, bevel and wear, without the intact material relief. */
  macroHeight: Float32Array;
  /** Metres: the final height (macro plus the material relief); heightM − macroHeight is the material's own relief. */
  heightM: Float32Array;
  /**
   * One f32 per pixel: the slope |n.xy| / max(n.z, 1e-3) of the material detail normal sampled into atlas space (the
   * compose's matNormal: xyz decoded, GL, rotation applied, unnormalised), before the wear fade. Omitted: flat (0).
   */
  detailSlope?: Float32Array;
  /** RGBA8, GL convention. */
  normal: Uint8Array;
}

export interface CheckContext {
  layout: HotspotLayout;
  rotations: ReadonlyMap<string, boolean>;
  material: MaterialSettings;
  wear: WearParams;
  exportResolutionPx: number;
  maps: EvalMaps;
  /** Mean sRGB bytes of the second set's base colour; only with a second set over a material with pieces. */
  substrateMeanRgb?: [number, number, number];
  /** Mean sRGB bytes of the top material's own joints (jointMeanRgb, material space, R37); same condition. */
  jointMeanRgb?: [number, number, number];
}

function proportions(ctx: CheckContext): CheckResult {
  const { layout, maps } = ctx;
  const issues = checkProportions(layout, ctx.material.period, ctx.rotations);
  const ids = [...new Set(issues.map((i) => i.rectId))];
  if (ids.length === 0) {
    const message = 'Todos los rectángulos respetan el tamaño de las piezas.';
    return { id: 'proportions', status: 'ok', rectIds: [], message };
  }
  const s = maps.width / layout.widthPx;
  const points = ids.map((id): [number, number] => {
    const r = layout.rects.find((x) => x.id === id)!;
    return [(r.x + r.w / 2) * s, (r.y + r.h / 2) * s];
  });
  return {
    id: 'proportions', status: 'warn', rectIds: ids, points,
    message: `${ids.length === 1 ? 'Un rectángulo no mide' : `${ids.length} rectángulos no miden`} un número entero ` +
      'de piezas: alguna queda cortada en el borde. Ajusta su tamaño al periodo del material.',
  };
}

/** Runs every check on an evaluation composition; always returns all six, in CheckId order. */
export function runChecks(ctx: CheckContext): CheckResult[] {
  return [
    checkCoverage(ctx), checkIslands(ctx), checkNormal(ctx), proportions(ctx), checkBleed(ctx), checkSubstrate(ctx),
  ];
}
