import { afterEach, describe, expect, it, vi } from 'vitest';
import { HspError, MAX_PROJECT_UPLOAD_BYTES, createDefaultDoc } from '@hotspotter/core';
import type { MaterialSettings } from '@hotspotter/core';
import { UploadError, hspFileName, packHsp, putFile, unpackHsp } from '../src/project/projectIo';

const settings: MaterialSettings = {
  name: 'bricks',
  files: { baseColor: 'bricks_basecolor.png' },
  normalConvention: 'gl',
  roughnessIsGloss: false,
  tileSizeM: [1, 1],
  heightScaleM: 0.02,
  period: { x: 0, y: 0, phaseX: 0, phaseY: 0, cutAllowedX: true, cutAllowedY: true },
  allowRotation: false,
  orientation: { baseRotation: 0, rule: 'fixed' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('packHsp', () => {
  it('refuses a project over the upload limit before reading any image (R44)', async () => {
    const read = vi.fn(() => Promise.reject(new Error('must not be read')));
    const huge = { name: 'bricks_basecolor.png', size: MAX_PROJECT_UPLOAD_BYTES + 1, arrayBuffer: read } as unknown as File;
    const p = packHsp({ doc: createDefaultDoc(settings), settings, materialFiles: [huge], mask: null, substrate: null });
    await expect(p).rejects.toBeInstanceOf(HspError);
    await expect(p).rejects.toThrow('más de 512 MB');
    expect(read).not.toHaveBeenCalled();
  });

  it('round-trips the document, the material files, the mask and the second set', async () => {
    const bc = new File([new Uint8Array([1, 2, 3])], 'bricks_basecolor.png');
    const extra = new File([new Uint8Array([4])], 'bricks_normal_dx.png');
    const mask = new File([new Uint8Array([5, 6])], 'mask.png');
    const sub = new File([new Uint8Array([7])], 'concrete_color.png');
    const doc = createDefaultDoc(settings);
    const bytes = await packHsp({
      doc, settings, materialFiles: [bc, extra, bc], mask: { name: 'mask.png', file: mask },
      substrate: { name: 'concrete', tileSizeM: [2, 2], files: [sub] },
    });
    const c = await unpackHsp(new File([bytes], 'p.hsp'));
    expect(c.doc).toEqual(doc);
    expect(c.materialFiles.map((f) => f.name)).toEqual(['bricks_basecolor.png', 'bricks_normal_dx.png']);
    expect([...new Uint8Array(await c.materialFiles[0].arrayBuffer())]).toEqual([1, 2, 3]);
    expect(c.mask?.name).toBe('mask.png');
    expect(c.substrate).toMatchObject({ name: 'concrete', tileSizeM: [2, 2] });
  });
});

describe('unpackHsp', () => {
  it('refuses a file over 4 GiB without reading it (a zip without zip64 cannot be larger)', async () => {
    const read = vi.fn(() => Promise.reject(new Error('must not be read')));
    const huge = { name: 'p.hsp', size: 0xffffffff + 1, arrayBuffer: read } as unknown as File;
    const p = unpackHsp(huge);
    await expect(p).rejects.toBeInstanceOf(HspError);
    await expect(p).rejects.toThrow('demasiado grande');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('putFile', () => {
  it('turns the server 413 into a Spanish message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Payload Too Large"}', { status: 413 })));
    const p = putFile('C:\\x', 'a.hsp', new Uint8Array(1));
    await expect(p).rejects.toBeInstanceOf(UploadError);
    await expect(p).rejects.toThrow('demasiado grande para guardarlo (máximo 512 MB)');
  });
});

describe('hspFileName', () => {
  it('appends .hsp once', () => {
    expect(hspFileName(' muro ')).toBe('muro.hsp');
    expect(hspFileName('muro.HSP')).toBe('muro.HSP');
  });
});
