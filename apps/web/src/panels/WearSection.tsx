import { useRef } from 'react';
import { WEAR_FAMILIES } from '@hotspotter/core';
import type { DocNode, WearFamily, WearParams } from '@hotspotter/core';
import { FileImage, RefreshCw, X } from 'lucide-react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { NumField, Row, Section } from './MaterialPanel';

const FAMILIES = Object.keys(WEAR_FAMILIES) as WearFamily[];

const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Slider plus numeric field on one row; the field rejects values outside [min, max]. */
export function SliderField({ label, hint, value, min, max, step, onChange, disabled }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; onChange(v: number): void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint}>
      <Slider
        min={min} max={max} step={step} value={[value]} disabled={disabled} className={disabled ? 'opacity-40' : undefined}
        onValueChange={([v]) => onChange(v)}
      />
      <NumField
        className="w-12 shrink-0"
        aria-label={label}
        title={hint}
        disabled={disabled}
        step={step}
        min={min}
        max={max}
        value={round(value)}
        onCommit={(v) => v !== null && v >= min && v <= max && onChange(v)}
      />
    </Row>
  );
}

/** Numeric field for a length stored in metres and shown in `unit` (cm or mm); accepts values >= 0. */
export function LengthField({ label, hint, valueM, unit, onChange }: {
  label: string; hint: string; valueM: number; unit: 'cm' | 'mm'; onChange(m: number): void;
}) {
  const k = unit === 'cm' ? 100 : 1000;
  return (
    <Row label={label} hint={hint}>
      <NumField
        aria-label={label}
        title={hint}
        step={0.1}
        min={0}
        value={round(valueM * k, 2)}
        onCommit={(v) => v !== null && v >= 0 && onChange(v / k)}
      />
      {/* The label may be truncated; the unit stays visible here. */}
      <span className="w-5 shrink-0 text-zinc-500">{unit}</span>
    </Row>
  );
}

/** Wear node: on/off switch, family, edge damage, B/W mask and substrate. */
export function WearSection() {
  const node = useProject((s) => s.doc?.nodes.find((n): n is DocNode<'wear'> => n.type === 'wear'));
  const mask = useProject((s) => s.mask);
  const substrate = useProject((s) => s.substrate);
  const wearError = useProject((s) => s.wearError);
  const updateNode = useProject((s) => s.updateNode);
  const importMask = useProject((s) => s.importMask);
  const clearMask = useProject((s) => s.clearMask);
  const importSubstrate = useProject((s) => s.importSubstrate);
  const clearSubstrate = useProject((s) => s.clearSubstrate);
  const setSubstrateTileSize = useProject((s) => s.setSubstrateTileSize);
  const maskRef = useRef<HTMLInputElement>(null);
  const subRef = useRef<HTMLInputElement>(null);
  if (!node) return null;
  const w = node.params;
  const set = (patch: Partial<WearParams>) => updateNode<'wear'>(node.id, patch);
  // updateNodeParams merges shallowly, so the nested objects are passed whole.
  const setMask = (patch: Partial<WearParams['mask']>) => set({ mask: { ...w.mask, ...patch } });
  const setSub = (patch: Partial<WearParams['substrate']>) => set({ substrate: { ...w.substrate, ...patch } });
  const t = es.wear;
  // Hue, saturation, value and roughness shape only the interior; a loaded second material replaces it.
  const interiorOff = w.substrate.source === 'secondSet' && substrate !== null;

  return (
    <Section
      title={t.title}
      testId="wear-section"
      dimmed={!w.enabled}
      action={(
        <Switch
          checked={w.enabled} onCheckedChange={(enabled) => set({ enabled })}
          aria-label={`${t.enabled} ${t.title.toLowerCase()}`} title={t.enabledHint} data-testid="wear-enabled"
        />
      )}
    >
      <Row label={t.family} hint={t.familyHint}>
        <Select value={w.family} onValueChange={(v) => set({ family: v as WearFamily, userSetFamily: true })}>
          <SelectTrigger data-testid="wear-family" title={t.familyHint}><SelectValue /></SelectTrigger>
          <SelectContent>
            {FAMILIES.map((f) => (
              <SelectItem key={f} value={f}>{t.families[f]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <SliderField
        label={t.intensity} hint={t.intensityHint} value={w.intensity} min={0} max={1} step={0.01}
        onChange={(v) => set({ intensity: v })}
      />
      <LengthField label={t.width} hint={t.widthHint} valueM={w.widthM} unit="cm" onChange={(v) => set({ widthM: v })} />
      <LengthField
        label={t.minEdge} hint={t.minEdgeHint} valueM={w.minEdgeM} unit="mm" onChange={(v) => set({ minEdgeM: v })}
      />
      <LengthField label={t.size} hint={t.sizeHint} valueM={w.sizeM} unit="cm" onChange={(v) => set({ sizeM: v })} />
      <LengthField label={t.depth} hint={t.depthHint} valueM={w.depthM} unit="mm" onChange={(v) => set({ depthM: v })} />
      <LengthField label={t.band} hint={t.bandHint} valueM={w.bandM} unit="mm" onChange={(v) => set({ bandM: v })} />
      <LengthField label={t.micro} hint={t.microHint} valueM={w.microM} unit="mm" onChange={(v) => set({ microM: v })} />
      <SliderField
        label={t.pieceBias} hint={t.pieceBiasHint} value={w.pieceBias} min={0} max={1} step={0.01}
        onChange={(v) => set({ pieceBias: v })}
      />
      <SliderField
        label={t.edgeTone} hint={t.edgeToneHint} value={w.edgeTone} min={0} max={1} step={0.01}
        onChange={(v) => set({ edgeTone: v })}
      />
      <Row label={t.seed} hint={t.seedHint}>
        <NumField
          aria-label={t.seed}
          step={1}
          min={0}
          title={t.seedHint}
          value={w.seed}
          onCommit={(v) => v !== null && Number.isInteger(v) && v >= 0 && v <= 0xffffffff && set({ seed: v })}
        />
        <Button
          size="sm"
          title={t.reseed}
          aria-label={t.reseed}
          data-testid="wear-reseed"
          onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </Row>

      <Row label={t.mask} hint={t.maskHint}>
        <span
          className="min-w-0 flex-1 truncate text-zinc-400"
          title={mask?.name ?? t.maskNone}
          data-testid="wear-mask-name"
        >
          {mask?.name ?? t.maskNone}
        </span>
        <Button size="sm" title={t.maskHint} onClick={() => maskRef.current?.click()}>
          <FileImage className="h-3 w-3" />
          {t.import}
        </Button>
        {mask && (
          <Button size="sm" title={t.maskClear} aria-label={t.maskClear} data-testid="wear-mask-clear" onClick={clearMask}>
            <X className="h-3 w-3" />
          </Button>
        )}
        <input
          ref={maskRef}
          type="file"
          hidden
          accept="image/*"
          data-testid="wear-mask-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importMask(f);
          }}
        />
      </Row>
      {mask && (
        <>
          <SliderField
            label={t.maskStrength} hint={t.maskStrengthHint} value={w.mask.strength} min={0} max={1} step={0.01}
            onChange={(v) => setMask({ strength: v })}
          />
          <Row label={t.maskInvert} hint={t.maskInvertHint}>
            <input
              type="checkbox"
              className="h-3 w-3 accent-amber-500"
              aria-label={t.maskInvert}
              title={t.maskInvertHint}
              checked={w.mask.invert}
              onChange={(e) => setMask({ invert: e.target.checked })}
            />
          </Row>
        </>
      )}

      <Row label={t.substrateSource} hint={t.substrateSourceHint}>
        <Select
          value={w.substrate.source}
          onValueChange={(v) => setSub({ source: v as WearParams['substrate']['source'] })}
        >
          <SelectTrigger data-testid="substrate-source" title={t.substrateSourceHint}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="interior">{t.sources.interior}</SelectItem>
            <SelectItem value="secondSet">{t.sources.secondSet}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {w.substrate.source === 'secondSet' && (
        <Row label={t.secondSet} hint={t.secondSetHint}>
          <span
            className="min-w-0 flex-1 truncate text-zinc-400"
            title={substrate?.name ?? t.substrateNone}
            data-testid="substrate-name"
          >
            {substrate?.name ?? t.substrateNone}
          </span>
          <Button size="sm" title={t.secondSetHint} onClick={() => subRef.current?.click()}>
            <FileImage className="h-3 w-3" />
            {t.import}
          </Button>
          {substrate && (
            <Button
              size="sm" title={t.substrateClear} aria-label={t.substrateClear} data-testid="substrate-clear"
              onClick={clearSubstrate}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          <input
            ref={subRef}
            type="file"
            multiple
            hidden
            accept="image/*"
            data-testid="substrate-input"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (list.length > 0) void importSubstrate(list);
            }}
          />
        </Row>
      )}
      {w.substrate.source === 'secondSet' && substrate && (
        <Row label={t.substrateTile} hint={t.substrateTileHint}>
          <NumField
            aria-label={`${t.substrateTile} X`}
            min={0.01}
            title={t.substrateTileHint}
            value={substrate.gpu.settings.tileSizeM[0]}
            onCommit={(v) => v !== null && v > 0 && setSubstrateTileSize([v, substrate.gpu.settings.tileSizeM[1]])}
          />
          <NumField
            aria-label={`${t.substrateTile} Y`}
            min={0.01}
            title={t.substrateTileHint}
            value={substrate.gpu.settings.tileSizeM[1]}
            onCommit={(v) => v !== null && v > 0 && setSubstrateTileSize([substrate.gpu.settings.tileSizeM[0], v])}
          />
        </Row>
      )}
      <SliderField
        label={t.hue} hint={t.hueHint} disabled={interiorOff} value={w.substrate.hueShift} min={-180} max={180} step={1}
        onChange={(v) => setSub({ hueShift: v })}
      />
      <SliderField
        label={t.sat} hint={t.satHint} disabled={interiorOff} value={w.substrate.satMul} min={0} max={2} step={0.01}
        onChange={(v) => setSub({ satMul: v })}
      />
      <SliderField
        label={t.val} hint={t.valHint} disabled={interiorOff} value={w.substrate.valMul} min={0} max={2} step={0.01}
        onChange={(v) => setSub({ valMul: v })}
      />
      <SliderField
        label={t.rough} hint={t.roughHint} disabled={interiorOff} value={w.substrate.roughAdd} min={-1} max={1} step={0.01}
        onChange={(v) => setSub({ roughAdd: v })}
      />
      {wearError && <div className="text-red-400" data-testid="wear-error">{wearError}</div>}
    </Section>
  );
}
