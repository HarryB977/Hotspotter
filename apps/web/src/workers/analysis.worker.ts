import { analyzeStructure, runChecks } from '@hotspotter/core';
import type { WorkerApi, WorkerOp, WorkerReply, WorkerRequest } from './client';

type Handlers = {
  [K in WorkerOp]: (input: WorkerApi[K]['in']) => { out: WorkerApi[K]['out']; transfer: Transferable[] };
};

const handlers: Handlers = {
  analyze({ gray, tileSizeM, threshold }) {
    const out = analyzeStructure(gray, tileSizeM, threshold === undefined ? undefined : { threshold });
    return { out, transfer: [out.pieceId.buffer, out.jointDistM.buffer] };
  },
  checks(ctx) {
    return { out: runChecks(ctx), transfer: [] };
  },
};

/** Requests waiting to run, and the newest opted-in (`supersede`) request id seen per op. */
const queue: WorkerRequest[] = [];
const newest = new Map<WorkerOp, number>();
let draining = false;
/** Test hook (dev only): set by a simulated crash; a crashed Worker runs nothing more. */
let dead = false;

function run(req: WorkerRequest): void {
  let reply: WorkerReply;
  let transfer: Transferable[] = [];
  if (req.supersede && req.id < (newest.get(req.op) ?? 0)) {
    reply = { id: req.id, ok: false, stale: true };
  } else {
    try {
      const handler = handlers[req.op] as (input: WorkerRequest['input']) => ReturnType<Handlers[WorkerOp]>;
      const r = handler(req.input);
      reply = { id: req.id, ok: true, out: r.out };
      transfer = r.transfer;
    } catch (err) {
      reply = { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  self.postMessage(reply, { transfer });
}

/** Runs one request per task, so messages that arrived during a long run are seen before the next one starts. */
function drain(): void {
  const req = dead ? undefined : queue.shift();
  if (!req) {
    draining = false;
    return;
  }
  run(req);
  setTimeout(drain, 0);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (dead) return;
  if (import.meta.env.DEV && req.crash) {
    dead = true;
    throw new Error(`simulated worker crash (${req.op})`);
  }
  if (req.supersede) newest.set(req.op, Math.max(req.id, newest.get(req.op) ?? 0));
  queue.push(req);
  if (!draining) {
    draining = true;
    setTimeout(drain, 0);
  }
};
