import { describe, expect, it } from 'vitest'
import { nextVersion, promoteUnreleased, setVersion } from './release.mjs'

describe('nextVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1')
    expect(nextVersion('0.1.3', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.4.2', 'major')).toBe('1.0.0')
  })

  it('drops the prerelease suffix on a keyword bump of a prerelease', () => {
    expect(nextVersion('0.2.0-beta.1', 'minor')).toBe('0.3.0')
  })

  it('accepts an explicit version, with or without a leading v', () => {
    expect(nextVersion('0.1.0', '0.2.0')).toBe('0.2.0')
    expect(nextVersion('0.1.0', 'v0.2.0-beta.1')).toBe('0.2.0-beta.1')
  })

  it('accepts the stable release after its prerelease', () => {
    expect(nextVersion('0.2.0-beta.3', '0.2.0')).toBe('0.2.0')
  })

  it('rejects a version that is not greater than the current one', () => {
    expect(() => nextVersion('0.2.0', '0.2.0')).toThrow(/mayor que la actual/)
    expect(() => nextVersion('0.2.0', '0.1.9')).toThrow(/mayor que la actual/)
    expect(() => nextVersion('0.2.0', '0.2.0-beta.1')).toThrow(/mayor que la actual/)
  })

  it('rejects anything that is not semver or a keyword', () => {
    expect(() => nextVersion('0.1.0', '0.2')).toThrow(/no es una versión válida/)
    expect(() => nextVersion('0.1.0', 'menor')).toThrow(/no es una versión válida/)
  })
})

describe('promoteUnreleased', () => {
  const base = `# Cambios

Intro.

## [Sin publicar]

### Añadido

- Algo nuevo.

## [0.1.0] - 2026-11-17

- Primera.
`

  it('turns the unreleased notes into a dated section and leaves an empty unreleased one', () => {
    expect(promoteUnreleased(base, '0.2.0', '2026-12-01')).toBe(`# Cambios

Intro.

## [Sin publicar]

## [0.2.0] - 2026-12-01

### Añadido

- Algo nuevo.

## [0.1.0] - 2026-11-17

- Primera.
`)
  })

  it('keeps CRLF files working', () => {
    const out = promoteUnreleased(base.replace(/\n/g, '\r\n'), '0.2.0', '2026-12-01')
    expect(out).toContain('## [0.2.0] - 2026-12-01\r\n\r\n### Añadido')
  })

  it('fails when the unreleased section is empty', () => {
    const empty = base.replace('### Añadido\n\n- Algo nuevo.\n\n', '')
    expect(() => promoteUnreleased(empty, '0.2.0', '2026-12-01')).toThrow(/no tiene notas/)
  })

  it('fails when there is no unreleased section', () => {
    expect(() => promoteUnreleased('# Cambios\n\n## [0.1.0]\n', '0.2.0', '2026-12-01')).toThrow(
      /Sin publicar/,
    )
  })

  it('fails when the version already has a section', () => {
    expect(() => promoteUnreleased(base, '0.1.0', '2026-12-01')).toThrow(/ya tiene una sección/)
  })
})

describe('setVersion', () => {
  it('replaces only the top-level version and keeps the formatting', () => {
    const pkg = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "y": "0.1.0" }\n}\n'
    expect(setVersion(pkg, '0.2.0')).toBe(
      '{\n  "name": "x",\n  "version": "0.2.0",\n  "dependencies": { "y": "0.1.0" }\n}\n',
    )
  })

  it('fails on a package.json without a version', () => {
    expect(() => setVersion('{ "name": "x" }', '0.2.0')).toThrow(/version/)
  })
})
