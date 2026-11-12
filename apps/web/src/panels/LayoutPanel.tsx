import { PRESET_IDS } from '@hotspotter/core';
import type { AutoTarget, NodeParams, PresetId } from '@hotspotter/core';
import { RefreshCw } from 'lucide-react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { NumField, Row, Section } from './MaterialPanel';

const TARGETS: AutoTarget[] = ['walls', 'floors', 'trims', 'mixed'];

export function LayoutPanel() {
  const doc = useProject((s) => s.doc);
  const setLayoutParams = useProject((s) => s.setLayoutParams);
  const node = doc?.nodes.find((n) => n.id === 'layout');
  if (!node) return null;
  const p = node.params as NodeParams['layout'];

  // The params are replaced wholesale so switching mode leaves no stale keys.
  const setMode = (mode: string) => {
    if (mode === p.mode) return;
    setLayoutParams(mode === 'auto' ? { mode: 'auto', target: 'walls', seed: 0 } : { mode: 'preset', preset: 'walls' });
  };

  return (
    <Section title={es.material.layout}>
      <Row label={es.layout.mode}>
        <Select value={p.mode} onValueChange={setMode}>
          <SelectTrigger data-testid="layout-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="preset">{es.layout.modePreset}</SelectItem>
            <SelectItem value="auto">{es.layout.modeAuto}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {p.mode === 'preset' ? (
        <Row label={es.layout.preset}>
          <Select
            value={p.preset}
            onValueChange={(v) => setLayoutParams({ mode: 'preset', preset: v as PresetId })}
          >
            <SelectTrigger data-testid="layout-preset"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESET_IDS.map((id) => (
                <SelectItem key={id} value={id}>{es.layout.presets[id]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      ) : (
        <>
          <Row label={es.layout.target}>
            <Select
              value={p.target}
              onValueChange={(v) => setLayoutParams({ mode: 'auto', target: v as AutoTarget, seed: p.seed })}
            >
              <SelectTrigger data-testid="layout-target"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TARGETS.map((t) => (
                  <SelectItem key={t} value={t}>{es.layout.targets[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={es.layout.seed}>
            <NumField
              data-testid="layout-seed"
              aria-label={es.layout.seed}
              value={p.seed}
              onCommit={(v) =>
                v !== null && Number.isInteger(v) && v >= 0 &&
                setLayoutParams({ mode: 'auto', target: p.target, seed: v })}
            />
            <Button
              size="sm"
              title={es.layout.reseed}
              aria-label={es.layout.reseed}
              data-testid="layout-reseed"
              onClick={() =>
                setLayoutParams({ mode: 'auto', target: p.target, seed: Math.floor(Math.random() * 1e6) })}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </Row>
        </>
      )}
    </Section>
  );
}
