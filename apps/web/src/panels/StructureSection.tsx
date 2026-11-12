import { ScanSearch } from 'lucide-react';
import type { NodeParams } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { NumField, Row, Section } from './MaterialPanel';

/** Structure node: proposed material type, segmentation threshold and re-detection. */
export function StructureSection() {
  const node = useProject((s) => s.doc?.nodes.find((n) => n.type === 'structure')?.params) as
    | NodeParams['structure']
    | undefined;
  const structure = useProject((s) => s.structure);
  const error = useProject((s) => s.structureError);
  const hasMaterial = useProject((s) => s.material !== null);
  const analyze = useProject((s) => s.analyze);
  const setThreshold = useProject((s) => s.setStructureThreshold);
  if (!node || !hasMaterial) return null;
  const r = structure?.result;
  // Automatic threshold: show the analysis' suggestion (on the joint relief scale) as the field's value.
  const shown = node.threshold ?? r?.suggestedThreshold ?? null;

  return (
    <Section title={es.structure.title}>
      <Row label={es.structure.type}>
        <span className="text-zinc-200" data-testid="structure-type">
          {node.analyzed ? es.structure.types[node.type] : es.structure.notAnalyzed}
        </span>
        {r && structure && (
          <span className="ml-auto truncate text-zinc-500" title={es.structure.source[structure.source]}>
            {es.structure.pieces(r.pieceCount)}
          </span>
        )}
      </Row>
      <Row label={es.structure.threshold} hint={es.structure.thresholdHint}>
        <NumField
          nullable
          aria-label={es.structure.threshold}
          title={es.structure.thresholdHint}
          data-testid="structure-threshold"
          value={shown === null ? null : Math.round(shown * 1000) / 1000}
          onCommit={(v) => (v === null || (v > 0 && v <= 1)) && void setThreshold(v)}
        />
        <Button size="sm" data-testid="structure-detect" onClick={() => void analyze()}>
          <ScanSearch className="h-3 w-3" />
          {es.structure.detect}
        </Button>
      </Row>
      {error && <div className="text-red-400" data-testid="structure-error">{error}</div>}
    </Section>
  );
}
