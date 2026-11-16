import { useEffect, useId, useMemo, useRef } from 'react';
import { toStack } from '@hotspotter/core';
import type { DirtParams, NodeType, WearParams } from '@hotspotter/core';
import {
  Droplets, FileOutput, Grid3x3, Hammer, Image, LayoutDashboard, Shuffle, Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { Section } from './MaterialPanel';

const ICONS: Record<NodeType, LucideIcon> = {
  material: Image,
  structure: Grid3x3,
  layout: LayoutDashboard,
  placement: Shuffle,
  wear: Hammer,
  dirt: Droplets,
  output: FileOutput,
};

const ROW = 'flex h-6 items-center gap-1.5 border-l-2 px-1.5';
/** Height of a row (h-6), to place each switch beside its row. */
const ROW_REM = 1.5;

/** The document as a layer stack; the selected layer drives the inspector. ↑/↓ move the selection. */
export function StackPanel() {
  const doc = useProject((s) => s.doc);
  const selected = useProject((s) => s.selectedLayer);
  const select = useProject((s) => s.setSelectedLayer);
  const updateNode = useProject((s) => s.updateNode);
  const stack = useMemo(() => (doc ? toStack(doc) : null), [doc]);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!doc || !stack) return null;

  if (!Array.isArray(stack)) {
    return (
      <Section title={es.stack.title}>
        <div
          className={cn(ROW, 'cursor-not-allowed border-transparent text-zinc-500')}
          data-testid="stack-row"
          aria-disabled="true"
          title={es.stack.customHint}
        >
          <Workflow className="size-3.5 shrink-0" />
          <span className="truncate">{es.stack.custom}</span>
        </div>
      </Section>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = stack.findIndex((s) => s.type === selected);
    const next = i < 0 ? 0 : Math.min(stack.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    select(stack[next].type);
  };

  const optionId = (nodeId: string) => `${baseId}-${nodeId}`;
  const current = stack.find((s) => s.type === selected);

  // The listbox holds only options; the on/off switches sit in a column laid over the rows' right edge, outside the
  // options, so toggling a layer never selects it.
  return (
    <Section title={es.stack.title}>
      <div className="relative">
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={es.stack.title}
          aria-activedescendant={current ? optionId(current.nodeId) : undefined}
          className="flex flex-col focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500"
          data-testid="stack"
          onKeyDown={onKeyDown}
        >
          {stack.map((entry) => {
            const Icon = ICONS[entry.type];
            const on = selected === entry.type;
            return (
              <div
                key={entry.nodeId}
                id={optionId(entry.nodeId)}
                role="option"
                aria-selected={on}
                data-testid="stack-row"
                data-layer={entry.type}
                className={cn(
                  ROW,
                  'cursor-default pr-9',
                  on ? 'border-accent bg-accent/10 text-zinc-100' : 'border-transparent text-zinc-300 hover:bg-zinc-800',
                )}
                onClick={() => select(entry.type)}
              >
                <Icon className={cn('size-3.5 shrink-0', on ? 'text-accent' : 'text-zinc-500')} />
                <span className="truncate">{entry.label}</span>
              </div>
            );
          })}
        </div>
        {stack.map((entry, i) => {
          if (entry.type !== 'wear' && entry.type !== 'dirt') return null;
          const params = doc.nodes.find((n) => n.id === entry.nodeId)?.params as WearParams | DirtParams | undefined;
          if (!params) return null;
          return (
            <span
              key={entry.nodeId}
              className="absolute right-1.5 flex h-6 items-center"
              style={{ top: `${i * ROW_REM}rem` }}
            >
              <Switch
                checked={params.enabled}
                onCheckedChange={(enabled) => updateNode<'wear' | 'dirt'>(entry.nodeId, { enabled })}
                aria-label={`${es.wear.enabled} ${entry.label.toLowerCase()}`}
                title={entry.type === 'wear' ? es.wear.enabledHint : es.dirt.enabledHint}
                data-testid={`stack-${entry.type}-enabled`}
              />
            </span>
          );
        })}
      </div>
    </Section>
  );
}
