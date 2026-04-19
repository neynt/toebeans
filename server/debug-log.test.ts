import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DebugLog } from './debug-log.ts'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// override getDataDir to use a temp directory
let tempDir: string

// We test the DebugLog by constructing it with an absolute path trick:
// DebugLog joins getDataDir() + dir, so we mock getDataDir via a subclass.
class TestDebugLog extends DebugLog {
  constructor(dir: string, filename?: string) {
    super(dir, filename)
    // override the internal paths to use tempDir
    ;(this as any).dirPath = join(tempDir, dir)
    ;(this as any).filePath = join(tempDir, dir, filename ?? 'debug.log')
    ;(this as any).ensured = false
  }
}

describe('DebugLog', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'debuglog-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates directory and writes log lines', () => {
    const log = new TestDebugLog('test-debug')
    log.log('hello', 'world')
    log.log('second line')

    const content = readFileSync(join(tempDir, 'test-debug', 'debug.log'), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('hello world')
    expect(lines[1]).toContain('second line')
    // should have ISO timestamp prefix
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('warn prepends WARN', () => {
    const log = new TestDebugLog('test-debug')
    log.warn('something broke')

    const content = readFileSync(join(tempDir, 'test-debug', 'debug.log'), 'utf-8')
    expect(content).toContain('WARN')
    expect(content).toContain('something broke')
  })

  test('writeFile writes arbitrary data', () => {
    const log = new TestDebugLog('test-debug')
    log.writeFile('dump.json', '{"hello": true}')

    const content = readFileSync(join(tempDir, 'test-debug', 'dump.json'), 'utf-8')
    expect(content).toBe('{"hello": true}')
  })

  test('custom filename', () => {
    const log = new TestDebugLog('test-debug', 'custom.log')
    log.log('hi')

    expect(existsSync(join(tempDir, 'test-debug', 'custom.log'))).toBe(true)
    expect(existsSync(join(tempDir, 'test-debug', 'debug.log'))).toBe(false)
  })

  test('serializes non-string args as JSON', () => {
    const log = new TestDebugLog('test-debug')
    log.log('count:', 42, { key: 'val' })

    const content = readFileSync(join(tempDir, 'test-debug', 'debug.log'), 'utf-8')
    expect(content).toContain('count: 42 {"key":"val"}')
  })
})
