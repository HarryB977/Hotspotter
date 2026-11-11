import { describe, it, expect } from 'vitest';
import { classifyMapFile, materialNameFromFiles, chooseMaps, MAP_DEFAULTS } from '../src/material';

const BRICKS = [
  'bricks_wall_13_ambientocclusion_1k.png',
  'bricks_wall_13_basecolor_1k.png',
  'bricks_wall_13_height_1k.png',
  'bricks_wall_13_metallic_1k.png',
  'bricks_wall_13_normal_dx_1k.png',
  'bricks_wall_13_normal_gl_1k.png',
  'bricks_wall_13_roughness_1k.png',
];

describe('classifyMapFile', () => {
  it('detects base color variants', () => {
    expect(classifyMapFile('bricks_wall_13_basecolor_1k.png')).toEqual({ kind: 'baseColor' });
    expect(classifyMapFile('concrete_wall_01_color_1k.png')).toEqual({ kind: 'baseColor' });
    expect(classifyMapFile('grass_07_baseColor_1k.png')).toEqual({ kind: 'baseColor' });
  });
  it('detects normal convention', () => {
    expect(classifyMapFile('bricks_wall_13_normal_gl_1k.png')).toEqual({ kind: 'normal', normalConvention: 'gl' });
    expect(classifyMapFile('bricks_wall_13_normal_dx_1k.png')).toEqual({ kind: 'normal', normalConvention: 'dx' });
    expect(classifyMapFile('x_normal.png')).toEqual({ kind: 'normal' });
  });
  it('detects ambient occlusion spellings', () => {
    for (const f of [
      'bricks_wall_13_ambientocclusion_1k.png',
      'concrete_wall_01_ambient_occlusion_1k.png',
      'grass_07_ambientOcclusion_1k.png',
    ]) expect(classifyMapFile(f)).toEqual({ kind: 'ao' });
  });
  it('detects height', () => {
    expect(classifyMapFile('bricks_wall_13_height_1k.png')).toEqual({ kind: 'height' });
    expect(classifyMapFile('bricks_disp.png')).toEqual({ kind: 'height' });
  });
  it('detects roughness and gloss', () => {
    expect(classifyMapFile('bricks_wall_13_roughness_1k.png')).toEqual({ kind: 'roughness' });
    expect(classifyMapFile('bricks_gloss.png')).toEqual({ kind: 'roughness', isGloss: true });
    expect(classifyMapFile('bricks_smoothness.png')).toEqual({ kind: 'roughness', isGloss: true });
  });
  it('detects metallic and rejects unknown files', () => {
    expect(classifyMapFile('bricks_wall_13_metallic_1k.png')).toEqual({ kind: 'metallic' });
    expect(classifyMapFile('readme.txt')).toBeNull();
  });
});

describe('materialNameFromFiles', () => {
  it('returns the common prefix without map suffix or resolution', () => {
    expect(materialNameFromFiles(BRICKS)).toBe('bricks_wall_13');
  });
});

describe('chooseMaps', () => {
  it('prefers gl when both normals exist', () => {
    const r = chooseMaps(BRICKS);
    expect(r.normalConvention).toBe('gl');
    expect(r.files.normal).toBe('bricks_wall_13_normal_gl_1k.png');
    expect(r.files.baseColor).toBe('bricks_wall_13_basecolor_1k.png');
    expect(r.files.ao).toBe('bricks_wall_13_ambientocclusion_1k.png');
  });
  it('uses dx when only dx exists, gl when no normal', () => {
    expect(chooseMaps(['a_normal_dx_1k.png']).normalConvention).toBe('dx');
    expect(chooseMaps(['a_height_1k.png']).normalConvention).toBe('gl');
  });
});

describe('MAP_DEFAULTS', () => {
  it('has the documented fallbacks', () => {
    expect(MAP_DEFAULTS).toEqual({
      height: 0.5, normal: [0.5, 0.5, 1], roughness: 0.5, metallic: 0, ao: 1, opacity: 1,
    });
  });
});
