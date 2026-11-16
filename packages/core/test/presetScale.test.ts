import { describe, expect, it } from 'vitest';
import {
  buildShape, DEFAULT_GROOVE, faceBrickScale, fitFaces, makeRect, presetLayout, STOREY_HEIGHT_M, validateLayout,
} from '../src';
import type { HotspotFit, HotspotLayout, ShapeFace, TestShape } from '../src';

const NO_ROT = new Map<string, boolean>();
const TOLERANCE = 0.1;

const face = (widthM: number, heightM: number): ShapeFace => ({
  quad: { widthM, heightM, useOn: 'walls' },
  corners: [[0, 0, 0], [widthM, 0, 0], [widthM, heightM, 0], [0, heightM, 0]],
  normal: [0, 0, 1],
  part: 'wall',
});

const fit = (rectId: string, rotated: boolean, tiled: boolean): HotspotFit => ({
  rectId, rotated, tiled, mirrorX: false, mirrorY: false, score: 0,
  uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
});

describe('faceBrickScale', () => {
  // 1 m = 100 px.
  const layout: HotspotLayout = {
    version: 1, widthPx: 1000, heightPx: 1000, worldWidthM: 10, groove: { ...DEFAULT_GROOVE },
    rects: [
      makeRect({ id: 'a', x: 0, y: 0, w: 200, h: 100 }),
      makeRect({ id: 'u', x: 0, y: 100, w: 1000, h: 50, tileU: true }),
      makeRect({ id: 'v', x: 900, y: 0, w: 100, h: 1000, tileV: true }),
    ],
  };

  it('divides face metres by rect metres on each face axis', () => {
    expect(faceBrickScale(face(3, 0.5), fit('a', false, false), layout)).toEqual([1.5, 0.5]);
  });

  it('swaps the rect sides when the fit is turned', () => {
    expect(faceBrickScale(face(3, 0.5), fit('a', true, false), layout)).toEqual([3, 0.25]);
  });

  it('counts the tiling axis as 1', () => {
    expect(faceBrickScale(face(7, 0.4), fit('u', false, true), layout)).toEqual([1, 0.8]);
    expect(faceBrickScale(face(7, 0.4), fit('u', true, true), layout)).toEqual([14, 1]);
    expect(faceBrickScale(face(0.5, 9), fit('v', false, true), layout)).toEqual([0.5, 1]);
  });

  it('throws on a rect that is not in the layout', () => {
    expect(() => faceBrickScale(face(1, 1), fit('zz', false, false), layout)).toThrow(RangeError);
  });
});

/** Faces the walls preset must texture at brick scale: walls of the walls, columns and bodies, plus the cube's top. */
function coveredFaces(shape: TestShape): { face: ShapeFace; index: number }[] {
  const faces = buildShape(shape);
  return faces
    .map((face, index) => ({ face, index }))
    .filter(({ face }) =>
      (['wall', 'columns', 'body'].includes(face.part) && face.quad.useOn === 'walls') ||
      (shape === 'cube' && face.normal[1] > 0));
}

/** Ratio failures (|r − 1| > TOLERANCE on either axis) of `faces[index]` fitted with seeds 0..7, runoff off and on. */
function scaleFailures(label: string, faces: ShapeFace[], indices: number[], layout: HotspotLayout): string[] {
  const failures: string[] = [];
  for (const runoff of [false, true]) {
    for (let seed = 0; seed < 8; seed++) {
      const fits = fitFaces(faces, layout, NO_ROT, { seed, runoff });
      for (const index of indices) {
        const face = faces[index], f = fits[index];
        const [ru, rv] = faceBrickScale(face, f, layout);
        if (Math.abs(ru - 1) > TOLERANCE || Math.abs(rv - 1) > TOLERANCE) {
          failures.push(
            `${layout.widthPx} px ${label} face ${index} (${face.quad.widthM.toFixed(2)} x ${face.quad.heightM.toFixed(2)} m) ` +
            `seed ${seed} runoff ${runoff}: ${f.rectId}${f.tiled ? ' tiled' : ''} ratios ${ru.toFixed(3)}, ${rv.toFixed(3)}`,
          );
        }
      }
    }
  }
  return [...new Set(failures)];
}

const shapes: TestShape[] = ['cube', 'wallWithOpenings', 'corridor'];

it('covers the expected faces', () => {
  expect(coveredFaces('cube')).toHaveLength(5);
  // Front, back, two ends; two columns with front and two sides each.
  expect(coveredFaces('wallWithOpenings')).toHaveLength(10);
  // Two walls; six columns with front and two sides each.
  expect(coveredFaces('corridor')).toHaveLength(20);
  for (const s of shapes) {
    for (const { face } of coveredFaces(s)) {
      if (face.part !== 'body') expect(face.quad.heightM).toBeCloseTo(STOREY_HEIGHT_M, 9);
    }
  }
});

for (const widthPx of [1024, 2048, 4096]) {
  describe(`walls preset keeps brick scale at ${widthPx} px`, () => {
    const layout = presetLayout('walls', widthPx);

    it('is a valid layout', () => {
      expect(validateLayout(layout)).toEqual([]);
    });

    it('has no rect the matcher could take (±25 %) that is more than 10 % off a covered face', () => {
      const mPerPx = layout.worldWidthM / layout.widthPx;
      const bad: string[] = [];
      for (const s of shapes) {
        for (const { face } of coveredFaces(s)) {
          for (const r of layout.rects) {
            const ru = face.quad.widthM / (r.w * mPerPx), rv = face.quad.heightM / (r.h * mPerPx);
            const within = (x: number, t: number) => Math.abs(Math.log(x)) <= Math.log(1 + t) + 1e-5;
            if (within(ru, 0.25) && within(rv, 0.25) && !(Math.abs(ru - 1) <= TOLERANCE && Math.abs(rv - 1) <= TOLERANCE)) {
              bad.push(`${s} ${face.quad.widthM} x ${face.quad.heightM}: ${r.id}`);
            }
          }
        }
      }
      expect([...new Set(bad)]).toEqual([]);
    });

    it(`stays within ${TOLERANCE * 100} % on both axes of every covered face`, () => {
      const failures = shapes.flatMap((shape) =>
        scaleFailures(shape, buildShape(shape), coveredFaces(shape).map((c) => c.index), layout));
      expect(failures).toEqual([]);
    });

    it(`keeps storey walls of any length within ${TOLERANCE * 100} %`, () => {
      const lengths = [0.5, 0.8, 1.2, 2.0, 2.5, 3.4, 4.5, 7];
      const faces = lengths.map((l) => face(l, STOREY_HEIGHT_M));
      expect(scaleFailures('storey wall', faces, faces.map((_, i) => i), layout)).toEqual([]);
    });
  });
}
