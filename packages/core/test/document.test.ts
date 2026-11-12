import { describe, it, expect } from 'vitest';
import {
  createDefaultDoc, serializeDoc, parseDoc, toStack, resolveLayout, updateNodeParams, DocParseError,
  composeInputsFromDoc,
} from '../src/document';
import { pxPerMetre, rectSizeM } from '../src/layout';
import type { MaterialSettings } from '../src/material';
import { checkProportions } from '../src/period';
import { DEFAULT_WEAR, DEFAULT_DIRT } from '../src/wear/params';

const material: MaterialSettings = {
  name: 'bricks',
  files: { baseColor: 'bricks_basecolor.png' },
  normalConvention: 'gl',
  roughnessIsGloss: false,
  tileSizeM: [0.6, 0.6],
  heightScaleM: 0.02,
  period: { x: 0.25, y: 0.075, phaseX: 0, phaseY: 0, cutAllowedX: false, cutAllowedY: false },
  allowRotation: false,
  orientation: { baseRotation: 0, rule: 'fixed' },
};

describe('project document', () => {
  it('round-trips through serialize/parse', () => {
    const doc = createDefaultDoc(material);
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it('migrates a groove without bevelM to widthM / 2', () => {
    const doc = createDefaultDoc(material);
    const json = JSON.parse(serializeDoc(doc));
    const g = json.nodes.find((n: { type: string }) => n.type === 'output').params.groove;
    g.widthM = 0.01;
    delete g.bevelM;
    const out = parseDoc(JSON.stringify(json));
    const migrated = out.nodes.find((n) => n.type === 'output')!.params as { groove: { bevelM: number } };
    expect(migrated.groove.bevelM).toBe(0.005);
  });

  it('rejects bad versions and shapes with DocParseError', () => {
    expect(() => parseDoc('{"version":2}')).toThrow(DocParseError);
    expect(() => parseDoc('not json')).toThrow(DocParseError);
    expect(() => parseDoc('{"version":1,"nodes":[],"edges":[{"from":"a","to":"b","port":"p"}]}')).toThrow(DocParseError);
  });

  it('projects the default doc to a 7-entry stack', () => {
    const doc = createDefaultDoc(material);
    expect(doc.nodes).toHaveLength(7);
    const stack = toStack(doc);
    expect(Array.isArray(stack) && stack.map((e) => e.type)).toEqual(
      ['material', 'structure', 'layout', 'placement', 'wear', 'dirt', 'output'],
    );
    expect(Array.isArray(stack) && stack.map((e) => e.label).slice(1, 2)).toEqual(['Estructura']);
  });

  it('migrates a v0.1-A document (4 nodes) to 7 chained nodes', () => {
    const old = {
      version: 1,
      nodes: [
        { id: 'material', type: 'material', params: { ...material } },
        { id: 'layout', type: 'layout', params: { mode: 'preset', preset: 'walls' } },
        { id: 'placement', type: 'placement', params: { variation: 0.5, seed: 0 } },
        { id: 'output', type: 'output', params: { resolutionPx: 4096, worldWidthM: 8, groove: { widthM: 0.01, bevelM: 0.005, depthM: 0.002, profile: 'round' } } },
      ],
      edges: [
        { from: 'material', to: 'layout', port: 'period' },
        { from: 'layout', to: 'placement', port: 'layout' },
        { from: 'placement', to: 'output', port: 'placement' },
      ],
    };
    const doc = parseDoc(JSON.stringify(old));
    expect(doc.nodes).toHaveLength(7);
    const stack = toStack(doc);
    expect(Array.isArray(stack) && stack.map((e) => e.type)).toEqual(
      ['material', 'structure', 'layout', 'placement', 'wear', 'dirt', 'output'],
    );
    expect(composeInputsFromDoc(doc, 512).wear).toEqual(DEFAULT_WEAR);
  });

  it('composeInputsFromDoc carries wear, dirt and structure', () => {
    const r = composeInputsFromDoc(createDefaultDoc(material), 512);
    expect(r.wear).toEqual(DEFAULT_WEAR);
    expect(r.dirt).toEqual(DEFAULT_DIRT);
    expect(r.structure).toEqual({ type: 'continuous', threshold: null, analyzed: false });
  });

  it('reports custom when the graph branches', () => {
    const doc = createDefaultDoc(material);
    doc.edges.push({ from: 'material', to: 'placement', port: 'material' });
    expect(toStack(doc)).toEqual({ custom: true });
  });

  it('resolves auto layouts with the material period', () => {
    let doc = createDefaultDoc(material);
    doc = updateNodeParams<'layout'>(doc, 'layout', { mode: 'auto', target: 'walls', seed: 3 });
    const l = resolveLayout(doc);
    expect(l.widthPx).toBe(4096);
    expect(checkProportions(l, material.period)).toEqual([]);
  });

  it('applies the output groove to the resolved layout', () => {
    let doc = createDefaultDoc(material);
    doc = updateNodeParams<'output'>(doc, 'output', { groove: { widthM: 0.01, bevelM: 0.005, depthM: 0.002, profile: 'round' } });
    expect(resolveLayout(doc).groove.profile).toBe('round');
  });

  it('updateNodeParams does not mutate the original', () => {
    const doc = createDefaultDoc(material);
    const before = serializeDoc(doc);
    const next = updateNodeParams<'placement'>(doc, 'placement', { variation: 0.9 });
    expect(serializeDoc(doc)).toBe(before);
    expect(next.nodes.find((n) => n.id === 'placement')!.params).toEqual({ variation: 0.9, seed: 0 });
  });

  it('resolveLayout honours a widthPx override', () => {
    const doc = createDefaultDoc(material);
    const l = resolveLayout(doc, { widthPx: 1024 });
    expect(l.widthPx).toBe(1024);
    expect(l.worldWidthM).toBe(8);
  });

  describe('composeInputsFromDoc', () => {
    const docs: [string, ReturnType<typeof createDefaultDoc>][] = [
      ['preset', createDefaultDoc(material)],
      ['auto', updateNodeParams<'layout'>(createDefaultDoc(material), 'layout', { mode: 'auto', target: 'walls', seed: 3 })],
    ];
    for (const [label, doc] of docs) {
      it(`gives the same rects in metres at 1024 and 4096 (${label})`, () => {
        const lo = composeInputsFromDoc(doc, 1024);
        const hi = composeInputsFromDoc(doc, 4096);
        expect(lo.layout.widthPx).toBe(1024);
        expect(hi.layout.widthPx).toBe(4096);
        expect(lo.layout.rects.length).toBe(hi.layout.rects.length);
        expect(lo.placements.length).toBe(lo.layout.rects.length);
        const onePxM = 1 / pxPerMetre(lo.layout);
        lo.layout.rects.forEach((r, i) => {
          const a = rectSizeM(lo.layout, r);
          const b = rectSizeM(hi.layout, hi.layout.rects[i]);
          expect(Math.abs(a.w - b.w), r.id).toBeLessThanOrEqual(onePxM);
          expect(Math.abs(a.h - b.h), r.id).toBeLessThanOrEqual(onePxM);
        });
      });
    }

    it('defaults to the output resolution and carries the material settings', () => {
      const r = composeInputsFromDoc(createDefaultDoc(material));
      expect(r.layout.widthPx).toBe(4096);
      expect(r.material).toEqual(material);
      expect(r.issues).toEqual(checkProportions(r.layout, material.period));
    });
  });
});

describe('material orientation in documents', () => {
  it('parseDoc adds the default orientation to older documents', () => {
    const doc = createDefaultDoc(material);
    const old = JSON.parse(serializeDoc(doc));
    delete old.nodes[0].params.orientation;
    const parsed = parseDoc(JSON.stringify(old));
    expect(parsed.nodes[0].params).toMatchObject({ orientation: { baseRotation: 0, rule: 'fixed' } });
  });
  it('composeInputsFromDoc exposes rotations and checks proportions with them', () => {
    const doc = updateNodeParams<'material'>(createDefaultDoc(material), 'material', {
      orientation: { baseRotation: 90, rule: 'fixed' },
    });
    const r = composeInputsFromDoc(doc, 1024);
    expect(r.rotations.size).toBe(r.layout.rects.length);
    expect([...r.rotations.values()].every(Boolean)).toBe(true);
    expect(r.issues).toEqual(checkProportions(r.layout, material.period, r.rotations));
  });
});
