import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { FOOTER, buildNotes, extractSection } from './release-notes.mjs'
import { findMismatches } from './check-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CHANGELOG = `# Cambios

## [Sin publicar]

## [0.2.0] - 2026-12-01

- Segunda.

## [0.1.0] - 2026-11-17

### Añadido

- Primera.
`

const tmp = mkdtempSync(join(tmpdir(), 'hs-release-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function writePkg(dir, name, version) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

function makeRepo(name, versions) {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', version: versions.root, workspaces: ['packages/*', 'apps/*'] }),
  )
  writePkg(join(root, 'packages', 'core'), '@x/core', versions.core)
  writePkg(join(root, 'apps', 'server'), '@x/server', versions.server)
  return root
}

describe('extractSection', () => {
  it('returns the section up to the next "## ["', () => {
    expect(extractSection(CHANGELOG, '0.2.0')).toBe('## [0.2.0] - 2026-12-01\n\n- Segunda.')
  })

  it('returns the last section up to the end of the file', () => {
    expect(extractSection(CHANGELOG, '0.1.0')).toBe(
      '## [0.1.0] - 2026-11-17\n\n### Añadido\n\n- Primera.',
    )
  })

  it('returns null for a missing version', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull()
  })
})

describe('buildNotes', () => {
  it('appends the Spanish footer', () => {
    const notes = buildNotes(CHANGELOG, '0.1.0')
    expect(notes).toContain('- Primera.')
    expect(notes).toContain('Cierra Hotspotter antes de sobrescribir la carpeta.')
    expect(notes).toContain('Más información → Ejecutar de todas formas')
    expect(notes.endsWith(`${FOOTER}\n`)).toBe(true)
  })
})

describe('release-notes CLI', () => {
  const file = join(tmp, 'CHANGELOG.md')
  writeFileSync(file, CHANGELOG)
  const run = (version) =>
    spawnSync(process.execPath, [join(here, 'release-notes.mjs'), version, file], {
      encoding: 'utf8',
    })

  it('prints the section and exits 0', () => {
    const r = run('0.1.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('## [0.1.0] - 2026-11-17')
    expect(r.stdout).not.toContain('## [0.2.0]')
  })

  it('exits 1 when the version is missing', () => {
    const r = run('9.9.9')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('9.9.9')
  })
})

describe('check-version', () => {
  const cli = (tag) =>
    spawnSync(process.execPath, [join(here, 'check-version.mjs'), tag], { encoding: 'utf8' })

  it('finds no mismatch when every workspace matches', () => {
    const root = makeRepo('ok', { root: '1.2.3', core: '1.2.3', server: '1.2.3' })
    expect(findMismatches('v1.2.3', root)).toEqual([])
  })

  it('lists every workspace that differs, including packages/*', () => {
    const root = makeRepo('bad', { root: '1.2.3', core: '1.0.0', server: '1.2.3' })
    expect(findMismatches('v1.2.3', root)).toEqual([{ name: '@x/core', version: '1.0.0' }])
  })

  it('exits 1 with a Spanish message when the real repo does not match the tag', () => {
    const r = cli('v99.0.0')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no coincide')
  })

  it('exits 0 when the real repo matches the tag', () => {
    const version = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")).version
    expect(cli(`v${version}`).status).toBe(0)
  })
})

