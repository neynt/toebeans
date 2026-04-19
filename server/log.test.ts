import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Logger, rotateFile } from './log.ts'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let tempDir: string

describe('Logger', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('writes timestamped log lines with levels', () => {
    const log = new Logger(join(tempDir, 'test.log'))
    log.info('hello', 'world')
    log.warn('caution')
    log.error('oops')

    const lines = readFileSync(join(tempDir, 'test.log'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ \[INFO\] hello world$/)
    expect(lines[1]).toMatch(/\[WARN\] caution$/)
    expect(lines[2]).toMatch(/\[ERROR\] oops$/)
  })

  test('serializes non-string args', () => {
    const log = new Logger(join(tempDir, 'test.log'))
    log.info('count:', 42, { key: 'val' })

    const content = readFileSync(join(tempDir, 'test.log'), 'utf-8')
    expect(content).toContain('count: 42 {"key":"val"}')
  })

  test('serializes Error instances with stack', () => {
    const log = new Logger(join(tempDir, 'test.log'))
    const err = new Error('boom')
    log.error('failed:', err)

    const content = readFileSync(join(tempDir, 'test.log'), 'utf-8')
    expect(content).toContain('failed:')
    expect(content).toContain('boom')
  })

  test('creates parent directories', () => {
    const log = new Logger(join(tempDir, 'sub', 'dir', 'test.log'))
    log.info('hi')

    expect(existsSync(join(tempDir, 'sub', 'dir', 'test.log'))).toBe(true)
  })

  test('rotates when exceeding maxBytes', () => {
    const logPath = join(tempDir, 'rot.log')
    const log = new Logger(logPath, { maxBytes: 200, maxFiles: 2 })

    // write enough to exceed 200 bytes
    for (let i = 0; i < 10; i++) {
      log.info(`line number ${i} with some padding to fill space quickly`)
    }

    // the original file should exist and be small (post-rotation)
    expect(existsSync(logPath)).toBe(true)
    // at least one rotated file should exist
    expect(existsSync(`${logPath}.1`)).toBe(true)
  })

  test('rotation deletes beyond maxFiles', () => {
    const logPath = join(tempDir, 'rot.log')
    const log = new Logger(logPath, { maxBytes: 100, maxFiles: 2 })

    // write many lines to force multiple rotations
    for (let i = 0; i < 30; i++) {
      log.info(`line ${i} padding padding padding padding`)
    }

    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
    // .3 should not exist with maxFiles=2
    expect(existsSync(`${logPath}.3`)).toBe(false)
  })
})

describe('rotateFile', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rotate-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('rotates files in order', () => {
    const path = join(tempDir, 'app.log')
    writeFileSync(path, 'current')
    rotateFile(path, 3)

    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('current')
  })

  test('shifts existing rotated files', () => {
    const path = join(tempDir, 'app.log')
    writeFileSync(`${path}.1`, 'old1')
    writeFileSync(path, 'current')
    rotateFile(path, 3)

    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('current')
    expect(readFileSync(`${path}.2`, 'utf-8')).toBe('old1')
  })

  test('deletes file beyond maxFiles', () => {
    const path = join(tempDir, 'app.log')
    writeFileSync(`${path}.2`, 'oldest')
    writeFileSync(`${path}.1`, 'old')
    writeFileSync(path, 'current')
    rotateFile(path, 2)

    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('current')
    expect(readFileSync(`${path}.2`, 'utf-8')).toBe('old')
    // .2 was the old .1, and old .2 was deleted
  })
})
