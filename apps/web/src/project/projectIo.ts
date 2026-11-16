import { HspError, MAX_PROJECT_UPLOAD_BYTES, packProject, unpackProject } from '@hotspotter/core';
import type { MaterialSettings, ProjectDoc, ProjectFile } from '@hotspotter/core';
import { es } from '../i18n/es';

/** Thrown with the server's message when a write is rejected. */
export class UploadError extends Error {}

/** Writes one file through the local server (PUT /api/export/file) and returns the written path. */
export async function putFile(dir: string, name: string, body: Blob | string | Uint8Array): Promise<string> {
  const q = new URLSearchParams({ dir, name });
  const res = await fetch(`/api/export/file?${q}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Hotspotter': '1' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  });
  // The server refuses bodies over its upload limit before the route runs, with an English message.
  if (res.status === 413) throw new UploadError(es.uploadTooBig(MAX_PROJECT_UPLOAD_BYTES / 2 ** 20));
  const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !json.path) throw new UploadError(json.error ?? `HTTP ${res.status}`);
  return json.path;
}

const HSP_EXT = /\.hsp$/i;

/** The project file name for what the user typed: trimmed, with `.hsp` appended when missing. */
export function hspFileName(name: string): string {
  const n = name.trim();
  return HSP_EXT.test(n) ? n : `${n}.hsp`;
}

/** The name shown for a project file: without `.hsp`. */
export function projectTitle(fileName: string): string {
  return fileName.replace(HSP_EXT, '');
}

/** What a project file holds besides the document: the original image files. */
export interface ProjectContents {
  doc: ProjectDoc;
  /** The material's settings (the material node's params). */
  settings: MaterialSettings;
  /** The material's original files; the maps in `settings.files` are among them. */
  materialFiles: File[];
  mask: { name: string; file: File } | null;
  substrate: { name: string; tileSizeM: [number, number]; files: File[] } | null;
}

/** First file of each name: the archive cannot hold two entries at one path. */
function uniqueByName(files: File[]): File[] {
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.name) && seen.add(f.name));
}

/**
 * Packs the project into `.hsp` bytes. Refuses (Spanish HspError) a project over the server's upload limit (R44),
 * before reading any image when the sizes already exceed it.
 */
export async function packHsp(c: ProjectContents): Promise<Uint8Array> {
  const material = uniqueByName(c.materialFiles);
  const substrate = c.substrate ? uniqueByName(c.substrate.files) : [];
  const entries: [string, File][] = [
    ...material.map((f): [string, File] => [`material/${f.name}`, f]),
    ...(c.mask ? [[`mask/${c.mask.file.name}`, c.mask.file] as [string, File]] : []),
    ...substrate.map((f): [string, File] => [`substrate/${f.name}`, f]),
  ];
  const manifest = {
    app: 'Hotspotter',
    doc: c.doc,
    material: { name: c.settings.name, settings: c.settings, files: material.map((f) => `material/${f.name}`) },
    mask: c.mask ? { name: c.mask.name, file: `mask/${c.mask.file.name}` } : null,
    substrate: c.substrate
      ? { name: c.substrate.name, tileSizeM: c.substrate.tileSizeM, files: substrate.map((f) => `substrate/${f.name}`) }
      : null,
  };
  const tooBig = () => new HspError(es.project.tooBig(MAX_PROJECT_UPLOAD_BYTES / 2 ** 20));
  // Images are stored as they are, so their sizes already bound the file from below.
  if (entries.reduce((n, [, f]) => n + f.size, 0) > MAX_PROJECT_UPLOAD_BYTES) throw tooBig();
  const resources: ProjectFile[] = await Promise.all(
    entries.map(async ([path, f]) => ({ path, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
  const bytes = await packProject({ manifest, resources });
  if (bytes.length > MAX_PROJECT_UPLOAD_BYTES) throw tooBig();
  return bytes;
}

function fileAt(resources: Map<string, Uint8Array>, path: string, prefix: string): File {
  const bytes = resources.get(path);
  if (!bytes) throw new HspError(es.project.missingFile(path));
  return new File([bytes as BlobPart], path.slice(prefix.length));
}

/** Reads a `.hsp` file; the document is migrated by parseDoc. Throws HspError (Spanish) on a bad file. */
export async function unpackHsp(file: File): Promise<ProjectContents> {
  const { manifest, doc, resources } = await unpackProject(new Uint8Array(await file.arrayBuffer()));
  if (!manifest.material) throw new HspError(es.project.noMaterial);
  const node = doc.nodes.find((n) => n.type === 'material');
  // The document's material node is migrated with it; the manifest copy is the fallback.
  const settings = (node?.params ?? manifest.material.settings) as MaterialSettings;
  const materialFiles = manifest.material.files.map((p) => fileAt(resources, p, 'material/'));
  for (const name of Object.values(settings.files)) {
    if (!materialFiles.some((f) => f.name === name)) throw new HspError(es.project.missingFile(`material/${name}`));
  }
  const sub = manifest.substrate;
  const tile = sub?.tileSizeM;
  if (sub && !(Array.isArray(tile) && tile.length === 2 && tile.every((t) => typeof t === 'number' && t > 0))) {
    throw new HspError(es.project.damaged);
  }
  return {
    doc,
    settings,
    materialFiles,
    mask: manifest.mask
      ? {
        name: typeof manifest.mask.name === 'string' ? manifest.mask.name : manifest.mask.file.slice('mask/'.length),
        file: fileAt(resources, manifest.mask.file, 'mask/'),
      }
      : null,
    substrate: sub
      ? {
        name: typeof sub.name === 'string' ? sub.name : '',
        tileSizeM: [sub.tileSizeM[0], sub.tileSizeM[1]],
        files: sub.files.map((p) => fileAt(resources, p, 'substrate/')),
      }
      : null,
  };
}
