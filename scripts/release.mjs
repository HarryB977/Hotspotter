// One-command release: bumps every package.json, dates the CHANGELOG "Sin publicar" notes,
// commits, tags and pushes. The tag push triggers .github/workflows/release.yml.
// Usage: npm run release <patch|minor|major|X.Y.Z[-pre]> [--sin-tests] [--si]
// Passing the current version tags it without bumping (first release, or a tag that never got pushed).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { findMismatches, packageDirs } from './check-version.mjs'
import { extractSection } from './release-notes.mjs'

export const UNRELEASED = '## [Sin publicar]'
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parse(text) {
  const m = SEMVER.exec(text)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

function format(v) {
  return `${v.core.join('.')}${v.pre ? `-${v.pre}` : ''}`
}

/** Semver precedence: negative when a < b. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const pa = a.pre.split('.')
  const pb = b.pre.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1
    if (pb[i] === undefined) return 1
    const na = /^\d+$/.test(pa[i])
    const nb = /^\d+$/.test(pb[i])
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i])
    if (na !== nb) return na ? -1 : 1
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/** Resolves "patch" | "minor" | "major" | "X.Y.Z[-pre]" against the current version. */
export function nextVersion(current, arg) {
  const cur = parse(current)
  if (!cur) throw new Error(`La versión actual "${current}" no es semver.`)
  const [ma, mi, pa] = cur.core
  const bumped = {
    patch: [ma, mi, cur.pre ? pa : pa + 1],
    minor: [ma, mi + 1, 0],
    major: [ma + 1, 0, 0],
  }[arg]
  const next = bumped ? { core: bumped, pre: null } : parse(arg)
  if (!next) {
    throw new Error(`"${arg}" no es una versión válida. Usa patch, minor, major o X.Y.Z.`)
  }
  if (compare(next, cur) <= 0) {
    throw new Error(`La versión ${format(next)} tiene que ser mayor que la actual (${current}).`)
  }
  return format(next)
}

/** Moves the "Sin publicar" notes under a dated "## [version]" heading and leaves the unreleased heading empty. */
export function promoteUnreleased(changelog, version, date) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n'
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === UNRELEASED)
  if (start === -1) throw new Error(`CHANGELOG.md no tiene la sección "${UNRELEASED}".`)
  if (lines.some((l) => l.startsWith(`## [${version}]`))) {
    throw new Error(`CHANGELOG.md ya tiene una sección para ${version}.`)
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end)
  while (body.length > 0 && body[0].trim() === '') body.shift()
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  if (body.length === 0) {
    throw new Error(`"${UNRELEASED}" no tiene notas. Escribe en CHANGELOG.md qué cambia en esta versión.`)
  }
  return [
    ...lines.slice(0, start + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    ...body,
    '',
    ...lines.slice(end),
  ].join(eol)
}

/** Rewrites the first top-level "version" field, keeping the rest of the file byte for byte. */
export function setVersion(pkgText, version) {
  const re = /^(\s*"version"\s*:\s*")[^"]*(")/m
  if (!re.test(pkgText)) throw new Error('El package.json no tiene campo "version".')
  return pkgText.replace(re, `$1${version}$2`)
}

// ---------------------------------------------------------------- CLI

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd === 'npm',
    ...opts,
  })
  if (res.status !== 0) {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
    throw new Error(`Falló "${cmd} ${args.join(' ')}"${out ? `:\n${out}` : ''}`)
  }
  return (res.stdout ?? '').trim()
}

const git = (...args) => run('git', args)

/** "https://github.com/owner/repo(.git)" or "git@github.com:owner/repo(.git)" → https URL. */
function repoUrl() {
  const remote = git('remote', 'get-url', 'origin')
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)
  return m ? `https://github.com/${m[1]}` : null
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^s(i|í)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const [arg] = args.filter((a) => !a.startsWith('--'))
  if (!arg) {
    console.error('Uso: npm run release <patch|minor|major|X.Y.Z> [--sin-tests] [--si]')
    console.error('  patch  0.1.0 → 0.1.1   (arreglos)')
    console.error('  minor  0.1.0 → 0.2.0   (novedades)')
    console.error('  major  0.1.0 → 1.0.0')
    process.exit(1)
  }

  const root = resolve(fileURLToPath(import.meta.url), '..', '..')
  process.chdir(root)

  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') {
    throw new Error('Publica desde la rama main.')
  }
  if (git('status', '--porcelain') !== '') {
    throw new Error('Hay cambios sin commitear. Haz commit o descártalos antes de publicar.')
  }
  console.log('Comprobando que main está al día con GitHub…')
  git('fetch', '--quiet', 'origin', 'main')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    throw new Error('Tu main no coincide con el de GitHub. Haz git pull o git push primero.')
  }

  const current = JSON.parse(readFileSync('package.json', 'utf8')).version
  const stale = findMismatches(current, root)
  if (stale.length > 0) {
    throw new Error(
      `Los package.json no tienen todos la versión ${current}: ${stale.map((s) => s.name).join(', ')}.`,
    )
  }
  // Same version as the package.json files: publish it as is (first release, or a tag that never got pushed).
  const tagOnly = arg.replace(/^v/, '') === current
  const version = tagOnly ? current : nextVersion(current, arg)
  const tag = `v${version}`
  if (git('tag', '--list', tag) !== '' || git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`) !== '') {
    throw new Error(`La etiqueta ${tag} ya existe.`)
  }

  const original = readFileSync('CHANGELOG.md', 'utf8')
  const changelog = tagOnly ? original : promoteUnreleased(original, version, today())
  if (tagOnly && extractSection(changelog, version) === null) {
    throw new Error(`CHANGELOG.md no tiene una sección "## [${version}]" para las notas.`)
  }
  const prerelease = version.includes('-')

  console.log('')
  console.log(`Versión: ${tagOnly ? `${version} (la actual, sin cambiar package.json)` : `${current} → ${version}`}${prerelease ? ' (prerelease: la app no la ofrecerá)' : ''}`)
  console.log('Notas del release:')
  console.log('')
  console.log(extractSection(changelog, version))
  console.log('')
  if (!flags.has('--si')) {
    if (!process.stdin.isTTY) throw new Error('Sin terminal interactiva: añade --si para confirmar.')
    if (!(await confirm(`¿Publicar ${tag}? Se subirá a GitHub y se generará el release (s/N) `))) {
      console.log('Cancelado. No se ha cambiado nada.')
      return
    }
  }

  if (!flags.has('--sin-tests')) {
    console.log('Pasando npm test (puede tardar un par de minutos)…')
    const res = spawnSync('npm', ['test'], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (res.status !== 0) throw new Error('npm test ha fallado. No se ha cambiado nada.')
  }

  const files = ['CHANGELOG.md', 'package-lock.json']
  if (!tagOnly) try {
    for (const dir of packageDirs(root)) {
      const file = join(dir, 'package.json')
      writeFileSync(file, setVersion(readFileSync(file, 'utf8'), version))
      files.push(relative(root, file).replace(/\\/g, '/'))
    }
    writeFileSync('CHANGELOG.md', changelog)
    console.log('Actualizando package-lock.json…')
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
    git('add', '--', ...files)
    git('commit', '--quiet', '-m', `chore: release ${tag}`)
  } catch (err) {
    console.error('Algo falló antes del commit. Para deshacer los cambios: git checkout -- .')
    throw err
  }
  git('tag', '-a', tag, '-m', `Hotspotter ${version}`)

  console.log(`Subiendo main y ${tag}…`)
  try {
    git('push', '--atomic', '--quiet', 'origin', 'main', tag)
  } catch (err) {
    console.error(`No se pudo subir. Para deshacer ${tagOnly ? 'la etiqueta local' : 'el commit y la etiqueta locales'}:`)
    console.error(`  git tag -d ${tag}`)
    if (!tagOnly) console.error('  git reset --hard HEAD~1')
    throw err
  }

  const url = repoUrl()
  console.log('')
  console.log(`Listo: ${tag} subido. GitHub está compilando y publicará el release en unos minutos.`)
  if (url) {
    console.log(`  Progreso: ${url}/actions`)
    console.log(`  Release:  ${url}/releases/tag/${tag}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
