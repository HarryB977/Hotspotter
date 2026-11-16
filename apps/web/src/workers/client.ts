import type { GrayImage, StructureResult } from '@hotspotter/core';
import { es } from '../i18n/es';

/** Operations the shared Worker runs: plain typed arrays in and out, never GPU resources. */
export interface WorkerApi {
  analyze: {
    in: { gray: GrayImage; tileSizeM: [number, number]; threshold?: number };
    out: StructureResult;
  };
}

export type WorkerOp = keyof WorkerApi;

export type WorkerRequest = {
  [K in WorkerOp]: {
    id: number;
    op: K;
    input: WorkerApi[K]['in'];
    /** Test hook (dev only): the Worker throws uncaught instead of running the op, as if it had crashed. */
    crash?: boolean;
  };
}[WorkerOp];

export type WorkerReply =
  | { id: number; ok: true; out: WorkerApi[WorkerOp]['out'] }
  | { id: number; ok: false; message: string };

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
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.out as never);
    else p.reject(new Error(e.data.message));
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

/**
 * Runs `op` on the shared Worker (created on first use). `transfer` lists buffers of `input` the caller no
 * longer needs; they move instead of being copied.
 */
export function workerCall<K extends WorkerOp>(
  op: K, input: WorkerApi[K]['in'], transfer: Transferable[] = [],
): Promise<WorkerApi[K]['out']> {
  const w = getWorker();
  const id = ++nextId;
  const crashNow = crashNext.delete(op);
  return new Promise<WorkerApi[K]['out']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (out: never) => void, reject });
    const req = { id, op, input, crash: crashNow || undefined } as WorkerRequest;
    try {
      w.postMessage(req, transfer);
    } catch (e) {
      pending.delete(id);
      throw e;
    }
  });
}

/** Test hook: the next `op` call crashes the Worker. */
export function failNextWorkerCall(op: WorkerOp): void {
  crashNext.add(op);
}
