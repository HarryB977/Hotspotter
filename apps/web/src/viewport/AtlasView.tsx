import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rectSizeM } from '@hotspotter/core';
import type { HotspotLayout, ProportionIssue } from '@hotspotter/core';
import { heightToRgba8 } from '@hotspotter/engine';
import type { AtlasMaps } from '@hotspotter/engine';
import { useProject } from '../state/store';
import type { ActiveMap } from '../state/store';

export interface AtlasViewProps {
  maps: AtlasMaps | null;
  layout: HotspotLayout;
  activeMap: ActiveMap;
  issues: ProportionIssue[];
}

const VERTEX = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VsOut;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}
`;

const COLOR_FS = /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(tex, smp, uv, 0.0).rgb, 1.0);
}
`;

// Same hash and byte mapping as rectIdRgb in @hotspotter/core (the exported _RectID map); keep them in sync.
const ID_FS = /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<u32>;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let id = textureLoad(tex, vec2<i32>(uv * vec2<f32>(textureDimensions(tex))), 0).r;
  if (id == 0u) { return vec4<f32>(vec3<f32>(13.0 / 255.0), 1.0); }
  var h = id * 2654435761u;
  h = h ^ (h >> 15u);
  h = h * 2246822519u;
  h = h ^ (h >> 13u);
  let b = vec3<u32>(h & 255u, (h >> 8u) & 255u, (h >> 16u) & 255u);
  return vec4<f32>(vec3<f32>(64u + ((b * 166u) >> vec3<u32>(8u))) / 255.0, 1.0);
}
`;

interface Blitter {
  device: GPUDevice;
  format: GPUTextureFormat;
  color: GPURenderPipeline;
  id: GPURenderPipeline;
  sampler: GPUSampler;
}

function createBlitter(device: GPUDevice): Blitter {
  const format = navigator.gpu.getPreferredCanvasFormat();
  const make = (fs: string) => {
    const module = device.createShaderModule({ code: VERTEX + fs });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  };
  return {
    device,
    format,
    color: make(COLOR_FS),
    id: make(ID_FS),
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
  };
}

interface View { k: number; tx: number; ty: number }

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 40;
/** Zoom a check focus brings the view to, at least. */
const FOCUS_ZOOM = 4;

export function AtlasView({ maps, layout, activeMap, issues }: AtlasViewProps) {
  const gpu = useProject((s) => s.gpu);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const blitter = useRef<Blitter | null>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The stage is the atlas fitted into the host; zoom and pan are one transform on top of it.
  const aspect = layout.heightPx / layout.widthPx;
  const fit = Math.min(box.w, box.h / aspect) * 0.94;
  const stageW = Math.max(0, fit);
  const stageH = stageW * aspect;

  useEffect(() => {
    setView({ k: 1, tx: (box.w - stageW) / 2, ty: (box.h - stageH) / 2 });
    // Re-centre only when the fitted size changes, not on every zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.w, box.h, layout.widthPx, layout.heightPx]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const v = viewRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)));
      const f = k / v.k;
      setView({ k, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Centre a requested point (atlas UV), zooming in to at least FOCUS_ZOOM.
  const focus = useProject((s) => s.viewFocus);
  useEffect(() => {
    if (!focus) return;
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(v.k, FOCUS_ZOOM));
      return { k, tx: box.w / 2 - focus.u * stageW * k, ty: box.h / 2 - focus.v * stageH * k };
    });
    // Only a new request moves the view; resizes keep it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !gpu || !maps) return;
    if (!blitter.current || blitter.current.device !== gpu.device) {
      blitter.current = createBlitter(gpu.device);
      ctxRef.current = null;
    }
    const b = blitter.current;
    if (cv.width !== maps.baseColor.width || cv.height !== maps.baseColor.height) {
      cv.width = maps.baseColor.width;
      cv.height = maps.baseColor.height;
      ctxRef.current = null;
    }
    if (!ctxRef.current) {
      const c = cv.getContext('webgpu');
      if (!c) return;
      c.configure({ device: b.device, format: b.format, alphaMode: 'opaque' });
      ctxRef.current = c;
    }
    let temp: GPUTexture | null = null;
    let pipeline = b.color;
    let source: GPUTexture;
    const isId = activeMap === 'rectId' || activeMap === 'pieceId';
    if (isId) {
      // Pieces use the same hash colouring as rect ids.
      pipeline = b.id;
      source = maps[activeMap];
    } else if (activeMap === 'height') {
      temp = heightToRgba8(gpu, maps);
      source = temp;
    } else if (activeMap === 'opacity') {
      return;
    } else {
      source = maps[activeMap];
    }
    const bindGroup = b.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries:
        isId
          ? [{ binding: 0, resource: source.createView() }]
          : [{ binding: 0, resource: source.createView() }, { binding: 1, resource: b.sampler }],
    });
    const encoder = b.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctxRef.current.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 1],
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    b.device.queue.submit([encoder.finish()]);
    temp?.destroy();
  }, [maps, activeMap, gpu]);

  const issueIds = useMemo(() => new Set(issues.map((i) => i.rectId)), [issues]);
  const screenPerPx = (stageW * view.k) / layout.widthPx;
  const fontUnits = screenPerPx > 0 ? 10 / screenPerPx : 0;

  return (
    <div
      ref={host}
      className="relative min-h-0 flex-1 overflow-hidden"
      data-testid="atlas-view"
      onPointerDown={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        drag.current = { x: e.clientX, y: e.clientY };
        setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        data-testid="atlas-stage"
        style={{
          width: stageW,
          height: stageH,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
        }}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" data-testid="atlas-canvas" />
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${layout.widthPx} ${layout.heightPx}`}
          data-testid="atlas-overlay"
        >
          {layout.rects.map((r) => {
            const bad = issueIds.has(r.id);
            const size = rectSizeM(layout, r);
            const showLabel = r.w * screenPerPx > 44 && r.h * screenPerPx > 14;
            return (
              <g key={r.id}>
                <rect
                  data-rect-id={r.id}
                  data-issue={bad ? 'true' : undefined}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="none"
                  stroke={bad ? '#f59e0b' : 'rgba(255,255,255,0.45)'}
                  strokeWidth={bad ? 2 : 1}
                  vectorEffect="non-scaling-stroke"
                />
                {showLabel && (
                  <text
                    x={r.x + 3 / screenPerPx}
                    y={r.y + 12 / screenPerPx}
                    fontSize={fontUnits}
                    fill={bad ? '#fbbf24' : '#e4e4e7'}
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 2 / screenPerPx }}
                  >
                    {`${size.w.toFixed(2)} × ${size.h.toFixed(2)} m`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
