import { appendFileSync, renameSync, statSync, unlinkSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { formatLocalTime } from './time.ts'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_FILES = 3

export interface LoggerOptions {
  maxBytes?: number
  maxFiles?: number
}

/**
 * Rotate a log file: foo.log → foo.log.1 → foo.log.2 → ... up to maxFiles.
 * The oldest file beyond maxFiles is deleted.
 */
export function rotateFile(filePath: string, maxFiles: number) {
  // delete the oldest if it exists
  try { unlinkSync(`${filePath}.${maxFiles}`) } catch {}
  // shift existing rotated files up by one
  for (let i = maxFiles - 1; i >= 1; i--) {
    try { renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`) } catch {}
  }
  // move current file to .1
  try { renameSync(filePath, `${filePath}.1`) } catch {}
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? a.message
  return JSON.stringify(a)
}

/**
 * Simple file logger with size-based rotation.
 *
 * Each Logger instance writes timestamped lines to a single file path.
 * When the file exceeds `maxBytes`, it rotates (foo.log → foo.log.1 → ...).
 */
export class Logger {
  readonly filePath: string
  private maxBytes: number
  private maxFiles: number
  private bytesWritten = -1 // -1 = not yet initialized

  constructor(filePath: string, opts?: LoggerOptions) {
    this.filePath = filePath
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES
  }

  private init() {
    if (this.bytesWritten >= 0) return
    mkdirSync(dirname(this.filePath), { recursive: true })
    try {
      this.bytesWritten = statSync(this.filePath).size
    } catch {
      this.bytesWritten = 0
    }
  }

  private write(level: string, args: unknown[]) {
    this.init()
    const ts = formatLocalTime(new Date())
    const msg = args.map(formatArg).join(' ')
    const line = `${ts} [${level}] ${msg}\n`
    if (this.bytesWritten > 0 && this.bytesWritten + line.length > this.maxBytes) {
      rotateFile(this.filePath, this.maxFiles)
      this.bytesWritten = 0
    }
    appendFileSync(this.filePath, line)
    this.bytesWritten += line.length
  }

  info(...args: unknown[]) { this.write('INFO', args) }
  warn(...args: unknown[]) { this.write('WARN', args) }
  error(...args: unknown[]) { this.write('ERROR', args) }
}
