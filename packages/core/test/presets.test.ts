import { describe, expect, it } from 'vitest';
import { PRESET_IDS, presetLayout } from '../src/presets';
import { pxPerMetre, validateLayout } from '../src/layout';

describe('presetLayout', () => {
  for (const id of PRESET_IDS) {
    describe(id, () => {
      const layout = presetLayout(id);

      it('is valid', () => {
        expect(validateLayout(layout)).toEqual([]);
      });

      it('covers at least 95% of the atlas', () => {
        const area = layout.rects.reduce((s, r) => s + r.w * r.h, 0);
        expect(area / (layout.widthPx * layout.heightPx)).toBeGreaterThanOrEqual(0.95);
      });

      it('has between 8 and 64 rects', () => {
        expect(layout.rects.length).toBeGreaterThanOrEqual(8);
        expect(layout.rects.length).toBeLessThanOrEqual(64);
      });

      it('is 512 px/m with defaults', () => {
        expect(layout.widthPx).toBe(4096);
        expect(layout.heightPx).toBe(4096);
        expect(pxPerMetre(layout)).toBe(512);
      });

      it('stays valid and full at other resolutions', () => {
        for (const w of [1024, 2048, 3000]) {
          const l = presetLayout(id, w);
          expect(validateLayout(l)).toEqual([]);
          const area = l.rects.reduce((s, r) => s + r.w * r.h, 0);
          expect(area).toBe(w * w);
        }
      });
    });
  }

  it('walls and frames forbid rotation', () => {
    for (const id of ['walls', 'frames'] as const) {
      expect(presetLayout(id).rects.every((r) => r.allowRotation === false)).toBe(true);
    }
  });

  it('trims has at least 3 tileU rects', () => {
    expect(presetLayout('trims').rects.filter((r) => r.tileU).length).toBeGreaterThanOrEqual(3);
  });

  it('walls at 2048 has half the coordinates of 4096 (within 1 px)', () => {
    const a = presetLayout('walls', 4096).rects;
    const b = presetLayout('walls', 2048).rects;
    expect(b.length).toBe(a.length);
    a.forEach((r, i) => {
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        expect(Math.abs(b[i][k] - r[k] / 2)).toBeLessThanOrEqual(1);
      }
    });
  });
});
