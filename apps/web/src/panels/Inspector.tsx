import { useMemo } from 'react';
import { toStack } from '@hotspotter/core';
import type { GrooveProfile, NodeParams } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import type { PreviewRes } from '../state/store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { NumField, Row, Section } from './MaterialPanel';
import { StructureSection } from './StructureSection';
import { WearSection } from './WearSection';
import { DirtSection } from './DirtSection';
import { LayoutPanel } from './LayoutPanel';
import { RESOLUTIONS } from '../export/ExportDialog';

const PREVIEW_RES: PreviewRes[] = [512, 1024, 2048];
const PROFILES: GrooveProfile[] = ['bevel', 'round', 'step', 'none'];

/** Shows only the section of the layer selected in the Pila. */
export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selected = useProject((s) => s.selectedLayer);
  const stack = useMemo(() => (doc ? toStack(doc) : null), [doc]);
  let content: React.ReactNode;
  if (!doc || !stack) content = <div className="p-2 text-zinc-600">{es.inspector.empty}</div>;
  else if (!Array.isArray(stack)) content = <div className="p-2 text-zinc-500">{es.inspector.customGraph}</div>;
  else {
    switch (selected) {
      case 'material':
        content = (
          <Section title={es.material.title}>
            <p className="leading-snug text-zinc-500" data-testid="material-hint">{es.inspector.materialHint}</p>
          </Section>
        );
        break;
      case 'structure': content = <StructureSection />; break;
      case 'layout': content = <LayoutPanel />; break;
      case 'placement': content = <PlacementSection />; break;
      case 'wear': content = <WearSection />; break;
      case 'dirt': content = <DirtSection />; break;
      case 'output': content = <OutputSection />; break;
      default: content = <div className="p-2 text-zinc-600">{es.inspector.empty}</div>;
    }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto" data-testid="inspector-scroll">{content}</div>;
}

function PlacementSection() {
  const placement = useProject((s) => s.doc?.nodes.find((n) => n.id === 'placement')?.params) as
    | NodeParams['placement']
    | undefined;
  const updateNode = useProject((s) => s.updateNode);
  if (!placement) return null;
  return (
    <Section title={es.inspector.placement}>
      <Row label={es.inspector.variation}>
        <Slider
          min={0}
          max={1}
          step={0.01}
          value={[placement.variation]}
          onValueChange={([v]) => updateNode<'placement'>('placement', { variation: v })}
        />
        <NumField
          className="w-12 shrink-0"
          aria-label={es.inspector.variation}
          min={0}
          max={1}
          value={placement.variation}
          onCommit={(v) => v !== null && v >= 0 && v <= 1 && updateNode<'placement'>('placement', { variation: v })}
        />
      </Row>
      <Row label={es.inspector.placementSeed}>
        <NumField
          aria-label={es.inspector.placementSeed}
          step={1}
          min={0}
          value={placement.seed}
          onCommit={(v) =>
            v !== null && Number.isInteger(v) && v >= 0 && updateNode<'placement'>('placement', { seed: v })}
        />
      </Row>
    </Section>
  );
}

/** Output node: preview and export resolution, world width and the groove between rects. */
function OutputSection() {
  const output = useProject((s) => s.doc?.nodes.find((n) => n.id === 'output')?.params) as
    | NodeParams['output']
    | undefined;
  const previewRes = useProject((s) => s.previewRes);
  const setPreviewRes = useProject((s) => s.setPreviewRes);
  const updateNode = useProject((s) => s.updateNode);
  if (!output) return null;
  const g = output.groove;
  // The merge in updateNodeParams is shallow, so the whole groove is passed.
  const setGroove = (patch: Partial<typeof g>) => updateNode<'output'>('output', { groove: { ...g, ...patch } });
  const res = output.resolutionPx;
  const resList = RESOLUTIONS.includes(res) ? RESOLUTIONS : [...RESOLUTIONS, res].sort((a, b) => a - b);

  return (
    <Section title={es.inspector.output}>
      <Row label={es.inspector.exportRes}>
        <Select value={String(res)} onValueChange={(v) => updateNode<'output'>('output', { resolutionPx: Number(v) })}>
          <SelectTrigger data-testid="output-res"><SelectValue /></SelectTrigger>
          <SelectContent>
            {resList.map((r) => (
              <SelectItem key={r} value={String(r)}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={es.inspector.preview}>
        <Select value={String(previewRes)} onValueChange={(v) => setPreviewRes(Number(v) as PreviewRes)}>
          <SelectTrigger data-testid="preview-res"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PREVIEW_RES.map((r) => (
              <SelectItem key={r} value={String(r)}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={es.inspector.worldWidth}>
        <NumField
          aria-label={es.inspector.worldWidth}
          step={0.1}
          min={0.1}
          value={output.worldWidthM}
          onCommit={(v) => v !== null && v > 0 && updateNode<'output'>('output', { worldWidthM: v })}
        />
      </Row>
      <h3 className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{es.inspector.groove}</h3>
      <Row label={es.inspector.grooveWidth} hint={es.inspector.grooveWidthHint}>
        <NumField
          aria-label={es.inspector.grooveWidth}
          step={0.1}
          min={0}
          title={es.inspector.grooveWidthHint}
          value={Math.round(g.widthM * 1e4) / 10}
          onCommit={(v) => v !== null && v >= 0 && setGroove({ widthM: v / 1000 })}
        />
      </Row>
      <Row label={es.inspector.grooveBevel} hint={es.inspector.grooveBevelHint}>
        <NumField
          aria-label={es.inspector.grooveBevel}
          step={0.1}
          min={0}
          title={es.inspector.grooveBevelHint}
          value={Math.round(g.bevelM * 1e4) / 10}
          onCommit={(v) => v !== null && v >= 0 && setGroove({ bevelM: v / 1000 })}
        />
      </Row>
      <Row label={es.inspector.grooveDepth}>
        <NumField
          aria-label={es.inspector.grooveDepth}
          step={0.1}
          min={0}
          value={Math.round(g.depthM * 1e4) / 10}
          onCommit={(v) => v !== null && v >= 0 && setGroove({ depthM: v / 1000 })}
        />
      </Row>
      <Row label={es.inspector.grooveProfile}>
        <Select value={g.profile} onValueChange={(v) => setGroove({ profile: v as GrooveProfile })}>
          <SelectTrigger data-testid="groove-profile"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PROFILES.map((p) => (
              <SelectItem key={p} value={p}>{es.inspector.profiles[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Section>
  );
}
