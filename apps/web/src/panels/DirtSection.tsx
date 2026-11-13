import type { DirtParams, DocNode } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Switch } from '../components/ui/switch';
import { Row, Section } from './MaterialPanel';
import { LengthField, SliderField } from './WearSection';

const toHex = (rgb: [number, number, number]) =>
  `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

const fromHex = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Dirt node: on/off switch, cavity dirt, runoff and their tint. */
export function DirtSection() {
  const node = useProject((s) => s.doc?.nodes.find((n): n is DocNode<'dirt'> => n.type === 'dirt'));
  const updateNode = useProject((s) => s.updateNode);
  if (!node) return null;
  const d = node.params;
  const set = (patch: Partial<DirtParams>) => updateNode<'dirt'>(node.id, patch);
  const t = es.dirt;

  return (
    <Section
      title={t.title}
      testId="dirt-section"
      dimmed={!d.enabled}
      action={(
        <Switch
          checked={d.enabled} onCheckedChange={(enabled) => set({ enabled })}
          aria-label={`${t.enabled} ${t.title.toLowerCase()}`} title={t.enabledHint} data-testid="dirt-enabled"
        />
      )}
    >
      <SliderField
        label={t.cavity} hint={t.cavityHint} value={d.cavity} min={0} max={1} step={0.01}
        onChange={(v) => set({ cavity: v })}
      />
      <SliderField
        label={t.runoff} hint={t.runoffHint} value={d.runoff} min={0} max={1} step={0.01}
        onChange={(v) => set({ runoff: v })}
      />
      <LengthField
        label={t.length} hint={t.lengthHint} valueM={d.runoffLengthM} unit="cm"
        onChange={(v) => set({ runoffLengthM: v })}
      />
      <Row label={t.tint} hint={t.tintHint}>
        <input
          type="color"
          className="h-5 w-10 cursor-pointer rounded border border-zinc-700 bg-transparent"
          aria-label={t.tint}
          title={t.tintHint}
          data-testid="dirt-tint"
          value={toHex(d.tint)}
          onChange={(e) => set({ tint: fromHex(e.target.value) })}
        />
        <span className="tabular-nums text-zinc-500">{d.tint.map((c) => c.toFixed(2)).join(' · ')}</span>
      </Row>
    </Section>
  );
}
