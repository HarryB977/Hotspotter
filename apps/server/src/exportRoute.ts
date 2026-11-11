import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

const hasDotDotSegment = (value: string): boolean => value.split(/[\\/]/).includes('..');

/** Returns an error message when the target is unsafe, otherwise null. */
function validate(dir: unknown, name: unknown): string | null {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return 'Ruta no válida: la carpeta debe ser absoluta';
  if (hasDotDotSegment(dir)) return 'Ruta no válida: la carpeta contiene ".."';
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') {
    return 'Nombre de archivo no válido';
  }
  if (/[\\/]/.test(name) || hasDotDotSegment(name)) return 'Nombre de archivo no válido';
  return null;
}

export function registerExportRoute(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_EXPORT_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.put<{ Querystring: { dir?: string; name?: string } }>(
    '/api/export/file',
    { bodyLimit: MAX_EXPORT_BYTES },
    async (req, reply) => {
      const { dir, name } = req.query;
      const problem = validate(dir, name);
      if (problem) return reply.code(400).send({ error: problem });
      await mkdir(dir!, { recursive: true });
      const target = path.join(dir!, name!);
      await writeFile(target, req.body as Buffer);
      return { path: target };
    },
  );
}
