import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { es } from '../i18n/es';

const STORAGE_KEY = 'hs.viewport';
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const STEP = 0.02;

type Pane = 'left' | 'right';
interface Saved { ratio: number; maximized: Pane | null }

const DEFAULT: Saved = { ratio: 0.5, maximized: null };

function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return DEFAULT;
    const { ratio, maximized } = v as Record<string, unknown>;
    return {
      ratio: typeof ratio === 'number' && Number.isFinite(ratio) ? clampRatio(ratio) : DEFAULT.ratio,
      maximized: maximized === 'left' || maximized === 'right' ? maximized : null,
    };
  } catch {
    return DEFAULT;
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage can be blocked or full; the layout just is not remembered.
  }
}

interface ViewportSplitProps {
  left: ReactNode;
  right: ReactNode;
}

interface PaneHeaderProps {
  title: string;
  maximized: boolean;
  maximizeLabel: string;
  onToggle: () => void;
}

function PaneHeader({ title, maximized, maximizeLabel, onToggle }: PaneHeaderProps) {
  const label = maximized ? es.viewport.restore : maximizeLabel;
  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-b border-zinc-800 pl-2 pr-1 text-xs uppercase tracking-wide text-zinc-500">
      <span>{title}</span>
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        aria-label={label}
        title={label}
        onClick={onToggle}
      >
        {maximized ? <Minimize2 size={12} aria-hidden /> : <Maximize2 size={12} aria-hidden />}
      </button>
    </div>
  );
}

/** Atlas 2D | Vista 3D with a draggable divider (20-80 %), a maximize button per pane and a remembered layout. */
export function ViewportSplit({ left, right }: ViewportSplitProps) {
  const [state, setState] = useState<Saved>(load);
  const row = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const update = useCallback((next: Saved) => {
    setState(next);
    save(next);
  }, []);

  const ratioFromPointer = (clientX: number): number | null => {
    const r = row.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    return clampRatio((clientX - r.left) / r.width);
  };

  const { ratio, maximized } = state;
  const toggle = (pane: Pane) => update({ ratio, maximized: maximized === pane ? null : pane });
  const pct = Math.round(ratio * 100);

  return (
    <div ref={row} className="flex min-h-0 min-w-0 flex-1" data-testid="viewport-split">
      <section
        className={`flex min-h-0 min-w-0 flex-col ${maximized === 'right' ? 'hidden' : ''}`}
        style={maximized === 'left' ? { flex: '1 1 0' } : { flex: `0 0 ${ratio * 100}%` }}
        data-testid="viewport-2d"
      >
        <PaneHeader
          title={es.atlas.title}
          maximized={maximized === 'left'}
          maximizeLabel={es.viewport.maximize2d}
          onToggle={() => toggle('left')}
        />
        {left}
      </section>
      {maximized === null && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={es.viewport.divider}
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={pct}
          tabIndex={0}
          title={es.viewport.dividerHint}
          className="w-1 shrink-0 cursor-col-resize touch-none bg-zinc-800 hover:bg-zinc-600 focus-visible:bg-zinc-600 focus-visible:outline-none"
          data-testid="viewport-divider"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const r = ratioFromPointer(e.clientX);
            if (r !== null) setState((s) => ({ ...s, ratio: r }));
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            const r = ratioFromPointer(e.clientX);
            update({ ratio: r ?? ratio, maximized: null });
          }}
          onPointerCancel={() => {
            dragging.current = false;
            save(state);
          }}
          onDoubleClick={() => update({ ratio: DEFAULT.ratio, maximized: null })}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            update({ ratio: clampRatio(ratio + (e.key === 'ArrowRight' ? STEP : -STEP)), maximized: null });
          }}
        />
      )}
      <section
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${maximized === 'left' ? 'hidden' : ''}`}
        data-testid="viewport-3d"
      >
        <PaneHeader
          title={es.viewport.title3d}
          maximized={maximized === 'right'}
          maximizeLabel={es.viewport.maximize3d}
          onToggle={() => toggle('right')}
        />
        {right}
      </section>
    </div>
  );
}
