import type { CheckContext, CheckResult, GrayImage, StructureResult } from '@hotspotter/core';
import { es } from '../i18n/es';

/** Operations the shared Worker runs: plain typed arrays in and out, never GPU resources. */
export interface WorkerApi {
  analyze: {
    in: { gray: GrayImage; tileSizeM: [number, number]; threshold?: number };
    out: StructureResult;
  };
  /** The maps' typed arrays are transferred by the caller. */
  checks: {
    in: CheckContext;
    out: CheckResult[];
  };
}

export type WorkerOp = keyof WorkerApi;

export type WorkerRequest = {
  [K in WorkerOp]: {
    /** Increases with every call, so it is also the request's generation: a higher id of the same op is newer. */
    id: number;
    op: K;
    input: WorkerApi[K]['in'];
    /** Opted in to being skipped while queued when a newer opted-in request of the same op arrives. */
    supersede?: boolean;
    /** Test hook (dev only): the Worker throws uncaught on receipt, as if it had crashed. */
    crash?: boolean;
  };
}[WorkerOp];

export type WorkerReply =
  | { id: number; ok: true; out: WorkerApi[WorkerOp]['out'] }
  | { id: number; ok: false; message: string }
  /** Skipped: a newer opted-in request of the same op was queued behind it. */
  | { id: number; ok: false; stale: true };

/** The Worker died or could not read a message; every pending call fails with this and the next call starts a new one. */
export class WorkerCrashedError extends Error {
  constructor() {
    super(es.worker.crashed);
    this.name = 'WorkerCrashedError';
  }
}

interface Pending {
  resolve: (out: never) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();
const crashNext = new Set<WorkerOp>();

function crash(w: Worker): void {
  if (worker !== w) return;
  worker = null;
  w.terminate();
  const calls = [...pending.values()];
  pending.clear();
  for (const p of calls) p.reject(new WorkerCrashedError());
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.out as never);
    else if ('stale' in r) p.resolve(null as never);
    else p.reject(new Error(r.message));
  };
  w.onerror = (e) => {
    // Reported once here instead of as an uncaught page error.
    e.preventDefault();
    console.error('worker crashed', e.message);
    crash(w);
  };
  w.onmessageerror = () => {
    console.error('worker message could not be deserialised');
    crash(w);
  };
  worker = w;
  return w;
}

export interface WorkerCallOptions {
  /**
   * Skip this call (resolve null) if a newer call of the same op with this flag arrives before the Worker starts it.
   * Calls without it always run, and never skip anything.
   */
  supersede?: boolean;
}

/**
 * Runs `op` on the shared Worker (created on first use). `transfer` lists buffers of `input` the caller no
 * longer needs; they move instead of being copied. Resolves null only for a `supersede` call that a newer one
 * replaced before the Worker started it.
 */
export function workerCall<K extends WorkerOp>(
  op: K, input: WorkerApi[K]['in'], transfer: Transferable[] = [], opts: WorkerCallOptions = {},
): Promise<WorkerApi[K]['out'] | null> {
  return new Promise<WorkerApi[K]['out'] | null>((resolve, reject) => {
    const w = getWorker();
    const id = ++nextId;
    const crashNow = import.meta.env.DEV && crashNext.delete(op);
    pending.set(id, { resolve: resolve as (out: never) => void, reject });
    const req = {
      id, op, input, supersede: opts.supersede || undefined, crash: crashNow || undefined,
    } as WorkerRequest;
    try {
      w.postMessage(req, transfer);
    } catch (e) {
      pending.delete(id);
      throw e;
    }
  });
}

/** Test hook (dev only): the next `op` call crashes the Worker. */
export function failNextWorkerCall(op: WorkerOp): void {
  if (import.meta.env.DEV) crashNext.add(op);
}
