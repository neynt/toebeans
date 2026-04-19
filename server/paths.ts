import { homedir } from 'os'
import { join } from 'path'

/**
 * Expand a leading `~` or `~/` in a path string to the user's home directory.
 * Returns the string unchanged if it doesn't start with `~`.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

/**
 * Resolve the worktree base directory from an optional config value.
 * Expands `~` if present, falls back to `~/code/toebeans-wt`.
 */
export function resolveWorktreeBase(configured: string | undefined): string {
  if (configured) return expandTilde(configured)
  return join(homedir(), 'code', 'toebeans-wt')
}

/**
 * Given a tool input object and a set of field names that represent filesystem paths,
 * return a shallow copy with tilde-expanded values for those fields.
 * Only expands top-level string fields. Non-string or missing fields are left as-is.
 */
export function expandTildeInFields(input: unknown, pathFields: readonly string[]): unknown {
  if (typeof input !== 'object' || input === null || pathFields.length === 0) return input
  const obj = input as Record<string, unknown>
  let changed = false
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (pathFields.includes(key) && typeof val === 'string') {
      const expanded = expandTilde(val)
      if (expanded !== val) changed = true
      result[key] = expanded
    } else {
      result[key] = val
    }
  }
  return changed ? result : input
}
