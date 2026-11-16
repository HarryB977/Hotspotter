import { describe, it, expect } from 'vitest';
import { writeZip, readZip, crc32 } from '../src/project/zip';
import { packProject, unpackProject, HspError } from '../src/project/hsp';
import type { HspManifest } from '../src/project/hsp';
import { createDefaultDoc, serializeDoc, parseDoc } from '../src/document';
import type { MaterialSettings } from '../src/material';

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

const enc = new TextEncoder();
const noise = (n: number): Uint8Array => {
  const a = new Uint8Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s >>> 24; }
  return a;
};

const manifestBase = (doc: unknown): Omit<HspManifest, 'format' | 'version' | 'savedAt'> => ({
  app: 'hotspotter-test',
  doc,
  material: { name: 'bricks', settings: material, files: ['material/bricks_basecolor.png'] },
  mask: null,
  substrate: null,
});

const goodPack = () => packProject({
  manifest: manifestBase(createDefaultDoc(material)),
  resources: [{ path: 'material/bricks_basecolor.png', bytes: noise(500) }],
});

/** Rebuild a project zip with a replaced project.json. */
async function withProjectJson(bytes: Uint8Array, json: string): Promise<Uint8Array> {
  const files = (await readZip(bytes)).filter((f) => f.path !== 'project.json');
  return writeZip([{ path: 'project.json', bytes: enc.encode(json) }, ...files]);
}

describe('zip codec', () => {
  it('CRC-32 of "123456789" is 0xCBF43926', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips stored and deflated files byte for byte', async () => {
    const files = [
      { path: 'a/noise.bin', bytes: noise(2000) },
      { path: 'text.txt', bytes: enc.encode('hola '.repeat(500)) },
      { path: 'ñandú/zeros.bin', bytes: new Uint8Array(4096) },
      { path: 'empty.bin', bytes: new Uint8Array(0) },
    ];
    const zip = await writeZip(files);
    expect(zip.length).toBeLessThan(2000 + 2500 + 600);
    const back = await readZip(zip);
    expect(back.map((f) => f.path)).toEqual(files.map((f) => f.path));
    back.forEach((f, i) => expect(Array.from(f.bytes)).toEqual(Array.from(files[i].bytes)));
    const stored = await writeZip(files, { deflate: false });
    expect((await readZip(stored))[1].bytes).toEqual(files[1].bytes);
    expect(stored.length).toBeGreaterThan(zip.length);
  });

  it('rejects a flipped data byte, a bad signature and truncation with HspError', async () => {
    const zip = await writeZip([{ path: 'x.bin', bytes: noise(300) }], { deflate: false });
    const bad = zip.slice();
    bad[30 + 5 + 10] ^= 0xff;
    await expect(readZip(bad)).rejects.toBeInstanceOf(HspError);
    await expect(readZip(enc.encode('not a zip at all, definitely'))).rejects.toBeInstanceOf(HspError);
    await expect(readZip(zip.slice(0, zip.length - 10))).rejects.toBeInstanceOf(HspError);
    const badDeflate = await writeZip([{ path: 'y.txt', bytes: enc.encode('abc'.repeat(300)) }]);
    badDeflate[30 + 5 + 4] ^= 0xff;
    await expect(readZip(badDeflate)).rejects.toBeInstanceOf(HspError);
  });
});

describe('.hsp project', () => {
  it('round-trips manifest, doc and resources', async () => {
    const doc = createDefaultDoc(material);
    const bytes = noise(500);
    const zip = await packProject({
      manifest: manifestBase(doc),
      resources: [{ path: 'material/bricks_basecolor.png', bytes }],
    });
    const out = await unpackProject(zip);
    expect(out.manifest).toMatchObject({ ...manifestBase(doc), format: 'hotspotter-project', version: 1 });
    expect(typeof out.manifest.savedAt).toBe('string');
    expect(out.doc).toEqual(parseDoc(serializeDoc(doc)));
    expect(Array.from(out.resources.get('material/bricks_basecolor.png')!)).toEqual(Array.from(bytes));
    expect(out.resources.has('project.json')).toBe(false);
  });

  it('migrates a v0.1-A doc (4 nodes) to 7 nodes', async () => {
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
    const zip = await packProject({
      manifest: manifestBase(old),
      resources: [{ path: 'material/bricks_basecolor.png', bytes: noise(10) }],
    });
    expect((await unpackProject(zip)).doc.nodes).toHaveLength(7);
  });

  it('fails with a Spanish HspError when a named resource is missing', async () => {
    const zip = await packProject({ manifest: manifestBase(createDefaultDoc(material)), resources: [] });
    const err = await unpackProject(zip).catch((e) => e);
    expect(err).toBeInstanceOf(HspError);
    expect(err.message).toMatch(/falta/i);
  });

  it('fails when project.json is absent, malformed or has a bad doc', async () => {
    const zip = await goodPack();
    const noJson = await writeZip((await readZip(zip)).filter((f) => f.path !== 'project.json'));
    expect(await unpackProject(noJson).catch((e) => e)).toBeInstanceOf(HspError);
    const malformed = await withProjectJson(zip, '{ nope');
    const e1 = await unpackProject(malformed).catch((e) => e);
    expect(e1).toBeInstanceOf(HspError);
    expect(e1.message).toMatch(/dañado/);
    const m = { ...manifestBase({ version: 1, nodes: 'x' }), format: 'hotspotter-project', version: 1, savedAt: 'x' };
    const badDoc = await unpackProject(await withProjectJson(zip, JSON.stringify(m))).catch((e) => e);
    expect(badDoc).toBeInstanceOf(HspError);
  });

  it('rejects a newer version and a foreign format', async () => {
    const zip = await goodPack();
    const m = { ...manifestBase(createDefaultDoc(material)), format: 'hotspotter-project', savedAt: 'x' };
    const e2 = await unpackProject(await withProjectJson(zip, JSON.stringify({ ...m, version: 2 }))).catch((e) => e);
    expect(e2).toBeInstanceOf(HspError);
    expect(e2.message).toMatch(/versión/);
    const e3 = await unpackProject(await withProjectJson(zip, JSON.stringify({ ...m, format: 'other', version: 1 }))).catch((e) => e);
    expect(e3).toBeInstanceOf(HspError);
  });
});
