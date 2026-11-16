import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Focus } from 'lucide-react';
import { buildShape, fitFaces } from '@hotspotter/core';
import type { DocNode, HotspotFit, ShapeFace, TestShape } from '@hotspotter/core';
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
 * movable light. It reads the preview atlas back once per composition (decision 80), and only while it is on screen.
 */
function View3D() {
  const gpu = useProject((s) => s.gpu);
  const atlas = useProject((s) => s.atlas);
  const settings = useProject((s) => s.view3d);
  const setView3d = useProject((s) => s.setView3d);
  const { shape, mode, lightAzimuthDeg, lightElevationDeg, pointFilter } = settings;

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
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => {
      ro.disconnect();
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
  }, []);

  // One read per atlas, only while the pane is on screen; a newer atlas, hiding the pane or unmounting supersedes it.
  useEffect(() => {
    if (!sceneRef.current) return;
    if (!atlas) {
      loadGen.current++;
      if (current.current) retired.current.push(current.current.set);
      current.current = null;
      setShown(null);
      return;
    }
    if (!visible || !gpu || current.current?.atlas === atlas) return;
    const mine = ++loadGen.current;
    const isCurrent = () => mine === loadGen.current && visibleRef.current && useProject.getState().atlas === atlas;
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
  }, [atlas, visible, gpu]);

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
    scene.setShape(fitted.faces, fitted.fits, shown?.layout ?? null);
    for (const s of retired.current) disposeAtlasTextures(s);
    retired.current = [];
    view3dDebug.shownAtlas = shown;
    if (fitted.faces.length > 0 && fittedShape.current !== shape) {
      fittedShape.current = shape;
      scene.fit(shape);
    }
  }, [shown, shape]);

  useEffect(() => sceneRef.current?.setMode(mode), [mode]);
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
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-800 px-1.5 py-1 text-xs text-zinc-400"
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
        {(glError || !atlas) && (
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
