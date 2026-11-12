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
  const device = await adapter.requestDevice();
  const info = adapter.info;
  const adapterInfo = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
  return { device, adapterInfo };
}
