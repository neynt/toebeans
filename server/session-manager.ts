import { countTokens, countMessagesTokens } from './tokens.ts'
import type { LlmProvider } from './llm-provider.ts'
import type { Message, SessionEntry } from './types.ts'
import type { Config } from './config.ts'
import type { PluginManager } from './plugin.ts'
import { repairMessages } from './agent.ts'

import {
  getCurrentSessionId,
  setCurrentSessionId,
  loadSession,
  loadSessionEntries,
  loadCostEntries,
  estimateSessionTokens,
  getSessionLastActivity,
  getSessionCreatedAt,
  writeSession,
  generateSessionId,
} from './session.ts'

export interface SessionManager {
  getSessionForMessage(route?: string): Promise<string>
  /** Check if session needs compaction. Returns true if token/lifespan thresholds are exceeded. Emits context warnings as a side effect. */
  needsCompaction(sessionId: string, route?: string): Promise<boolean>
  /** Execute session finalization: create successor session seeded with system prompt + summary, switch route. Returns new session ID. */
  finalizeSession(sessionId: string, route: string | undefined, summary: string): Promise<string>
  resetSession(sessionId: string, route?: string): Promise<string>
  getSessionInfo(sessionId: string): Promise<{
    id: string
    messageCount: number
    estimatedTokens: number
    systemPromptTokens: number
    createdAt: Date | null
    lastActivity: Date | null
  }>
}

export function createSessionManager(
  provider: LlmProvider,
  config: Config,
  routeOutput?: (target: string, message: any) => Promise<void>,
  pluginManager?: PluginManager,
  buildSystemPrompt?: () => Promise<string>,
  resolveOutputTarget?: (route: string) => string,
): SessionManager {
  const { compactAtTokens, warnAtTokens } = config.session

  // track which sessions have already emitted a context size warning (once per session)
  const warnedSessions = new Set<string>()

  // prevent concurrent finalization of the same session (second caller awaits the first)
  const inFlightFinalizations = new Map<string, Promise<string>>()

  async function getSystemPromptTokens(): Promise<number> {
    if (!buildSystemPrompt) return 0
    const prompt = await buildSystemPrompt()
    return countTokens(prompt)
  }

  return {
    async getSessionForMessage(route?: string): Promise<string> {
      return await getCurrentSessionId(route)
    },

    async needsCompaction(sessionId: string, route?: string): Promise<boolean> {
      const [sessionTokens, sysTokens] = await Promise.all([
        estimateSessionTokens(sessionId),
        getSystemPromptTokens(),
      ])
      const tokens = sessionTokens + sysTokens

      // check token threshold
      if (tokens >= compactAtTokens) {
        console.log(`session-manager: session ${sessionId} has ${tokens} tokens (>= ${compactAtTokens}), needs compaction`)
        return true
      }

      // emit a one-time context size warning when approaching compaction
      if (warnAtTokens && tokens >= warnAtTokens && !warnedSessions.has(sessionId)) {
        warnedSessions.add(sessionId)
        const formattedTokens = tokens.toLocaleString()
        const formattedCompact = compactAtTokens.toLocaleString()
        console.log(`session-manager: session ${sessionId} context warning: ${formattedTokens} tokens (compaction at ${formattedCompact})`)
        const warnTarget = route ? (resolveOutputTarget ? resolveOutputTarget(route) : route) : config.notifyOnRestart
        if (routeOutput && warnTarget) {
          routeOutput(warnTarget, {
            type: 'text',
            text: `\`\`\`\n⚠️ context size warning: ${formattedTokens} tokens (compaction at ${formattedCompact})\n\`\`\``
          }).then(() => routeOutput(warnTarget, { type: 'text_block_end' }))
            .catch(err => console.error('session-manager: failed to send context warning:', err))
        }
      }

      return false
    },

    async finalizeSession(sessionId: string, route: string | undefined, summary: string): Promise<string> {
      // coalesce concurrent finalizations of the same session
      const existing = inFlightFinalizations.get(sessionId)
      if (existing) return existing

      const promise = doFinalizeSession(sessionId, route, summary)
      inFlightFinalizations.set(sessionId, promise)
      try {
        return await promise
      } finally {
        inFlightFinalizations.delete(sessionId)
      }
    },

    async resetSession(sessionId: string, route?: string): Promise<string> {
      console.log(`session-manager: resetting session ${sessionId} (route: ${route || '_default'})`)

      const rawMessages = await loadSession(sessionId)

      // fire pre-compaction hooks in the background so reset isn't blocked by slow plugins
      if (pluginManager && rawMessages.length > 0) {
        const messages = repairMessages(rawMessages)
        pluginManager.firePreCompaction({ sessionId, route, messages, provider })
          .catch(err => console.error(`session-manager: pre-compaction hook error during reset (session ${sessionId}):`, err))
      }

      // compute old session's total cost
      const oldCostEntries = await loadCostEntries(sessionId)
      const oldSessionCost = oldCostEntries.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)

      // create a brand new empty session (no summary, no carryover)
      const newId = await generateSessionId(route)
      setCurrentSessionId(route, newId)

      console.log(`session-manager: reset session ${sessionId} → ${newId}`)

      // send reset notification to the channel being reset
      const resetTarget = route ? (resolveOutputTarget ? resolveOutputTarget(route) : route) : config.notifyOnRestart
      if (routeOutput && resetTarget) {
        try {
          const costStr = `$${oldSessionCost.toFixed(2)}`
          await routeOutput(resetTarget, {
            type: 'text',
            text: `\`\`\`\n🧹 reset old: ${sessionId} → new: ${newId} (old session cost: ${costStr})\n\`\`\``
          })
          await routeOutput(resetTarget, { type: 'text_block_end' })
        } catch (err) {
          console.error(`session-manager: failed to send reset notification:`, err)
        }
      }

      return newId
    },

    async getSessionInfo(sessionId: string) {
      const messages = await loadSession(sessionId)
      const messageTokens = await estimateSessionTokens(sessionId)
      const systemPromptTokens = await getSystemPromptTokens()
      const createdAt = await getSessionCreatedAt(sessionId)
      const lastActivity = await getSessionLastActivity(sessionId)

      return {
        id: sessionId,
        messageCount: messages.length,
        estimatedTokens: messageTokens + systemPromptTokens,
        systemPromptTokens,
        createdAt,
        lastActivity,
      }
    },
  }

  async function doFinalizeSession(sessionId: string, route: string | undefined, summary: string): Promise<string> {
    const entries = await loadSessionEntries(sessionId)
    const rawMessages = entries
      .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message')
      .map(e => e.message)
    const beforeTokens = countMessagesTokens(rawMessages)

    console.log(`session-manager: finalizing session ${sessionId} (${beforeTokens} tokens, route: ${route || '_default'})`)

    // fire pre-compaction hooks in the background
    if (pluginManager && rawMessages.length > 0) {
      const messages = repairMessages(rawMessages)
      pluginManager.firePreCompaction({ sessionId, route, messages, provider })
        .catch(err => console.error(`session-manager: pre-compaction hook error (session ${sessionId}):`, err))
    }

    // generate new session ID and build system prompt in parallel
    const [newId, systemPrompt] = await Promise.all([
      generateSessionId(route),
      buildSystemPrompt ? buildSystemPrompt() : Promise.resolve(''),
    ])

    // compute old session's total cost from already-loaded entries
    const oldCostEntries = entries
      .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message' && !!e.cost)
      .map(e => e.cost!)
    const oldSessionCost = oldCostEntries.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)

    // create new session with system_prompt + summary message
    const now = new Date().toISOString()
    const summaryMessage: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Previous conversation summary]\n\n${summary}\n\n[End of summary - new conversation starts here]`,
      }],
    }
    const newEntries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: now, content: systemPrompt },
      { type: 'message', timestamp: now, message: summaryMessage },
    ]
    await writeSession(newId, newEntries)

    // atomically switch the route to the new session
    setCurrentSessionId(route, newId)

    const afterTokens = await estimateSessionTokens(newId)
    console.log(`session-manager: finalized ${beforeTokens} -> ${afterTokens} tokens (new session ${newId})`)

    // send compaction report to the channel being compacted
    const compactTarget = route ? (resolveOutputTarget ? resolveOutputTarget(route) : route) : config.notifyOnRestart
    if (routeOutput && compactTarget) {
      try {
        const formattedBefore = beforeTokens.toLocaleString()
        const formattedAfter = afterTokens.toLocaleString()
        const costStr = `$${oldSessionCost.toFixed(2)}`
        await routeOutput(compactTarget, {
          type: 'text',
          text: `\`\`\`\n🔄 finalized old: ${sessionId} → new: ${newId} (${formattedBefore} → ${formattedAfter} tokens, old session cost: ${costStr})\n\`\`\``
        })
        await routeOutput(compactTarget, { type: 'text_block_end' })
      } catch (err) {
        console.error(`session-manager: failed to send finalization notification:`, err)
      }
    }

    return newId
  }
}
