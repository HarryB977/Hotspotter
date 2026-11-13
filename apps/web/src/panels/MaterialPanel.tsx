import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { classifyMapFile, sanitizeMaterialName } from '@hotspotter/core';
import type { MapKind, MaterialPeriod } from '@hotspotter/core';
import { FileImage, FolderOpen } from 'lucide-react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { cn } from '../lib/utils';
import { ImportChoiceDialog } from '../import/ImportChoiceDialog';

const KINDS: MapKind[] = ['baseColor', 'normal', 'height', 'roughness', 'metallic', 'ao', 'opacity'];
const NONE = 'none';

/** Collects the files of a dropped folder or file list, plus the dropped folder's name. */
async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; folder?: string }> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  const entries = Array.from(dt.items)
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return { files: Array.from(dt.files) };
  for (const e of entries) await walk(e);
  return { files: out, folder: entries.find((e) => e.isDirectory)?.name };
}

export function Row({ label, hint, children, testId }: {
  label: string; hint?: string; children: React.ReactNode; testId?: string;
}) {
  return (
    <div className="flex min-h-6 items-center gap-2" data-testid={testId}>
      <span className="w-24 shrink-0 truncate text-zinc-400" title={hint ? `${label}. ${hint}` : label}>{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

interface NumFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: number | null;
  /** Called with a finite number, or null when the field is emptied and `nullable` is set. */
  onCommit(v: number | null): void;
  nullable?: boolean;
  /** Value change per pixel of horizontal drag (Shift ×0.1, Ctrl ×10). Default 0.01. */
  step?: number;
  min?: number;
  max?: number;
  /** Commit while dragging (default). False commits once on release, for edits that trigger a slow re-analysis. */
  live?: boolean;
}

/** Pixels the pointer must travel before a press becomes a drag instead of a click to type. */
const DRAG_THRESHOLD_PX = 3;

const decimalsOf = (step: number) => Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)));

/**
 * Text field that edits a number locally and commits on blur or Enter, only when the value changed.
 * Not focused, it shows a horizontal-resize cursor: press and drag left or right to scrub the value; a click without
 * moving focuses the field and selects its text for typing.
 */
export function NumField({
  value, onCommit, nullable, className, step = 0.01, min, max, live = true, disabled, ...rest
}: NumFieldProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const drag = useRef<{ id: number; x: number; start: number; moved: boolean; last: number | null } | null>(null);
  const frame = useRef(0);
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const commit = () => {
    const t = text.trim().replace(',', '.');
    if (t === '') {
      if (nullable && value !== null) onCommit(null);
      else setText(value === null ? '' : String(value));
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setText(value === null ? '' : String(value));
  };
  const scrubTo = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = drag.current!;
    const mult = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
    const s = step * mult;
    let v = d.start + Math.round(e.clientX - d.x) * s;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    v = Number(v.toFixed(decimalsOf(s)));
    if (v === d.last) return;
    d.last = v;
    setText(String(v));
    if (live) {
      // One commit per frame: the store coalesces recompositions, but a commit per pointer event is wasted work.
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => onCommit(v));
    }
  };
  return (
    <Input
      {...rest}
      disabled={disabled}
      inputMode="decimal"
      className={cn('text-right', !focused && !disabled && 'cursor-ew-resize', className)}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onPointerDown={(e) => {
        if (focused || disabled || e.button !== 0) return;
        // Keep the browser from placing a text caret; the field is focused on release if the press was a click.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, start: value ?? 0, moved: false, last: null };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_THRESHOLD_PX) return;
        if (!d.moved) { d.moved = true; setScrubbing(true); }
        scrubTo(e);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (!d.moved) {
          e.currentTarget.focus();
          e.currentTarget.select();
          return;
        }
        setScrubbing(false);
        cancelAnimationFrame(frame.current);
        if (d.last !== null && d.last !== value) onCommit(d.last);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setScrubbing(false);
        setText(value === null ? '' : String(value));
      }}
      data-scrubbing={scrubbing || undefined}
    />
  );
}

/** Material name, used as the export file prefix; sanitized on commit, empty keeps the old name. */
function NameField({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const name = sanitizeMaterialName(text);
    if (name && name !== value) onCommit(name);
    else setText(value);
  };
  return (
    <Input
      className="h-7 text-lg text-zinc-100"
      aria-label={es.material.name}
      title={es.material.nameHint}
      data-testid="material-name"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

function Check({ checked, onChange, label, testId }: {
  checked: boolean; onChange(v: boolean): void; label?: string; testId?: string;
}) {
  return (
    <label className="flex items-center gap-1 text-zinc-300">
      <input
        type="checkbox"
        className="h-3 w-3 accent-amber-500"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** Panel section; `action` sits at the right of the header, `dimmed` fades the fields (they stay editable). */
export function Section({ title, children, action, dimmed, testId }: {
  title: string; children: React.ReactNode; action?: React.ReactNode; dimmed?: boolean; testId?: string;
}) {
  return (
    <section className="border-b border-zinc-800 px-2 py-2" data-testid={testId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500">{title}</h2>
        {action}
      </div>
      <div className={cn('flex flex-col gap-1', dimmed && 'opacity-40')} data-dimmed={dimmed ? '' : undefined}>
        {children}
      </div>
    </section>
  );
}

export function MaterialPanel() {
  const { material, sources, importing, importError, importFiles, updateSettings, assignMap } = useProject();
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{ files: File[]; folder?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const fallback = useProject((st) => st.atlas?.layout.warnings?.includes('orientation-fallback') === true);
  const s = material?.settings;

  /** With a material loaded the user chooses between adding and replacing. */
  const incoming = (files: File[], folder?: string) => {
    if (material && files.length > 0) setPending({ files, folder });
    else void importFiles(files, folder);
  };

  const setPeriod = (patch: Partial<MaterialPeriod>) => {
    if (!s) return;
    // Changing the period itself (not the cut flags) stops automatic analyses from proposing one.
    const keys = ['x', 'y', 'phaseX', 'phaseY'] as const;
    const userSet = s.periodUserSet === true || keys.some((k) => k in patch && patch[k] !== s.period[k]);
    void updateSettings({ period: { ...s.period, ...patch }, periodUserSet: userSet });
  };

  const chosen = new Set(s ? Object.values(s.files) : []);
  const rows = s ? (Object.entries(s.files) as [MapKind, string][]) : [];
  const others = sources.filter((f) => !chosen.has(f.name));

  return (
    <div className="flex flex-col">
      <Section title={es.material.title}>
        <div
          className={cn(
            'flex h-14 flex-col items-center justify-center gap-1 rounded border border-dashed text-zinc-500',
            dragging ? 'border-accent text-zinc-200' : 'border-zinc-700',
          )}
          data-testid="drop-zone"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void filesFromDrop(e.dataTransfer).then(({ files, folder }) => incoming(files, folder));
          }}
        >
          <span>{importing ? es.material.importing : es.material.drop}</span>
          <div className="flex gap-1">
            <Button size="sm" onClick={() => inputRef.current?.click()}>
              <FolderOpen className="h-3 w-3" />
              {es.material.pick}
            </Button>
            <Button size="sm" onClick={() => filesRef.current?.click()}>
              <FileImage className="h-3 w-3" />
              {es.material.pickFiles}
            </Button>
          </div>
          <input
            ref={filesRef}
            type="file"
            multiple
            hidden
            accept="image/*"
            data-testid="import-files"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              incoming(list);
            }}
          />
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            data-testid="folder-input"
            // webkitdirectory is not in React's typings.
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              incoming(list);
            }}
          />
        </div>

        <ImportChoiceDialog
          open={pending !== null}
          onCancel={() => setPending(null)}
          onChoose={(mode) => {
            const p = pending;
            setPending(null);
            if (p) void importFiles(p.files, p.folder, mode);
          }}
        />

        {importError && (
          <div className="text-red-400" data-testid="import-error">{importError}</div>
        )}

        {s && (
          <div className="mt-1 flex flex-col gap-1">
            <NameField value={s.name} onCommit={(name) => void updateSettings({ name })} />
            {rows.map(([kind, name]) => (
              <div key={name} className="flex items-center gap-1" data-testid="map-row" data-kind={kind}>
                <Select value={kind} onValueChange={(v) => void assignMap(name, v === NONE ? null : (v as MapKind))}>
                  <SelectTrigger className="w-24 shrink-0" data-testid="map-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{es.material.mapKinds[k]}</SelectItem>
                    ))}
                    <SelectItem value={NONE}>{es.material.mapNone}</SelectItem>
                  </SelectContent>
                </Select>
                <span className="min-w-0 flex-1 truncate text-zinc-400" title={name}>{name}</span>
                {kind === 'normal' && (
                  <span className="text-zinc-500" data-testid="normal-tag">
                    {s.normalConvention.toUpperCase()}
                  </span>
                )}
              </div>
            ))}
            {others.map((f) => {
              const m = classifyMapFile(f.name);
              return (
                <div key={f.name} className="flex items-center gap-1 text-zinc-600">
                  <Select value={NONE} onValueChange={(v) => void assignMap(f.name, v === NONE ? null : (v as MapKind))}>
                    <SelectTrigger className="w-24 shrink-0 text-zinc-500" data-testid="other-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KINDS.map((k) => (
                        <SelectItem key={k} value={k}>{es.material.mapKinds[k]}</SelectItem>
                      ))}
                      <SelectItem value={NONE}>{es.material.mapNone}</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="min-w-0 flex-1 truncate" title={f.name} data-testid="ignored-file">
                    {f.name}
                  </span>
                  <span className="shrink-0">{m ? es.material.ignoredAlt : es.material.unrecognized}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {s && (
        <>
          <Section title={es.material.properties}>
            <Row label={es.material.tileSize}>
              <NumField
                aria-label={`${es.material.tileSize} ${es.material.axisX}`}
                min={0.01}
                live={false}
                value={s.tileSizeM[0]}
                onCommit={(v) => v !== null && v > 0 && void updateSettings({ tileSizeM: [v, s.tileSizeM[1]] })}
              />
              <NumField
                aria-label={`${es.material.tileSize} ${es.material.axisY}`}
                min={0.01}
                live={false}
                value={s.tileSizeM[1]}
                onCommit={(v) => v !== null && v > 0 && void updateSettings({ tileSizeM: [s.tileSizeM[0], v] })}
              />
            </Row>
            <Row label={es.material.heightScale}>
              <Slider
                min={0}
                max={10}
                step={0.1}
                value={[s.heightScaleM * 100]}
                onValueChange={([v]) => void updateSettings({ heightScaleM: v / 100 })}
              />
              <NumField
                className="w-12 shrink-0"
                aria-label={es.material.heightScale}
                step={0.1}
                min={0}
                live={false}
                value={Math.round(s.heightScaleM * 1000) / 10}
                onCommit={(v) => v !== null && v >= 0 && void updateSettings({ heightScaleM: v / 100 })}
              />
            </Row>
            <Row label={es.material.normalConvention}>
              <Select
                value={s.normalConvention}
                onValueChange={(v) => void updateSettings({ normalConvention: v as 'gl' | 'dx' })}
              >
                <SelectTrigger data-testid="normal-convention">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gl">GL</SelectItem>
                  <SelectItem value="dx">DX</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Check
              label={es.material.roughnessIsGloss}
              checked={s.roughnessIsGloss}
              onChange={(v) => void updateSettings({ roughnessIsGloss: v })}
            />
          </Section>

          <Section title={es.material.orientationSection}>
            <Row label={es.material.baseRotation}>
              <Select
                value={String(s.orientation.baseRotation)}
                onValueChange={(v) =>
                  void updateSettings({ orientation: { ...s.orientation, baseRotation: v === '90' ? 90 : 0 } })}
              >
                <SelectTrigger data-testid="base-rotation"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0°</SelectItem>
                  <SelectItem value="90">90°</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label={es.material.orientationRule}>
              <Select
                value={s.orientation.rule}
                onValueChange={(v) => void updateSettings({ orientation: { ...s.orientation, rule: v as 'fixed' | 'longAxis' } })}
              >
                <SelectTrigger data-testid="orientation-rule"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">{es.material.ruleFixed}</SelectItem>
                  <SelectItem value="longAxis">{es.material.ruleLongAxis}</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {fallback && (
              <div className="text-amber-400" data-testid="orientation-fallback">{es.material.orientationFallback}</div>
            )}
          </Section>

          <Section title={es.material.periodSection}>
            <Row label={es.material.period}>
              <NumField
                nullable
                aria-label={`${es.material.period} ${es.material.axisX}`}
                step={0.001}
                min={0.001}
                live={false}
                placeholder="X"
                value={s.period.x}
                onCommit={(v) => (v === null || v > 0) && setPeriod({ x: v })}
              />
              <NumField
                nullable
                aria-label={`${es.material.period} ${es.material.axisY}`}
                step={0.001}
                min={0.001}
                live={false}
                placeholder="Y"
                value={s.period.y}
                onCommit={(v) => (v === null || v > 0) && setPeriod({ y: v })}
              />
            </Row>
            <Row label={es.material.phase}>
              <NumField
                aria-label={`${es.material.phase} ${es.material.axisX}`}
                step={0.001}
                live={false}
                value={s.period.phaseX}
                onCommit={(v) => v !== null && setPeriod({ phaseX: v })}
              />
              <NumField
                aria-label={`${es.material.phase} ${es.material.axisY}`}
                step={0.001}
                live={false}
                value={s.period.phaseY}
                onCommit={(v) => v !== null && setPeriod({ phaseY: v })}
              />
            </Row>
            <Row label={es.material.allowCut}>
              <Check
                label={es.material.axisX}
                checked={s.period.cutAllowedX}
                onChange={(v) => setPeriod({ cutAllowedX: v })}
              />
              <Check
                label={es.material.axisY}
                checked={s.period.cutAllowedY}
                onChange={(v) => setPeriod({ cutAllowedY: v })}
              />
            </Row>
            <Check
              label={es.material.allowRotation}
              checked={s.allowRotation}
              onChange={(v) => void updateSettings({ allowRotation: v })}
            />
          </Section>
        </>
      )}
    </div>
  );
}
