/** Raised when a pipeline (or its shader module) fails validation, e.g. a WGSL error. */
export class PipelineValidationError extends Error {
  constructor(readonly key: string, message: string) {
    super(`Pipeline "${key}": ${message}`);
    this.name = 'PipelineValidationError';
  }
}

interface DeviceCache {
  pipelines: Map<string, unknown>;
  /** Error-scope results of pipelines created since the last checkPipelines. */
  pending: Promise<PipelineValidationError | null>[];
}

const caches = new WeakMap<GPUDevice, DeviceCache>();

function cacheOf(device: GPUDevice): DeviceCache {
  let c = caches.get(device);
  if (!c) caches.set(device, (c = { pipelines: new Map(), pending: [] }));
  return c;
}

/**
 * Returns the pipeline (or any per-device object) cached under `key`, creating it on first use inside a validation
 * error scope, so a WGSL or layout error surfaces through checkPipelines instead of as blank maps. The key must
 * name everything that changes the result (shader, entry point, override constants).
 */
export function cached<T>(device: GPUDevice, key: string, create: () => T): T {
  const c = cacheOf(device);
  if (c.pipelines.has(key)) return c.pipelines.get(key) as T;
  device.pushErrorScope('validation');
  const value = create();
  c.pipelines.set(key, value);
  c.pending.push(device.popErrorScope().then((err) => {
    if (!err) return null;
    // Not cached: the next use creates it again and reports again.
    c.pipelines.delete(key);
    return new PipelineValidationError(key, err.message);
  }));
  return value;
}

/** Throws the first validation error of the pipelines created since the last call. */
export async function checkPipelines(device: GPUDevice): Promise<void> {
  const c = cacheOf(device);
  const pending = c.pending;
  c.pending = [];
  const err = (await Promise.all(pending)).find((e) => e !== null);
  if (err) throw err;
}
