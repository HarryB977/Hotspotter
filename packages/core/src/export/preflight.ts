/** The device limits an export depends on (a subset of GPUSupportedLimits). */
export interface ExportGpuLimits {
  maxBufferSize: number;
  maxTextureDimension2D: number;
}

export type ExportPreflight =
  | { ok: true; outW: number; outH: number; bufferBytes: number }
  | { ok: false; reason: 'buffer' | 'texture'; outW: number; outH: number; bufferBytes: number; limit: number };

/**
 * Whether an export at `resolutionPx` fits the device (R39). The output is resolutionPx wide and keeps the layout's
 * aspect (the same rounding as composeAtlas). The largest single buffer it needs is the staging of one
 * 4-byte-per-texel map, rows padded to 256 bytes: each readback, and Dawn's lazy clear of a texture that is not a
 * render attachment. The 8-byte rgba16float scratch is cleared by a render pass and stages nothing.
 */
export function exportPreflight(
  layout: { widthPx: number; heightPx: number }, resolutionPx: number, limits: ExportGpuLimits,
): ExportPreflight {
  const outW = resolutionPx;
  const outH = Math.round((layout.heightPx * resolutionPx) / layout.widthPx);
  const bufferBytes = Math.ceil((outW * 4) / 256) * 256 * outH;
  if (Math.max(outW, outH) > limits.maxTextureDimension2D) {
    return { ok: false, reason: 'texture', outW, outH, bufferBytes, limit: limits.maxTextureDimension2D };
  }
  if (bufferBytes > limits.maxBufferSize) {
    return { ok: false, reason: 'buffer', outW, outH, bufferBytes, limit: limits.maxBufferSize };
  }
  return { ok: true, outW, outH, bufferBytes };
}
