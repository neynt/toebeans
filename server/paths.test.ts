import { describe, test, expect } from 'bun:test'
import { expandTilde, expandTildeInFields, resolveWorktreeBase } from './paths.ts'
import { homedir } from 'os'
import { join } from 'path'

const HOME = homedir()

describe('expandTilde', () => {
  test('expands bare ~', () => {
    expect(expandTilde('~')).toBe(HOME)
  })

  test('expands ~/ prefix', () => {
    expect(expandTilde('~/code/project')).toBe(`${HOME}/code/project`)
  })

  test('expands ~/  with deeper nesting', () => {
    expect(expandTilde('~/a/b/c')).toBe(`${HOME}/a/b/c`)
  })

  test('does not expand ~user (other user home)', () => {
    expect(expandTilde('~other/foo')).toBe('~other/foo')
  })

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/home/user/code')).toBe('/home/user/code')
  })

  test('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path')
  })

  test('leaves empty string unchanged', () => {
    expect(expandTilde('')).toBe('')
  })

  test('does not expand ~ in the middle of a string', () => {
    expect(expandTilde('/foo/~/bar')).toBe('/foo/~/bar')
  })
})

describe('expandTildeInFields', () => {
  test('expands specified path fields', () => {
    const input = { workingDir: '~/code', command: 'ls', timeout: 30 }
    const result = expandTildeInFields(input, ['workingDir']) as Record<string, unknown>
    expect(result.workingDir).toBe(`${HOME}/code`)
    expect(result.command).toBe('ls')
    expect(result.timeout).toBe(30)
  })

  test('expands multiple path fields', () => {
    const input = { src: '~/src', dst: '~/dst', label: 'copy' }
    const result = expandTildeInFields(input, ['src', 'dst']) as Record<string, unknown>
    expect(result.src).toBe(`${HOME}/src`)
    expect(result.dst).toBe(`${HOME}/dst`)
    expect(result.label).toBe('copy')
  })

  test('returns original object when no expansion needed', () => {
    const input = { workingDir: '/absolute/path', command: 'ls' }
    const result = expandTildeInFields(input, ['workingDir'])
    expect(result).toBe(input) // same reference
  })

  test('ignores non-string path fields', () => {
    const input = { workingDir: 42, command: 'ls' }
    const result = expandTildeInFields(input, ['workingDir'])
    expect(result).toBe(input)
  })

  test('ignores missing path fields', () => {
    const input = { command: 'ls' }
    const result = expandTildeInFields(input, ['workingDir'])
    expect(result).toBe(input)
  })

  test('returns input unchanged for empty pathFields', () => {
    const input = { workingDir: '~/code' }
    const result = expandTildeInFields(input, [])
    expect(result).toBe(input)
  })

  test('returns input unchanged for non-object input', () => {
    expect(expandTildeInFields('string', ['field'])).toBe('string')
    expect(expandTildeInFields(null, ['field'])).toBe(null)
    expect(expandTildeInFields(42, ['field'])).toBe(42)
  })
})

describe('resolveWorktreeBase', () => {
  test('expands tilde in configured value', () => {
    expect(resolveWorktreeBase('~/my-worktrees')).toBe(`${HOME}/my-worktrees`)
  })

  test('returns absolute configured value as-is', () => {
    expect(resolveWorktreeBase('/tmp/worktrees')).toBe('/tmp/worktrees')
  })

  test('returns default when undefined', () => {
    expect(resolveWorktreeBase(undefined)).toBe(join(HOME, 'code', 'toebeans-wt'))
  })

  test('returns default when empty string', () => {
    // empty string is falsy, so falls through to default
    expect(resolveWorktreeBase('')).toBe(join(HOME, 'code', 'toebeans-wt'))
  })

  test('expands bare tilde', () => {
    expect(resolveWorktreeBase('~')).toBe(HOME)
  })
})
