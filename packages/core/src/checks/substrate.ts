import type { CheckContext, CheckResult } from './index';

type Rgb = [number, number, number];

/** ΔE76 above which the second set does not match the joints of the top material. */
export const MAX_DELTA_E = 20;

/** sRGB bytes → CIE Lab (D65 white), through linear sRGB and XYZ. */
function lab([r, g, b]: Rgb): Rgb {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const X = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const Y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const Z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference between two sRGB byte colours. */
export function deltaE76(a: Rgb, b: Rgb): number {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Mean RGB (bytes, as stored) of RGBA8 pixels. */
export function meanRgb(rgba: Uint8Array): Rgb {
  let r = 0, g = 0, b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
  }
  return n > 0 ? [r / n, g / n, b / n] : [0, 0, 0];
}

/**
 * Mean RGB of the top material's joints in material space (R37): its BaseColor (RGBA8, already at the structure
 * analysis size) where the structure's piece id is 0. Null without joint pixels.
 */
export function jointMeanRgb(baseColor: Uint8Array, pieceId: Uint32Array): Rgb | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < pieceId.length; i++) {
    if (pieceId[i] !== 0) continue;
    r += baseColor[i * 4];
    g += baseColor[i * 4 + 1];
    b += baseColor[i * 4 + 2];
    n++;
  }
  return n > 0 ? [r / n, g / n, b / n] : null;
}

/**
 * Substrate: with a second PBR set over a material with pieces, its mean colour must be close (ΔE76 ≤ 20) to the
 * mean colour of the top material's own joints. The store passes both means only in that case.
 */
export function checkSubstrate(ctx: CheckContext): CheckResult {
  const base = { id: 'substrate' as const, rectIds: [] as string[] };
  if (!ctx.wear.enabled) {
    return { ...base, status: 'ok', message: 'El desgaste está desactivado: no queda nada al descubierto.' };
  }
  if (ctx.wear.substrate.source !== 'secondSet') {
    return { ...base, status: 'ok', message: 'Lo que queda debajo sale del propio material.' };
  }
  const { substrateMeanRgb: s, jointMeanRgb: j } = ctx;
  if (!s || !j) {
    return {
      ...base, status: 'ok',
      message: 'No hay nada que comparar: falta el segundo material o el material no tiene piezas ni juntas.',
    };
  }
  const d = deltaE76(s, j);
  const de = Math.round(d);
  if (d > MAX_DELTA_E) {
    return {
      ...base, status: 'warn',
      message: `El sustrato no se parece a las juntas (diferencia de color ${de}, máximo ${MAX_DELTA_E}): lo que ` +
        'asoma al romperse no casa con el material. Elige otro segundo material o usa el interior.',
    };
  }
  return { ...base, status: 'ok', message: `El sustrato casa con el color de las juntas (diferencia ${de}).` };
}
