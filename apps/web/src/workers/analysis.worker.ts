import { analyzeStructure } from '@hotspotter/core';
import type { WorkerApi, WorkerOp, WorkerReply, WorkerRequest } from './client';

type Handlers = {
  [K in WorkerOp]: (input: WorkerApi[K]['in']) => { out: WorkerApi[K]['out']; transfer: Transferable[] };
};

const handlers: Handlers = {
  analyze({ gray, tileSizeM, threshold }) {
    const out = analyzeStructure(gray, tileSizeM, threshold === undefined ? undefined : { threshold });
    return { out, transfer: [out.pieceId.buffer, out.jointDistM.buffer] };
  },
};

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (import.meta.env.DEV && req.crash) throw new Error(`simulated worker crash (${req.op})`);
  let reply: WorkerReply;
  let transfer: Transferable[] = [];
  try {
    const run = handlers[req.op] as (input: WorkerRequest['input']) => ReturnType<Handlers[WorkerOp]>;
    const r = run(req.input);
    reply = { id: req.id, ok: true, out: r.out };
    transfer = r.transfer;
  } catch (err) {
    reply = { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, { transfer });
};
