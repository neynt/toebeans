import { countTokens } from './tokens.ts'
import type { LlmProvider } from './llm-provider.ts'
import type { Message, MessageCost, SessionEntry } from './types.ts'
import type { Config } from './config.ts'
import type { PluginManager } from './plugin.ts'
import { repairMessages } from './agent.ts'
import {
  getCurrentSessionId,
  loadSession,
  loadCostEntries,
  estimateSessionTokens,
  getSessionLastActivity,
  getSessionCreatedAt,
  writeSession,
  generateSessionId,
} from './session.ts'
import { computeInputOutputCost, type UsageTotals } from './cost.ts'

const DEFAULT_COMPACTION_PROMPT = `Summarize this conversation for your future self. You are being compacted — this summary will be the only context you have when the conversation continues.

Be brief but don't lose anything you'd regret forgetting. Include key topics, decisions, completed tasks, pending tasks, and important details like IDs, names, and technical specifics.`

export interface SessionManager {
  getSessionForMessage(route?: string): Promise<string>
  checkCompaction(sessionId: string, route?: string): Promise<void>
  forceCompact(sessionId: string, route?: string): Promise<string>
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
): SessionManager {
  const { compactAtTokens, compactMinTokens, lifespanSeconds } = config.session
  const compactionPrompt = config.session.compactionPrompt || DEFAULT_COMPACTION_PROMPT
  const compactionTrimLength = config.session.compactionTrimLength ?? 200

  async function getSystemPromptTokens(): Promise<number> {
    if (!buildSystemPrompt) return 0
    const prompt = await buildSystemPrompt()
    return countTokens(prompt)
  }

  // trim tool_result content to keep compaction cache-friendly
  function trimForCompaction(messages: Message[]): Message[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content.map(block => {
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') {
            const trimmed = block.content.length > compactionTrimLength
              ? block.content.slice(0, compactionTrimLength) + '... (truncated)'
              : block.content
            return { ...block, content: trimmed }
          }
          const trimmed = block.content
            .filter(b => b.type === 'text')
            .map(b => {
              if (b.type === 'text' && b.text.length > compactionTrimLength) {
                return { ...b, text: b.text.slice(0, compactionTrimLength) + '... (truncated)' }
              }
              return b
            })
          return { ...block, content: trimmed }
        }
        return block
      }),
    }))
  }

  async function generateSummary(messages: Message[]): Promise<{ text: string; usage: UsageTotals }> {
    const trimmed = trimForCompaction(messages)

    const lastMsg = trimmed[trimmed.length - 1]
    if (lastMsg?.role === 'user') {
      lastMsg.content.push({ type: 'text', text: compactionPrompt })
    } else {
      trimmed.push({
        role: 'user',
        content: [{ type: 'text', text: compactionPrompt }],
      })
    }

    let result = ''
    const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for await (const chunk of provider.stream({
      messages: trimmed,
      system: 'You are being compacted. Respond with the requested summary.',
      tools: [],
    })) {
      if (chunk.type === 'text') {
        result += chunk.text
      } else if (chunk.type === 'usage') {
        usage.input += chunk.input
        usage.output += chunk.output
        usage.cacheRead += chunk.cacheRead ?? 0
        usage.cacheWrite += chunk.cacheWrite ?? 0
      }
    }

    return { text: result.trim(), usage }
  }

  async function compactSession(sessionId: string, route?: string): Promise<string> {
    const beforeTokens = await estimateSessionTokens(sessionId)
    console.log(`session-manager: compacting session ${sessionId} (${beforeTokens} tokens, route: ${route || '_default'})`)

    const rawMessages = await loadSession(sessionId)
    if (rawMessages.length === 0) {
      return await generateSessionId(route)
    }

    // repair interrupted tool calls before sending to API
    const messages = repairMessages(rawMessages)

    // fire pre-compaction hooks (plugins can extract knowledge, write logs, etc.)
    if (pluginManager) {
      await pluginManager.firePreCompaction({ sessionId, route, messages, provider })
    }

    // generate summary (and capture compaction LLM usage)
    const { text: summary, usage: compactionUsage } = await generateSummary(messages)

    // compute compaction cost
    const compactionCosts = computeInputOutputCost(compactionUsage, config.llm.model)
    const compactionCost: MessageCost = {
      inputCost: compactionCosts?.inputCost ?? 0,
      outputCost: compactionCosts?.outputCost ?? 0,
      usage: {
        input: compactionUsage.input,
        output: compactionUsage.output,
        cacheRead: compactionUsage.cacheRead,
        cacheWrite: compactionUsage.cacheWrite,
      },
    }

    // compute old session's total cost for the notification
    const oldCostEntries = await loadCostEntries(sessionId)
    const oldSessionCost = oldCostEntries.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)
      + compactionCost.inputCost + compactionCost.outputCost

    // create new session with system_prompt + summary message (cost attached to summary)
    const newId = await generateSessionId(route)
    const now = new Date().toISOString()
    const systemPrompt = buildSystemPrompt ? await buildSystemPrompt() : ''
    const summaryMessage: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Previous conversation summary]\n\n${summary}\n\n[End of summary - new conversation starts here]`,
      }],
    }
    const entries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: now, content: systemPrompt },
      { type: 'message', timestamp: now, message: summaryMessage, cost: compactionCost },
    ]
    await writeSession(newId, entries)

    const afterTokens = await estimateSessionTokens(newId)
    console.log(`session-manager: compacted ${beforeTokens} -> ${afterTokens} tokens (new session ${newId})`)

    // send compaction report if routeOutput is available
    if (routeOutput && config.notifyOnRestart) {
      try {
        const formattedBefore = beforeTokens.toLocaleString()
        const formattedAfter = afterTokens.toLocaleString()
        const costStr = `$${oldSessionCost.toFixed(2)}`
        await routeOutput(config.notifyOnRestart, {
          type: 'text',
          text: `🔄 \`compacted\` old: \`${sessionId}\` → new: \`${newId}\` (${formattedBefore} → ${formattedAfter} tokens, old session cost: ${costStr})`
        })
        await routeOutput(config.notifyOnRestart, { type: 'text_block_end' })
      } catch (err) {
        console.error(`session-manager: failed to send compaction notification:`, err)
      }
    }

    return newId
  }

  return {
    async getSessionForMessage(route?: string): Promise<string> {
      const sessionId = await getCurrentSessionId(route)

      // check if session is stale (inactive for too long) — compact before new message lands
      const lastActivity = await getSessionLastActivity(sessionId)
      if (lastActivity) {
        const ageSeconds = (Date.now() - lastActivity.getTime()) / 1000
        if (ageSeconds >= lifespanSeconds) {
          const tokens = await estimateSessionTokens(sessionId) + await getSystemPromptTokens()
          if (tokens < compactMinTokens) {
            console.log(`session-manager: session ${sessionId} is stale but only ${tokens} tokens (< ${compactMinTokens}), skipping compaction`)
          } else {
            console.log(`session-manager: session ${sessionId} is ${Math.floor(ageSeconds / 60)} minutes stale (${tokens} tokens), compacting before new message`)
            const newId = await compactSession(sessionId, route)
            return newId
          }
        }
      }

      return sessionId
    },

    async checkCompaction(sessionId: string, route?: string): Promise<void> {
      // check token count (messages + system prompt = real context usage)
      const tokens = await estimateSessionTokens(sessionId) + await getSystemPromptTokens()
      if (tokens >= compactAtTokens) {
        console.log(`session-manager: session ${sessionId} has ${tokens} tokens, compacting`)
        await compactSession(sessionId, route)
        return
      }

      // check lifespan (only compact if tokens meet minimum threshold)
      const lastActivity = await getSessionLastActivity(sessionId)
      if (lastActivity) {
        const ageSeconds = (Date.now() - lastActivity.getTime()) / 1000
        if (ageSeconds >= lifespanSeconds) {
          if (tokens < compactMinTokens) {
            console.log(`session-manager: session ${sessionId} is stale but only ${tokens} tokens (< ${compactMinTokens}), skipping compaction`)
          } else {
            console.log(`session-manager: session ${sessionId} is ${Math.floor(ageSeconds / 60)} minutes old (${tokens} tokens), compacting`)
            await compactSession(sessionId, route)
          }
          return
        }
      }
    },

    async forceCompact(sessionId: string, route?: string): Promise<string> {
      console.log(`session-manager: forcing compaction of session ${sessionId}`)
      return await compactSession(sessionId, route)
    },

    async resetSession(sessionId: string, route?: string): Promise<string> {
      console.log(`session-manager: resetting session ${sessionId} (route: ${route || '_default'})`)

      const rawMessages = await loadSession(sessionId)

      // fire pre-compaction hooks so plugins can extract knowledge
      if (pluginManager && rawMessages.length > 0) {
        const messages = repairMessages(rawMessages)
        await pluginManager.firePreCompaction({ sessionId, route, messages, provider })
      }

      // compute old session's total cost
      const oldCostEntries = await loadCostEntries(sessionId)
      const oldSessionCost = oldCostEntries.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)

      // create a brand new empty session (no summary, no carryover)
      const newId = await generateSessionId(route)

      console.log(`session-manager: reset session ${sessionId} → ${newId}`)

      // send reset notification
      if (routeOutput && config.notifyOnRestart) {
        try {
          const costStr = `$${oldSessionCost.toFixed(2)}`
          await routeOutput(config.notifyOnRestart, {
            type: 'text',
            text: `🧹 \`reset\` old: \`${sessionId}\` → new: \`${newId}\` (old session cost: ${costStr})`
          })
          await routeOutput(config.notifyOnRestart, { type: 'text_block_end' })
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
}
