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
  // The default 256 MiB maxBufferSize is too small at 8192: Dawn's lazy clear of an 8192² rgba16float texture stages
  // 512 MiB and loses the device. Ask for what the adapter offers (2 GiB on an RTX 3060).
  const device = await adapter.requestDevice({
    requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize },
  });
  const info = adapter.info;
  const adapterInfo = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return { device, adapterInfo };
}
