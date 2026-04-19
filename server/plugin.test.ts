import { describe, test, expect } from 'bun:test'
import { PluginManager, type Plugin, type PluginStatus } from './plugin.ts'

describe('PluginManager.getPluginStatuses', () => {
  test('returns empty map when no plugins have status()', async () => {
    const pm = new PluginManager()
    await pm.loadPlugin('_dummy', undefined, { skipInit: true })
      .catch(() => {}) // plugin won't exist, that's fine — we'll test with manual insertion

    // use getAllPlugins to verify it's empty by default
    const statuses = await pm.getPluginStatuses()
    expect(statuses.size).toBe(0)
  })

  test('collects status from plugins that implement status()', async () => {
    const pm = new PluginManager()
    // manually insert plugins for testing
    const pluginA: Plugin = {
      name: 'test-a',
      async status() {
        return { tasks: [{ id: '1', description: 'task a', startedAt: new Date().toISOString() }] }
      },
    }
    const pluginB: Plugin = {
      name: 'test-b',
      // no status method
    }
    const pluginC: Plugin = {
      name: 'test-c',
      async status() {
        return { tasks: [{ id: '2', description: 'task c', startedAt: new Date().toISOString() }] }
      },
    }
    pm.getAllPlugins().set('test-a', { plugin: pluginA, config: undefined })
    pm.getAllPlugins().set('test-b', { plugin: pluginB, config: undefined })
    pm.getAllPlugins().set('test-c', { plugin: pluginC, config: undefined })

    const statuses = await pm.getPluginStatuses()
    expect(statuses.size).toBe(2)
    expect(statuses.has('test-a')).toBe(true)
    expect(statuses.has('test-c')).toBe(true)
    expect(statuses.get('test-a')!.tasks).toHaveLength(1)
    expect(statuses.get('test-a')!.tasks![0].id).toBe('1')
  })

  test('skips plugins that return null from status()', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'idle-plugin',
      status() { return null },
    }
    pm.getAllPlugins().set('idle-plugin', { plugin, config: undefined })

    const statuses = await pm.getPluginStatuses()
    expect(statuses.size).toBe(0)
  })

  test('handles status() errors gracefully', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'broken',
      async status() { throw new Error('boom') },
    }
    pm.getAllPlugins().set('broken', { plugin, config: undefined })

    const statuses = await pm.getPluginStatuses()
    expect(statuses.size).toBe(0) // error is caught, not propagated
  })
})

describe('PluginManager.getPluginContexts', () => {
  test('returns empty array when no plugins loaded', async () => {
    const pm = new PluginManager()
    const contexts = await pm.getPluginContexts()
    expect(contexts).toEqual([])
  })

  test('returns description, systemPrompt, and tools for each plugin', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'full-plugin',
      description: 'does everything',
      async buildSystemPrompt() { return 'remember: be nice' },
      tools: [
        { name: 'greet', description: 'say hello', inputSchema: { type: 'object', properties: {} }, execute: async () => 'hi' },
      ],
    }
    pm.getAllPlugins().set('full-plugin', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts).toHaveLength(1)
    expect(contexts[0].name).toBe('full-plugin')
    expect(contexts[0].description).toBe('does everything')
    expect(contexts[0].systemPrompt).toBe('remember: be nice')
    expect(contexts[0].tools).toEqual([{ name: 'greet', description: 'say hello' }])
  })

  test('returns null for missing description and systemPrompt', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = { name: 'bare' }
    pm.getAllPlugins().set('bare', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].description).toBeNull()
    expect(contexts[0].systemPrompt).toBeNull()
    expect(contexts[0].tools).toEqual([])
  })

  test('handles buildSystemPrompt returning null', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'quiet',
      async buildSystemPrompt() { return null },
    }
    pm.getAllPlugins().set('quiet', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].systemPrompt).toBeNull()
  })

  test('captures buildSystemPrompt errors as error message', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'broken',
      async buildSystemPrompt() { throw new Error('disk on fire') },
    }
    pm.getAllPlugins().set('broken', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].systemPrompt).toBe('[error: disk on fire]')
  })

  test('preserves plugin order', async () => {
    const pm = new PluginManager()
    pm.getAllPlugins().set('alpha', { plugin: { name: 'alpha' }, config: undefined })
    pm.getAllPlugins().set('beta', { plugin: { name: 'beta' }, config: undefined })
    pm.getAllPlugins().set('gamma', { plugin: { name: 'gamma' }, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts.map(c => c.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('includes dashboardData when plugin provides it', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'with-dashboard',
      async dashboardData() { return { ungrouped: [], groups: [{ name: 'Test', skills: [] }] } },
    }
    pm.getAllPlugins().set('with-dashboard', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].dashboardData).toEqual({ ungrouped: [], groups: [{ name: 'Test', skills: [] }] })
  })

  test('omits dashboardData when plugin does not provide it', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = { name: 'no-dashboard' }
    pm.getAllPlugins().set('no-dashboard', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].dashboardData).toBeUndefined()
  })

  test('handles dashboardData errors gracefully', async () => {
    const pm = new PluginManager()
    const plugin: Plugin = {
      name: 'broken-dashboard',
      async dashboardData() { throw new Error('nope') },
    }
    pm.getAllPlugins().set('broken-dashboard', { plugin, config: undefined })

    const contexts = await pm.getPluginContexts()
    expect(contexts[0].dashboardData).toBeUndefined()
  })
})
