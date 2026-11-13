import type { CheckContext, CheckResult } from './index';

/** Visible groove width (export px) below which mip 2 (a quarter of the resolution) loses it. */
export const MIN_GROOVE_PX = 4;

const fmt = (v: number, digits = 1) => v.toLocaleString('es-ES', { maximumFractionDigits: digits });

/**
 * Bleed (R35): the visible groove (flat floor plus the bevel on both sides) must be at least 4 px wide at the export
 * resolution, or it vanishes in mip 2.
 */
export function checkBleed(ctx: CheckContext): CheckResult {
  const { layout, exportResolutionPx } = ctx;
  const { widthM, bevelM } = layout.groove;
  const visibleM = widthM + 2 * bevelM;
  const px = (visibleM * exportResolutionPx) / layout.worldWidthM;
  const base = { id: 'bleed' as const, rectIds: [] as string[] };
  if (px >= MIN_GROOVE_PX) {
    return { ...base, status: 'ok', message: `La ranura mide ${fmt(px)} px al exportar: se ve también en mip 2.` };
  }
  const neededMm = ((MIN_GROOVE_PX * layout.worldWidthM) / exportResolutionPx) * 1000;
  return {
    ...base, status: 'warn',
    message: `La ranura (con su bisel) mide ${fmt(px)} px a ${exportResolutionPx} px: la ranura desaparece en mip 2 ` +
      `y los rectángulos se mezclan de lejos. Ensancha la ranura o el bisel hasta sumar ${fmt(neededMm)} mm, ` +
      'o exporta a más resolución.',
  };
}
