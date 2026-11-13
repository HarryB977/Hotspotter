export class WebGpuUnavailableError extends Error {
  constructor(message = 'WebGPU is not available in this browser') {
    super(message);
    this.name = 'WebGpuUnavailableError';
  }
}

export interface GpuContext {
  device: GPUDevice;
  adapterInfo: string;
}

export async function initGpu(): Promise<GpuContext> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGpuUnavailableError();
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new WebGpuUnavailableError('No WebGPU adapter found');
  // Headroom: at 8192 the largest buffer is a 4 B/px map's staging (256 MiB, the default limit; the rgba16float scratch
  // is cleared by a render pass, R39). Ask for what the adapter offers (2 GiB on an RTX 3060).
  const device = await adapter.requestDevice({
    requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize },
  });
  const info = adapter.info;
  const adapterInfo = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return { device, adapterInfo };
}
