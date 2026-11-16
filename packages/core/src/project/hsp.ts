import { parseDoc, DocParseError } from '../document';
import type { ProjectDoc } from '../document';
import type { MaterialSettings } from '../material';
import { writeZip, readZip, HspError } from './zip';
import type { ProjectFile } from './zip';

export { HspError } from './zip';
export type { ProjectFile } from './zip';

export interface HspManifest {
  format: 'hotspotter-project';
  version: 1;
  savedAt: string;
  app: string;
  /** ProjectDoc JSON, migrated with parseDoc on open. */
  doc: unknown;
  material: { name: string; settings: MaterialSettings; files: string[] } | null;
  mask: { name: string; file: string } | null;
  substrate: { name: string; tileSizeM: [number, number]; files: string[] } | null;
}

const MANIFEST_PATH = 'project.json';
const DAMAGED = 'El proyecto está dañado';

export function packProject(p: {
  manifest: Omit<HspManifest, 'format' | 'version' | 'savedAt'>;
  resources: ProjectFile[];
}): Promise<Uint8Array> {
  const manifest: HspManifest = {
    format: 'hotspotter-project', version: 1, savedAt: new Date().toISOString(), ...p.manifest,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  // Original image bytes go in unchanged and uncompressed.
  return writeZip([
    { path: MANIFEST_PATH, bytes: json },
    ...p.resources.map((r) => ({ ...r, store: true })),
  ]);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export async function unpackProject(bytes: Uint8Array): Promise<{
  manifest: HspManifest; doc: ProjectDoc; resources: Map<string, Uint8Array>;
}> {
  const files = await readZip(bytes);
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry) throw new HspError(`${DAMAGED}: falta ${MANIFEST_PATH}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes));
  } catch {
    throw new HspError(`${DAMAGED}: no se puede leer ${MANIFEST_PATH}`);
  }
  if (!isObj(raw) || raw.format !== 'hotspotter-project') {
    throw new HspError('Este archivo no es un proyecto de Hotspotter');
  }
  if (typeof raw.version !== 'number' || raw.version > 1) {
    throw new HspError('Este proyecto es de una versión más nueva de Hotspotter');
  }
  if (raw.version !== 1) throw new HspError(`${DAMAGED}: versión no válida`);
  const material = raw.material ?? null;
  const mask = raw.mask ?? null;
  const substrate = raw.substrate ?? null;
  const shapeOk =
    typeof raw.savedAt === 'string' && typeof raw.app === 'string'
    && (material === null || (isObj(material) && isObj(material.settings) && isStrArray(material.files)))
    && (mask === null || (isObj(mask) && typeof mask.file === 'string'))
    && (substrate === null || (isObj(substrate) && isStrArray(substrate.files)));
  if (!shapeOk) throw new HspError(`${DAMAGED}: ${MANIFEST_PATH} está incompleto`);
  const manifest = { ...raw, material, mask, substrate } as unknown as HspManifest;

  let doc: ProjectDoc;
  try {
    doc = parseDoc(JSON.stringify(manifest.doc));
  } catch (e) {
    if (e instanceof DocParseError) throw new HspError(`${DAMAGED}: el diseño guardado no es válido`);
    throw e;
  }

  const resources = new Map<string, Uint8Array>();
  for (const f of files) if (f.path !== MANIFEST_PATH) resources.set(f.path, f.bytes);
  const needed = [
    ...(manifest.material?.files ?? []),
    ...(manifest.mask ? [manifest.mask.file] : []),
    ...(manifest.substrate?.files ?? []),
  ];
  for (const path of needed) {
    if (!resources.has(path)) throw new HspError(`Falta el archivo ${path} dentro del proyecto`);
  }
  return { manifest, doc, resources };
}
