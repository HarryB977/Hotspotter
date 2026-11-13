/**
 * Raised when a pipeline (or its shader module) fails validation, e.g. a WGSL error. The UI shows the message as is,
 * so it leads with a Spanish sentence; the WebGPU detail after it stays in English.
 */
export class PipelineValidationError extends Error {
  constructor(readonly key: string, message: string) {
    super(`Error interno de un shader ("${key}"): ${message}`);
    this.name = 'PipelineValidationError';
  }
}

/** Resolves to the validation error of one cache entry's creation, or null. Never rejects. */
export type PipelineReady = Promise<PipelineValidationError | null>;

interface Entry {
  value: unknown;
  ready: PipelineReady;
}

const caches = new WeakMap<GPUDevice, Map<string, Entry>>();

/**
 * The lists of the trackPipelines calls in progress, innermost last. Global, so the window between trackPipelines()
 * and its stop function must stay free of awaits: any compose that runs during an await would push its pipelines into
 * this caller's list (and the caller's validation would wait on, or throw, the other compose's errors).
 */
const tracking: PipelineReady[][] = [];

function cacheOf(device: GPUDevice): Map<string, Entry> {
  let c = caches.get(device);
  if (!c) caches.set(device, (c = new Map()));
  return c;
}

/**
 * Returns the pipeline (or any per-device object) cached under `key` and the result of its validation, creating it on
 * first use inside a validation error scope, so a WGSL or layout error surfaces through `ready` instead of as blank
 * maps. Every use, cached or not, reports the entry's `ready` to the trackPipelines calls in progress. The key must
 * name everything that changes the result (shader, entry point, override constants).
 */
export function cachedEntry<T>(device: GPUDevice, key: string, create: () => T): { value: T; ready: PipelineReady } {
  const c = cacheOf(device);
  let entry = c.get(key);
  if (!entry) {
    device.pushErrorScope('validation');
    let value: T;
    try {
      value = create();
    } catch (e) {
      void device.popErrorScope();
      throw e;
    }
    const created: Entry = {
      value,
      ready: device.popErrorScope().then((err) => {
        if (!err) return null;
        // Not kept: the next use creates it again and reports again.
        if (c.get(key) === created) c.delete(key);
        return new PipelineValidationError(key, err.message);
      }),
    };
    c.set(key, created);
    entry = created;
  }
  for (const list of tracking) list.push(entry.ready);
  return entry as { value: T; ready: PipelineReady };
}

/** cachedEntry's value; its validation is awaited by whoever tracks this use (trackPipelines). */
export function cached<T>(device: GPUDevice, key: string, create: () => T): T {
  return cachedEntry(device, key, create).value;
}

/**
 * Starts collecting the `ready` of every cached entry used from now on; the returned function stops and returns them.
 * Synchronous code only: an await in between would collect another caller's pipelines.
 */
export function trackPipelines(): () => PipelineReady[] {
  const list: PipelineReady[] = [];
  tracking.push(list);
  return () => {
    const i = tracking.lastIndexOf(list);
    if (i >= 0) tracking.splice(i, 1);
    return list;
  };
}

/** Throws the first validation error among `readies`. */
export async function pipelinesReady(readies: PipelineReady[]): Promise<void> {
  const err = (await Promise.all(readies)).find((e) => e !== null);
  if (err) throw err;
}

/** Throws the first validation error among the entries cached on `device` now (a failed entry is then dropped). */
export async function checkPipelines(device: GPUDevice): Promise<void> {
  await pipelinesReady([...cacheOf(device).values()].map((e) => e.ready));
}
