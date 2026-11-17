// Prints the CHANGELOG.md section of one version plus a fixed Spanish footer.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FOOTER = [
  'Cierra Hotspotter antes de sobrescribir la carpeta.',
  'Si Windows muestra SmartScreen: Más información → Ejecutar de todas formas.',
].join('\n\n')

/** Text of the `## [version]` section, up to the next `## [`; null if missing. */
export function extractSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n').trim()
}

export function buildNotes(changelog, version) {
  const section = extractSection(changelog, version)
  return section === null ? null : `${section}\n\n${FOOTER}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? '').replace(/^v/, '')
  if (!version) {
    console.error('Uso: node scripts/release-notes.mjs 0.1.0 [ruta/CHANGELOG.md]')
    process.exit(1)
  }
  const file = process.argv[3] ?? resolve(fileURLToPath(import.meta.url), '..', '..', 'CHANGELOG.md')
  const notes = buildNotes(readFileSync(file, 'utf8'), version)
  if (notes === null) {
    console.error(`CHANGELOG.md no tiene una sección "## [${version}]".`)
    process.exit(1)
  }
  process.stdout.write(notes)
}
