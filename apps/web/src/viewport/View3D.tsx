import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Focus } from 'lucide-react';
import { SHAPE_PARTS, buildShape, fitFaces } from '@hotspotter/core';
import type { DocNode, HotspotFit, ShapeFace, ShapePart, TestShape } from '@hotspotter/core';
import { es } from '../i18n/es';
import {
  VIEW3D_MODES, VIEW3D_SHAPES, runoffOf, useProject,
} from '../state/store';
import type { AtlasResult, View3dMode } from '../state/store';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { NumField } from '../panels/MaterialPanel';
import { mapLabel } from './mapLabel';
import { View3DScene, view3dDebug } from './three/scene';
import { disposeAtlasTextures, loadAtlasTextures, setPointFilter } from './three/atlasTextures';
import type { AtlasTextureSet } from './three/atlasTextures';

const t = es.viewport;

function modeLabel(m: View3dMode): string {
  return m === 'lit' || m === 'rects' ? t.modes[m] : mapLabel(m);
}

/**
 * Fits the shape's faces to the atlas the textures were read from, as the export's engine would see its layout
 * (no vertical mirror with runoff), each face seeded from the wear seed and its index.
 */
function fitShape(atlas: AtlasResult, shape: TestShape): { faces: ShapeFace[]; fits: HotspotFit[] } {
  const faces = buildShape(shape);
  const rotations = new Map(atlas.placements.map((p) => [p.rectId, p.rotate90]));
  const seed = atlas.doc.nodes.find((n): n is DocNode<'wear'> => n.type === 'wear')?.params.seed ?? 0;
  const runoff = runoffOf(atlas.doc);
  return { faces, fits: fitFaces(faces, atlas.layout, rotations, { seed, runoff }) };
}

/**
 * The "Partes" dropdown: one checkbox per part of the current shape (SHAPE_PARTS order) saying whether it gets the
 * hotspot texture. Closes on a click outside or Escape.
 */
function PartsMenu({ shape, textured, onChange }: {
  shape: TestShape;
  textured: Record<ShapePart, boolean>;
  onChange: (textured: Record<ShapePart, boolean>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        className="flex h-6 items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-1.5 text-sm text-zinc-100 focus-visible:border-accent focus-visible:outline-none"
        aria-haspopup="true"
        aria-expanded={open}
        title={t.partsHint}
        onClick={() => setOpen((o) => !o)}
        data-testid="view3d-parts"
      >
        {t.parts}
      </button>
      {open && (
        <div
          role="group"
          aria-label={t.parts}
          className="absolute left-0 top-full z-40 mt-1 min-w-[8rem] rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-lg"
          data-testid="view3d-parts-menu"
        >
          {SHAPE_PARTS[shape].map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
              <input
                type="checkbox"
                className="accent-accent"
                checked={textured[p]}
                onChange={(e) => onChange({ ...textured, [p]: e.target.checked })}
                data-testid={`view3d-part-${p}`}
              />
              {t.partNames[p]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default View3DPane;

/** The 3D view, remountable by the test harness (`view3dDebug.remount`) to check that nothing leaks. */
export function View3DPane() {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const remount = () => setKey((k) => k + 1);
    view3dDebug.remount = remount;
    return () => {
      if (view3dDebug.remount === remount) view3dDebug.remount = null;
    };
  }, []);
  return <View3D key={key} />;
}

/**
 * Test shapes with the hotspot applied as the target engine would (decision 79), lit by a procedural room and one
 * movable light. It reads its atlas back once per composition (decision 80), and only while it is on screen; that
 * atlas is composed at VIEW3D_RES when the preview is lower (decision 88).
 */
function View3D() {
  const gpu = useProject((s) => s.gpu);
  const atlas = useProject((s) => s.view3dAtlas);
  const hasPreview = useProject((s) => s.atlas !== null);
  const setView3dVisible = useProject((s) => s.setView3dVisible);
  const settings = useProject((s) => s.view3d);
  const setView3d = useProject((s) => s.setView3d);
  const { shape, mode, lightAzimuthDeg, lightElevationDeg, pointFilter, textured } = settings;

  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<View3DScene | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  /** The texture set on screen and the atlas it was read from. */
  const current = useRef<{ set: AtlasTextureSet; atlas: AtlasResult } | null>(null);
  /** Sets replaced but maybe still bound: disposed once the scene shows their successor. */
  const retired = useRef<AtlasTextureSet[]>([]);
  /** Bumped by every load and by unmount: only the latest load may install its set. */
  const loadGen = useRef(0);
  const [shown, setShown] = useState<AtlasResult | null>(null);
  const fittedShape = useRef<TestShape | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let scene: View3DScene;
    try {
      scene = new View3DScene(cv);
    } catch (e) {
      setGlError(t.webglFailed(e instanceof Error ? e.message : String(e)));
      return;
    }
    sceneRef.current = scene;
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      scene.setSize(w, h);
      visibleRef.current = w > 0 && h > 0;
      setVisible(visibleRef.current);
      setView3dVisible(visibleRef.current);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => {
      ro.disconnect();
      setView3dVisible(false);
      loadGen.current++;
      // Textures first, while their renderer is still alive to free them.
      for (const s of retired.current) disposeAtlasTextures(s);
      retired.current = [];
      if (current.current) disposeAtlasTextures(current.current.set);
      current.current = null;
      scene.dispose();
      sceneRef.current = null;
      view3dDebug.shownAtlas = null;
    };
  }, [setView3dVisible]);

  // One read per atlas, only while the pane is on screen; a newer atlas, hiding the pane or unmounting supersedes it.
  useEffect(() => {
    if (!sceneRef.current) return;
    // With a preview but no 3D atlas yet (its composition at VIEW3D_RES is pending), the old textures stay up.
    if (!atlas && hasPreview) return;
    if (!atlas) {
      loadGen.current++;
      if (current.current) retired.current.push(current.current.set);
      current.current = null;
      setShown(null);
      return;
    }
    if (!visible || !gpu || current.current?.atlas === atlas) return;
    const mine = ++loadGen.current;
    const isCurrent = () => mine === loadGen.current && visibleRef.current && useProject.getState().view3dAtlas === atlas;
    const scene = sceneRef.current;
    loadAtlasTextures(gpu, atlas.maps, isCurrent).then(
      async (set) => {
        if (!set) return;
        setPointFilter(set, useProject.getState().view3d.pointFilter);
        if (!(await scene.upload(set, isCurrent)) || !isCurrent()) {
          disposeAtlasTextures(set);
          return;
        }
        if (current.current) retired.current.push(current.current.set);
        current.current = { set, atlas };
        setShown(atlas);
      },
      (e) => console.error('3d view textures failed', e),
    );
  }, [atlas, hasPreview, visible, gpu]);

  // The textures and the fitted shape change together, then the replaced textures are freed.
  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    let fitted: { faces: ShapeFace[]; fits: HotspotFit[] } = { faces: [], fits: [] };
    if (shown) {
      try {
        fitted = fitShape(shown, shape);
      } catch (e) {
        console.error('3d view fit failed', e);
      }
    }
    scene.setTextures(current.current?.set ?? null);
    scene.setShape(fitted.faces, fitted.fits, shown?.layout ?? null, useProject.getState().view3d.textured);
    for (const s of retired.current) disposeAtlasTextures(s);
    retired.current = [];
    view3dDebug.shownAtlas = shown;
    if (fitted.faces.length > 0 && fittedShape.current !== shape) {
      fittedShape.current = shape;
      scene.fit(shape);
    }
  }, [shown, shape]);

  useEffect(() => sceneRef.current?.setMode(mode), [mode]);
  useEffect(() => sceneRef.current?.setTextured(textured), [textured]);
  useEffect(() => sceneRef.current?.setLight(lightAzimuthDeg, lightElevationDeg), [lightAzimuthDeg, lightElevationDeg]);
  useEffect(() => {
    if (!current.current) return;
    setPointFilter(current.current.set, pointFilter);
    sceneRef.current?.texturesChanged();
  }, [pointFilter, shown]);
  useEffect(() => {
    if (mode !== 'rects') setHover(null);
  }, [mode]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label={t.toolbar}
        className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-zinc-800 px-1.5 py-1 text-xs text-zinc-400"
        data-testid="view3d-toolbar"
      >
        <Select value={shape} onValueChange={(v) => setView3d({ shape: v as TestShape })}>
          <SelectTrigger className="w-auto min-w-[7.5rem]" aria-label={t.shape} title={t.shapeHint} data-testid="view3d-shape">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEW3D_SHAPES.map((s) => <SelectItem key={s} value={s}>{t.shapes[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={mode} onValueChange={(v) => setView3d({ mode: v as View3dMode })}>
          <SelectTrigger className="w-auto min-w-[6.5rem]" aria-label={t.mode} title={t.modeHint} data-testid="view3d-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEW3D_MODES.map((m) => <SelectItem key={m} value={m}>{modeLabel(m)}</SelectItem>)}
          </SelectContent>
        </Select>
        <PartsMenu shape={shape} textured={textured} onChange={(v) => setView3d({ textured: v })} />
        <div className="flex items-center gap-1">
          <span title={t.lightHint}>{t.light}</span>
          <NumField
            className="w-11"
            aria-label={t.lightAzimuth}
            title={t.lightAzimuthHint}
            value={Math.round(lightAzimuthDeg)}
            step={1}
            onCommit={(v) => v !== null && setView3d({ lightAzimuthDeg: v })}
            data-testid="view3d-light-azimuth"
          />
          °
          <NumField
            className="w-10"
            aria-label={t.lightElevation}
            title={t.lightElevationHint}
            value={Math.round(lightElevationDeg)}
            step={1}
            min={0}
            max={90}
            onCommit={(v) => v !== null && setView3d({ lightElevationDeg: v })}
            data-testid="view3d-light-elevation"
          />
          °
        </div>
        <label className="flex items-center gap-1" title={t.pointFilterHint}>
          <Switch
            checked={pointFilter}
            onCheckedChange={(v) => setView3d({ pointFilter: v })}
            aria-label={t.pointFilter}
            data-testid="view3d-point-filter"
          />
          {t.pointFilter}
        </label>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-6 w-6"
          aria-label={t.fit}
          title={t.fitHint}
          onClick={() => sceneRef.current?.fit(shape)}
          data-testid="view3d-fit"
        >
          <Focus size={14} aria-hidden />
        </Button>
      </div>
      <div
        ref={host}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-testid="view3d"
        onPointerMove={(e) => {
          if (mode !== 'rects' || e.buttons !== 0) return;
          const id = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
          const r = e.currentTarget.getBoundingClientRect();
          setHover(id ? { x: e.clientX - r.left, y: e.clientY - r.top, id } : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" data-testid="view3d-canvas" />
        {(glError || !hasPreview) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-zinc-600">
            {glError ?? t.empty3d}
          </div>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            data-testid="view3d-tooltip"
          >
            {t.rectTooltip(hover.id)}
          </div>
        )}
      </div>
    </div>
  );
}
