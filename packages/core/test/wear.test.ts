import { describe, it, expect } from 'vitest';
import { DEFAULT_WEAR, DEFAULT_DIRT, WEAR_FAMILIES, proposeFamily } from '../src/wear/params';

describe('wear params', () => {
  it('DEFAULT_WEAR matches the constraints', () => {
    expect(DEFAULT_WEAR).toEqual({
      enabled: true, family: 'brittle', userSetWearSize: false, intensity: 0.5, widthM: 0.04, minEdgeM: 0.004, sizeM: 0.03, depthM: 0.006,
      bandM: 0.006, microM: 0.0005, pieceBias: 0.7, seed: 0, edgeTone: 0.3,
      mask: { enabled: false, strength: 1, invert: false },
      substrate: { source: 'interior', hueShift: 0, satMul: 0.7, valMul: 0.8, roughAdd: 0.2 },
    });
    // Runoff off by default (user decision 2026-11-13): mirroring stays free unless the user asks for streaks.
    expect(DEFAULT_DIRT).toEqual({
      enabled: true, cavity: 0.4, runoff: 0, runoffLengthM: 0.4, tint: [0.25, 0.22, 0.18],
    });
  });

  it('families have their exact shapes', () => {
    expect(WEAR_FAMILIES).toEqual({
      brittle: { cellMix: 1, anisotropy: 1, steps: 0, loses: true, polish: 0.2 },
      chipping: { cellMix: 0.6, anisotropy: 1, steps: 2, loses: true, polish: 0.1 },
      splinter: { cellMix: 1, anisotropy: 4, steps: 0, loses: true, polish: 0.1 },
      erosion: { cellMix: 0, anisotropy: 1, steps: 0, loses: true, polish: 0 },
      dent: { cellMix: 0.3, anisotropy: 1, steps: 0, loses: false, polish: 0.6 },
      edgeOnly: { cellMix: 0, anisotropy: 1, steps: 0, loses: false, polish: 1 },
    });
  });

  it('proposes a family from the material type and name', () => {
    expect(proposeFamily('continuous', 'metal_01')).toBe('dent');
    expect(proposeFamily('continuous', 'Pintura_azul')).toBe('chipping');
    expect(proposeFamily('continuous', 'concrete')).toBe('erosion');
    expect(proposeFamily('pieces', 'x')).toBe('brittle');
    expect(proposeFamily('directional', 'x')).toBe('splinter');
  });
});
