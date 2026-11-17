// Fails unless every package.json (root and workspaces) matches the release tag.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** Directories of the root and of every workspace ("dir/*" patterns only). */
export function packageDirs(root) {
  const dirs = [root]
  for (const pattern of readJson(join(root, 'package.json')).workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const base = join(root, pattern.slice(0, -2))
      if (!existsSync(base)) continue
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(base, entry.name, 'package.json'))) {
          dirs.push(join(base, entry.name))
        }
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      dirs.push(join(root, pattern))
    }
  }
  return dirs
}

/** Returns the packages whose version differs from the tag (without the leading "v"). */
export function findMismatches(tag, root) {
  const expected = tag.replace(/^v/, '')
  const bad = []
  for (const dir of packageDirs(root)) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg.version !== expected) bad.push({ name: pkg.name ?? dir, version: pkg.version })
  }
  return bad
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  if (!tag) {
    console.error('Uso: node scripts/check-version.mjs v0.1.0')
    process.exit(1)
  }
  const root = resolve(fileURLToPath(import.meta.url), '..', '..')
  const bad = findMismatches(tag, root)
  if (bad.length > 0) {
    console.error(`La etiqueta ${tag} no coincide con la versión de estos package.json:`)
    for (const b of bad) console.error(`  - ${b.name}: ${b.version ?? '(sin versión)'}`)
    console.error(`Sube la versión de todos a ${tag.replace(/^v/, '')} antes de etiquetar.`)
    process.exit(1)
  }
  console.log(`Versión ${tag.replace(/^v/, '')} coincide en todos los package.json.`)
}
