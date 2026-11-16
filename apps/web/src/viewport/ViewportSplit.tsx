import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';

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
  const dragging = useRef<{ offset: number; moved: boolean } | null>(null);
  const latest = useRef(state);
  latest.current = state;

  const update = useCallback((next: Saved) => {
    setState(next);
    save(next);
  }, []);

  // A check click wants the atlas on screen: leave a maximized 3D pane.
  const focusSeq = useProject((s) => s.viewFocus?.seq ?? 0);
  const seenFocus = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq === seenFocus.current) return;
    seenFocus.current = focusSeq;
    if (focusSeq === 0) return;
    if (latest.current.maximized === 'right') update({ ratio: latest.current.ratio, maximized: null });
  }, [focusSeq, update]);

  /** Ratio that puts the divider where the pointer is, keeping the point of the divider that was grabbed. */
  const ratioFromPointer = (clientX: number, offset: number): number | null => {
    const r = row.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    return clampRatio((clientX - offset - r.left) / r.width);
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
          className="relative z-10 w-1 shrink-0 cursor-col-resize touch-none bg-zinc-800 before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[''] hover:bg-zinc-600 focus-visible:bg-zinc-600 focus-visible:outline-none"
          data-testid="viewport-divider"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = row.current?.getBoundingClientRect();
            dragging.current = { offset: r ? e.clientX - (r.left + ratio * r.width) : 0, moved: false };
          }}
          onPointerMove={(e) => {
            const d = dragging.current;
            if (!d) return;
            if ((e.buttons & 1) === 0) {
              // The button was released somewhere we did not see: end the drag.
              dragging.current = null;
              if (d.moved) save(latest.current);
              return;
            }
            const r = ratioFromPointer(e.clientX, d.offset);
            if (r === null || r === latest.current.ratio) return;
            d.moved = true;
            setState((s) => ({ ...s, ratio: r }));
          }}
          onPointerUp={(e) => {
            const d = dragging.current;
            dragging.current = null;
            if (!d?.moved) return;
            const r = ratioFromPointer(e.clientX, d.offset);
            update({ ratio: r ?? latest.current.ratio, maximized: null });
          }}
          onPointerCancel={() => {
            const d = dragging.current;
            dragging.current = null;
            if (d?.moved) save(latest.current);
          }}
          onLostPointerCapture={(e) => {
            // The event of a finished drag can arrive after the next pointerdown; that drag owns the capture.
            if (e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const d = dragging.current;
            dragging.current = null;
            if (d?.moved) save(latest.current);
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
