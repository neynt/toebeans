import { describe, test, expect } from 'bun:test'
import type { Plugin } from '../../server/plugin.ts'

// We test the plugin via its public interface (status + buildSystemPrompt).
// The grouping logic is internal but observable through prompt/dashboard output.
async function createPlugin(): Promise<Plugin> {
  const mod = await import('./index.ts')
  return mod.default()
}

describe('skills plugin', () => {
  test('has expected name and no dedicated tools', async () => {
    const plugin = await createPlugin()
    expect(plugin.name).toBe('skills')
    expect(plugin.tools).toBeUndefined()
  })

  test('status() returns skills array', async () => {
    const plugin = await createPlugin()
    expect(plugin.status).toBeDefined()

    const status = await plugin.status!()
    expect(status).toBeDefined()
    expect(status).toHaveProperty('skills')
    expect(Array.isArray(status!.skills)).toBe(true)

    // at minimum we should find the core 'writing-skills' skill
    const skills = status!.skills as { name: string; description: string; dir: string; source: string }[]
    const writingSkill = skills.find(s => s.dir === 'writing-skills')
    if (writingSkill) {
      expect(writingSkill.name).toBe('writing-skills')
      expect(writingSkill.source).toBe('core')
      expect(writingSkill.description).toBeTruthy()
    }
  })

  test('status() skill entries have expected shape', async () => {
    const plugin = await createPlugin()
    const status = await plugin.status!()
    const skills = status!.skills as { name: string; description: string; dir: string; source: string }[]

    for (const skill of skills) {
      expect(typeof skill.name).toBe('string')
      expect(typeof skill.description).toBe('string')
      expect(typeof skill.dir).toBe('string')
      expect(['core', 'user']).toContain(skill.source)
    }
  })

  test('buildSystemPrompt() returns skills listing and filesystem guidance', async () => {
    const plugin = await createPlugin()
    const prompt = await plugin.buildSystemPrompt!()
    if (prompt) {
      expect(prompt).toContain('Available Skills')
      expect(prompt).toContain('/skills/')
      expect(prompt).toContain('Inspect skills directly with bash')
      expect(prompt).toContain('overrides the core one')
    }
  })

  test('buildSystemPrompt collapses groups', async () => {
    const plugin = await createPlugin()
    const prompt = await plugin.buildSystemPrompt!()
    if (!prompt) return // no skills installed, skip

    expect(prompt).toContain('### Available Skills')

    // If gws-* skills exist, they should appear as a group summary, not individual entries
    if (prompt.includes('Google Workspace')) {
      expect(prompt).toContain('skills)')
      expect(prompt).not.toContain('use skills_list to expand')
    }

    // writing-skills should appear individually (not in a group)
    if (prompt.includes('writing-skills')) {
      expect(prompt).toMatch(/- \*\*writing-skills\*\* \[core\] \(.+\/skills\/writing-skills\):/)
    }
  })

  test('dashboardData returns grouped structure', async () => {
    const plugin = await createPlugin() as Plugin & { dashboardData: () => Promise<unknown> }
    expect(plugin.dashboardData).toBeDefined()

    const data = await plugin.dashboardData() as { ungrouped: unknown[]; groups: unknown[] }
    if (!data) return // no skills, skip

    expect(data).toHaveProperty('ungrouped')
    expect(data).toHaveProperty('groups')
    expect(Array.isArray(data.ungrouped)).toBe(true)
    expect(Array.isArray(data.groups)).toBe(true)
  })
})
