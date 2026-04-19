import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { getDataDir } from './session.ts'

/**
 * Rotating, file-backed debug logger.
 * Each DebugLog instance writes to `~/.toebeans/{dir}/{filename}`.
 * The directory is created lazily on first write.
 */
export class DebugLog {
  private dirPath: string
  private filePath: string
  private ensured = false

  constructor(dir: string, filename = 'debug.log') {
    this.dirPath = join(getDataDir(), dir)
    this.filePath = join(this.dirPath, filename)
  }

  private ensureDir() {
    if (!this.ensured) {
      mkdirSync(this.dirPath, { recursive: true })
      this.ensured = true
    }
  }

  log(...args: unknown[]) {
    this.ensureDir()
    const ts = new Date().toISOString()
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    appendFileSync(this.filePath, `${ts}  ${line}\n`)
  }

  warn(...args: unknown[]) {
    this.log('WARN', ...args)
  }

  /** Write arbitrary data to a file in the debug directory. */
  writeFile(filename: string, data: string) {
    this.ensureDir()
    const { writeFileSync } = require('fs')
    writeFileSync(join(this.dirPath, filename), data)
  }

  get dir() {
    return this.dirPath
  }
}
