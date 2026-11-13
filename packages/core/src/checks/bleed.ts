import type { CheckContext, CheckResult } from './index';

/** Groove floor width (export px) below which mip 2 (a quarter of the resolution) loses it. */
export const MIN_GROOVE_PX = 4;

const fmt = (v: number, digits = 1) => v.toLocaleString('es-ES', { maximumFractionDigits: digits });

/** Bleed: the flat groove floor must be at least 4 px wide at the export resolution, or it vanishes in mip 2. */
export function checkBleed(ctx: CheckContext): CheckResult {
  const { layout, exportResolutionPx } = ctx;
  const floorPx = (layout.groove.widthM * exportResolutionPx) / layout.worldWidthM;
  const base = { id: 'bleed' as const, rectIds: [] as string[] };
  if (floorPx >= MIN_GROOVE_PX) {
    return { ...base, status: 'ok', message: `La ranura mide ${fmt(floorPx)} px al exportar: se ve también en mip 2.` };
  }
  const neededMm = ((MIN_GROOVE_PX * layout.worldWidthM) / exportResolutionPx) * 1000;
  return {
    ...base, status: 'warn',
    message: `La ranura mide ${fmt(floorPx)} px a ${exportResolutionPx} px: la ranura desaparece en mip 2 y los ` +
      `rectángulos se mezclan de lejos. Ensánchala a ${fmt(neededMm)} mm o exporta a más resolución.`,
  };
}
