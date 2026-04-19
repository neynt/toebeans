import { describe, test, expect } from 'bun:test'
import { dashboardHtml } from './dashboard-html'

describe('dashboardHtml', () => {
  test('returns valid HTML with default args', () => {
    const html = dashboardHtml()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('toebeans')
    expect(html).toContain("const statusUrl = '/status'")
    expect(html).toContain("const apiBase = ''")
  })

  test('uses custom statusUrl and apiBase', () => {
    const html = dashboardHtml('/api/status', '/api')
    expect(html).toContain("const statusUrl = '/api/status'")
    expect(html).toContain("const apiBase = '/api'")
  })

  test('includes overview and sessions tabs', () => {
    const html = dashboardHtml()
    expect(html).toContain('data-tab="overview"')
    expect(html).toContain('data-tab="sessions"')
  })

  test('includes session list with recency filter', () => {
    const html = dashboardHtml()
    expect(html).toContain('id="recency-select"')
    expect(html).toContain('2 days')
    expect(html).toContain('1 week')
    expect(html).toContain('all time')
  })

  test('includes transcript rendering functions', () => {
    const html = dashboardHtml()
    expect(html).toContain('function renderTranscript')
    expect(html).toContain('function renderMessage')
    expect(html).toContain('function renderToolUse')
    expect(html).toContain('function renderToolResult')
    expect(html).toContain('function renderSystemPrompt')
    expect(html).toContain('function renderImage')
  })

  test('includes session list fetching and SSE streaming', () => {
    const html = dashboardHtml()
    expect(html).toContain('fetchSessionList')
    expect(html).toContain('/sessions')
    expect(html).toContain('/stream')
  })

  test('includes collapsible toggle support', () => {
    const html = dashboardHtml()
    expect(html).toContain('function toggleCollapse')
    expect(html).toContain('window.toggleCollapse')
  })

  test('includes system-prompt tab', () => {
    const html = dashboardHtml()
    expect(html).toContain('data-tab="system-prompt"')
    expect(html).toContain('id="panel-system-prompt"')
  })

  test('includes system prompt fetch and render functions', () => {
    const html = dashboardHtml()
    expect(html).toContain('function fetchSystemPrompt')
    expect(html).toContain('function renderSystemPromptPanel')
    expect(html).toContain('function copySystemPrompt')
  })

  test('system prompt panel has toolbar with copy button and content area', () => {
    const html = dashboardHtml()
    expect(html).toContain('id="copy-prompt-btn"')
    expect(html).toContain('id="prompt-content"')
    expect(html).toContain('id="prompt-meta"')
  })

  test('system prompt fetches from debug/system endpoint', () => {
    const html = dashboardHtml()
    expect(html).toContain("'/debug/system'")
  })

  test('system prompt fetches from custom apiBase', () => {
    const html = dashboardHtml('/api/status', '/api')
    expect(html).toContain("apiBase + '/debug/system'")
  })

  test('system prompt auto-refreshes while tab is active', () => {
    const html = dashboardHtml()
    expect(html).toContain("currentTab === 'system-prompt'")
    expect(html).toContain('fetchSystemPrompt')
  })

  test('overview rendering preserves coding agent session display', () => {
    const html = dashboardHtml()
    expect(html).toContain('claude-code')
    expect(html).toContain('gemini-cli')
    expect(html).toContain('openai-codex')
    expect(html).toContain('coding sessions')
  })

  test('coding session cards are expandable with live output', () => {
    const html = dashboardHtml()
    expect(html).toContain('coding-card')
    expect(html).toContain('expandedCodingSessions')
    expect(html).toContain('fetchCodingOutput')
    expect(html).toContain('coding-output')
    expect(html).toContain('/coding-session/')
  })

  test('includes plugins tab', () => {
    const html = dashboardHtml()
    expect(html).toContain('data-tab="plugins"')
    expect(html).toContain('id="panel-plugins"')
    expect(html).toContain('id="plugin-count"')
  })

  test('includes plugin context rendering functions', () => {
    const html = dashboardHtml()
    expect(html).toContain('function fetchPluginContexts')
    expect(html).toContain('function renderPluginList')
    expect(html).toContain('function renderPluginDetail')
  })

  test('plugins panel fetches from /status/plugin-context', () => {
    const html = dashboardHtml()
    expect(html).toContain('/status/plugin-context')
  })

  test('plugins panel uses custom apiBase for fetch', () => {
    const html = dashboardHtml('/api/status', '/api')
    // the fetchPluginContexts function should use apiBase
    expect(html).toContain("fetch(apiBase + '/status/plugin-context')")
  })

  test('plugins panel has plugin list and detail areas', () => {
    const html = dashboardHtml()
    expect(html).toContain('id="plugin-list"')
    expect(html).toContain('id="plugin-items"')
    expect(html).toContain('id="plugin-detail-area"')
  })

  test('plugin detail renders description, system prompt, and tools sections', () => {
    const html = dashboardHtml()
    expect(html).toContain('system prompt contribution')
    expect(html).toContain('plugin-tool-name')
    expect(html).toContain('plugin-tool-desc')
  })

  test('includes skills group rendering functions', () => {
    const html = dashboardHtml()
    expect(html).toContain('function renderSkillsDashboard')
    expect(html).toContain('function renderSkillItem')
    expect(html).toContain('function toggleSkillGroup')
  })

  test('skills groups have collapsible CSS styles', () => {
    const html = dashboardHtml()
    expect(html).toContain('.skill-group-header')
    expect(html).toContain('.skill-group-body')
    expect(html).toContain('.skill-group-body.open')
    expect(html).toContain('.skill-group-arrow')
  })

  test('skills rendering checks for dashboardData', () => {
    const html = dashboardHtml()
    expect(html).toContain('p.dashboardData')
    expect(html).toContain('renderSkillsDashboard')
  })

  test('openSkillGroups state tracks expanded groups', () => {
    const html = dashboardHtml()
    expect(html).toContain('openSkillGroups = new Set()')
    expect(html).toContain('openSkillGroups.has')
    expect(html).toContain('openSkillGroups.delete')
    expect(html).toContain('openSkillGroups.add')
  })

  test('session list uses wider width', () => {
    const html = dashboardHtml()
    expect(html).toContain('width: 360px')
    expect(html).toContain('min-width: 280px')
    expect(html).toContain('max-width: 500px')
  })

  test('scrolls to bottom after loading transcript', () => {
    const html = dashboardHtml()
    // after renderTranscript, scroll to bottom
    expect(html).toContain('area.scrollTop = area.scrollHeight')
  })

  test('includes live transcript streaming via SSE', () => {
    const html = dashboardHtml()
    expect(html).toContain('EventSource')
    expect(html).toContain('transcriptEventSource')
    expect(html).toContain('isNearBottom')
  })

  test('smart auto-scroll only when near bottom', () => {
    const html = dashboardHtml()
    // isNearBottom checks threshold before auto-scrolling on update
    expect(html).toContain('function isNearBottom')
    expect(html).toContain('wasNearBottom')
    expect(html).toContain('if (wasNearBottom) area.scrollTop = area.scrollHeight')
  })

  test('groups tool_use with tool_result blocks', () => {
    const html = dashboardHtml()
    // tool grouping: builds toolResultMap, renders grouped pairs
    expect(html).toContain('toolResultMap')
    expect(html).toContain('tool-group')
    expect(html).toContain('toolResultOnlyEntryIndices')
  })

  test('tool-results-only user messages are skipped in transcript', () => {
    const html = dashboardHtml()
    // user messages containing only tool_result blocks get their index added
    // to toolResultOnlyEntryIndices and are skipped during rendering
    expect(html).toContain('hasOnlyToolResults')
    expect(html).toContain('toolResultOnlyEntryIndices.has(i)')
  })

  test('tool group CSS styles are present', () => {
    const html = dashboardHtml()
    expect(html).toContain('.tool-group')
    expect(html).toContain('.tool-group .tool-use-block')
    expect(html).toContain('.tool-group .tool-result-block')
  })

  test('includes tool run collapsing for consecutive assistant turns', () => {
    const html = dashboardHtml()
    expect(html).toContain('function renderToolRun')
    expect(html).toContain('tool-run-header')
    expect(html).toContain('tool-run-body')
    expect(html).toContain('tool-run-summary')
    expect(html).toContain('tool call')
  })

  test('tool run CSS styles are present', () => {
    const html = dashboardHtml()
    expect(html).toContain('.tool-run-header')
    expect(html).toContain('.tool-run-body')
    expect(html).toContain('.tool-run-summary')
    expect(html).toContain('.tool-run-body.open')
  })

  test('uses deterministic IDs for collapse state preservation', () => {
    const html = dashboardHtml()
    // should use block.id / block.tool_use_id, not Math.random()
    expect(html).toContain("'tu-' + block.id")
    expect(html).toContain("'tr-' + block.tool_use_id")
    expect(html).toContain("'sp-' + entryIndex")
    expect(html).toContain('openCollapseIds')
  })

  test('openCollapseIds persists collapse state across rerenders', () => {
    const html = dashboardHtml()
    expect(html).toContain('const openCollapseIds = new Set()')
    // toggleCollapse updates the set
    expect(html).toContain('openCollapseIds.has(id)')
    expect(html).toContain('openCollapseIds.delete(id)')
    expect(html).toContain('openCollapseIds.add(id)')
  })

  test('overview does not render skills (skills live in plugins tab only)', () => {
    const html = dashboardHtml()
    // skills section was removed from renderOverview
    expect(html).not.toContain("ps['skills']")
    expect(html).not.toContain('skill-list')
  })

  test('skills CSS styles are present for plugins panel', () => {
    const html = dashboardHtml()
    expect(html).toContain('.skill-item')
    expect(html).toContain('.skill-name')
    expect(html).toContain('.skill-desc')
    expect(html).toContain('.skill-source')
  })
})
