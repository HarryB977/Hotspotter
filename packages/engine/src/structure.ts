import type { StructureResult } from '@hotspotter/core';
import type { GpuContext } from './gpu';

/** Material-space structure maps (row 0 = image top), read with textureLoad at the nearest texel. */
export interface GpuStructure {
  /** r32uint: 0 = joint, ≥ 1 piece. */
  pieceId: GPUTexture;
  /** r32float: metres to the nearest joint. */
  jointDistM: GPUTexture;
  /** The material has joints; without them pieceId / jointDistM carry no information for the wear. */
  hasPieces: boolean;
  destroy(): void;
}

const USAGE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;

function create(
  ctx: GpuContext, w: number, h: number, pieceId: Uint32Array, jointDistM: Float32Array, hasPieces: boolean,
): GpuStructure {
  const { device } = ctx;
  const make = (format: GPUTextureFormat, data: Uint32Array | Float32Array) => {
    const texture = device.createTexture({ size: [w, h], format, usage: USAGE });
    device.queue.writeTexture({ texture }, data, { bytesPerRow: w * 4 }, [w, h]);
    return texture;
  };
  const ids = make('r32uint', pieceId);
  const dist = make('r32float', jointDistM);
  return {
    pieceId: ids,
    jointDistM: dist,
    hasPieces,
    destroy() {
      ids.destroy();
      dist.destroy();
    },
  };
}

export function uploadStructure(ctx: GpuContext, r: StructureResult): GpuStructure {
  return create(ctx, r.width, r.height, r.pieceId, r.jointDistM, r.jointFraction > 0);
}

/** 1×1 structure for unanalysed materials: one piece everywhere, 1 m from any joint (continuous). */
export function continuousStructure(ctx: GpuContext): GpuStructure {
  return create(ctx, 1, 1, new Uint32Array([1]), new Float32Array([1]), false);
}
