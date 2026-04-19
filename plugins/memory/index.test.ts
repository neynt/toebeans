import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// mock getMemoryDir to use a temp directory
let tempDir: string
const mockGetMemoryDir = mock(() => tempDir)
mock.module('../../server/session.ts', () => ({
  getMemoryDir: mockGetMemoryDir,
}))

// import after mocking
const { default: create } = await import('./index.ts')

describe('memory plugin buildSystemPrompt', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toebeans-memory-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('seeds USER.md if missing', async () => {
    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('### User info')
    const userMd = await Bun.file(join(tempDir, 'USER.md')).text()
    expect(userMd.length).toBeGreaterThan(0)
  })

  test('lists top-level topic files individually', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await Bun.write(join(tempDir, 'projects.md'), '# Projects')
    await Bun.write(join(tempDir, 'hobbies.md'), '# Hobbies')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('- hobbies.md')
    expect(prompt).toContain('- projects.md')
  })

  test('excludes top-level date-stamped daily logs', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await Bun.write(join(tempDir, '2026-03-28.md'), '# Daily Log')
    await Bun.write(join(tempDir, '2026-03-29.md'), '# Daily Log')
    await Bun.write(join(tempDir, 'topics.md'), '# Topics')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('- topics.md')
    expect(prompt).not.toContain('2026-03-28')
    expect(prompt).not.toContain('2026-03-29')
  })

  test('surfaces subdirectories as directory entries, not leaf files', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await mkdir(join(tempDir, 'workout'), { recursive: true })
    await Bun.write(join(tempDir, 'workout', 'routine.md'), '# Routine')
    await Bun.write(join(tempDir, 'workout', 'log.md'), '# Log')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('- workout/')
    // individual files inside subdirs should NOT appear
    expect(prompt).not.toContain('- workout/log.md')
    expect(prompt).not.toContain('- workout/routine.md')
  })

  test('multiple subdirectories each listed as directory entry', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await mkdir(join(tempDir, 'workout'), { recursive: true })
    await mkdir(join(tempDir, 'groceries'), { recursive: true })
    await Bun.write(join(tempDir, 'workout', '2026-03-28.md'), '# Workout')
    await Bun.write(join(tempDir, 'groceries', 'list.md'), '# List')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('- groceries/')
    expect(prompt).toContain('- workout/')
  })

  test('mixes top-level files and subdirectory entries, sorted', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await Bun.write(join(tempDir, 'projects.md'), '# Projects')
    await mkdir(join(tempDir, 'aaa-first'), { recursive: true })
    await Bun.write(join(tempDir, 'aaa-first', 'note.md'), '# Note')
    await mkdir(join(tempDir, 'zzz-last'), { recursive: true })
    await Bun.write(join(tempDir, 'zzz-last', 'note.md'), '# Note')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    // all three should appear
    expect(prompt).toContain('- aaa-first/')
    expect(prompt).toContain('- projects.md')
    expect(prompt).toContain('- zzz-last/')
    // check sort order: aaa-first/ < projects.md < zzz-last/
    const lines = prompt!.split('\n').filter((l: string) => l.startsWith('- '))
    const aIdx = lines.findIndex((l: string) => l.includes('aaa-first/'))
    const pIdx = lines.findIndex((l: string) => l.includes('projects.md'))
    const zIdx = lines.findIndex((l: string) => l.includes('zzz-last/'))
    expect(aIdx).toBeLessThan(pIdx)
    expect(pIdx).toBeLessThan(zIdx)
  })

  test('empty subdirectories (no .md files) are not listed', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await Bun.write(join(tempDir, 'topics.md'), '# Topics')
    await mkdir(join(tempDir, 'empty-dir'), { recursive: true })
    // put a non-md file in there
    await Bun.write(join(tempDir, 'empty-dir', 'data.json'), '{}')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('- topics.md')
    expect(prompt).not.toContain('empty-dir')
  })

  test('deeply nested files surface only the top-level subdir', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await mkdir(join(tempDir, 'projects', 'toebeans'), { recursive: true })
    await Bun.write(join(tempDir, 'projects', 'toebeans', 'notes.md'), '# Notes')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    // should show the top-level subdir, not the nested path
    expect(prompt).toContain('- projects/')
    expect(prompt).not.toContain('- projects/toebeans/notes.md')
  })

  test('returns null when no content', async () => {
    await Bun.write(join(tempDir, 'USER.md'), '  ')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toBeNull()
  })

  test('instructs agent to list subdir contents with bash', async () => {
    await Bun.write(join(tempDir, 'USER.md'), 'user info')
    await mkdir(join(tempDir, 'workout'), { recursive: true })
    await Bun.write(join(tempDir, 'workout', 'log.md'), '# Log')

    const plugin = create()
    const prompt = await plugin.buildSystemPrompt!()
    expect(prompt).toContain('list their contents with bash')
  })
})
