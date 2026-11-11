import { describe, it, expect } from 'vitest';
import {
  createDefaultDoc, serializeDoc, parseDoc, toStack, resolveLayout, updateNodeParams, DocParseError,
} from '../src/document';
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
    doc = updateNodeParams<'output'>(doc, 'output', { groove: { widthM: 0.01, depthM: 0.002, profile: 'round' } });
    expect(resolveLayout(doc).groove.profile).toBe('round');
  });

  it('updateNodeParams does not mutate the original', () => {
    const doc = createDefaultDoc(material);
    const before = serializeDoc(doc);
    const next = updateNodeParams<'placement'>(doc, 'placement', { variation: 0.9 });
    expect(serializeDoc(doc)).toBe(before);
    expect(next.nodes.find((n) => n.id === 'placement')!.params).toEqual({ variation: 0.9, seed: 0 });
  });
});
