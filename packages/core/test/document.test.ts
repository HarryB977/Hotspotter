import { describe, it, expect } from 'vitest';
import {
  createDefaultDoc, serializeDoc, parseDoc, toStack, resolveLayout, updateNodeParams, DocParseError,
  composeInputsFromDoc,
} from '../src/document';
import { pxPerMetre, rectSizeM } from '../src/layout';
import type { MaterialSettings } from '../src/material';
import { checkProportions } from '../src/period';

const material: MaterialSettings = {
  name: 'bricks',
  files: { baseColor: 'bricks_basecolor.png' },
  normalConvention: 'gl',
  roughnessIsGloss: false,
  tileSizeM: [0.6, 0.6],
  heightScaleM: 0.02,
  period: { x: 0.25, y: 0.075, phaseX: 0, phaseY: 0, cutAllowedX: false, cutAllowedY: false },
  allowRotation: false,
};

describe('project document', () => {
  it('round-trips through serialize/parse', () => {
    const doc = createDefaultDoc(material);
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it('rejects bad versions and shapes with DocParseError', () => {
    expect(() => parseDoc('{"version":2}')).toThrow(DocParseError);
    expect(() => parseDoc('not json')).toThrow(DocParseError);
    expect(() => parseDoc('{"version":1,"nodes":[],"edges":[{"from":"a","to":"b","port":"p"}]}')).toThrow(DocParseError);
  });

  it('projects the default doc to a 4-entry stack', () => {
    const stack = toStack(createDefaultDoc(material));
    expect(Array.isArray(stack) && stack.map((e) => e.type)).toEqual(['material', 'layout', 'placement', 'output']);
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
