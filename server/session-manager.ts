import type { LlmProvider } from './llm-provider.ts'
import type { Message } from './types.ts'
import type { Config } from './config.ts'
import { repairMessages } from './agent.ts'
import {
  getCurrentSessionId,
  loadSession,
  markSessionFinished,
  isSessionFinished,
  estimateSessionTokens,
  getSessionLastActivity,
  getSessionCreatedAt,
  writeSession,
  setCurrentSessionId,
  generateSessionId,
  getKnowledgeDir,
} from './session.ts'
import { join } from 'path'

const COMPACTION_PROMPT = `Summarize this conversation for your future self. You are being compacted — this summary will be the only context you have when the conversation continues.

Write two sections:

## Summary
Concise summary of what happened. Include key topics, decisions, completed tasks, and any pending tasks. Preserve important details like IDs, names, and technical specifics you'll need.

## User Knowledge
New facts learned about the user (preferences, environment, projects, communication style). If nothing new was learned, write "nothing new".

Be brief but don't lose anything you'd regret forgetting.`

export interface SessionManager {
  getSessionForMessage(): Promise<string>
  checkCompaction(sessionId: string): Promise<void>
  forceCompact(sessionId: string): Promise<string>
  getSessionInfo(sessionId: string): Promise<{
    id: string
    messageCount: number
    estimatedTokens: number
    createdAt: Date | null
    lastActivity: Date | null
  }>
}

export function createSessionManager(
  provider: LlmProvider,
  config: Config,
  routeOutput?: (target: string, message: any) => Promise<void>,
): SessionManager {
  const { compactAtTokens, lifespanSeconds } = config.session

  // trim tool_result content to keep compaction cache-friendly
  // the actual messages stay intact so the cache prefix hits
  function trimForCompaction(messages: Message[]): Message[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content.map(block => {
        if (block.type === 'tool_result') {
          const trimmed = block.content.length > 200
            ? block.content.slice(0, 200) + '... (truncated)'
            : block.content
          return { ...block, content: trimmed }
        }
        return block
      }),
    }))
  }

  async function compactAndExtract(messages: Message[]): Promise<{ summary: string; knowledge: string | null }> {
    // send the actual session messages (cache-friendly!) with tool results trimmed,
    // then append a user message asking for the summary
    const trimmed = trimForCompaction(messages)

    // if last message is a user message, merge the prompt into it to avoid consecutive user messages
    const lastMsg = trimmed[trimmed.length - 1]
    if (lastMsg?.role === 'user') {
      lastMsg.content.push({ type: 'text', text: COMPACTION_PROMPT })
    } else {
      trimmed.push({
        role: 'user',
        content: [{ type: 'text', text: COMPACTION_PROMPT }],
      })
    }

    let result = ''
    for await (const chunk of provider.stream({
      messages: trimmed,
      system: 'You are being compacted. Respond with the requested summary.',
      tools: [],
    })) {
      if (chunk.type === 'text') {
        result += chunk.text
      }
    }

    // parse out sections
    const summaryMatch = result.match(/## Summary\s*\n([\s\S]*?)(?=## User Knowledge|$)/)
    const knowledgeMatch = result.match(/## User Knowledge\s*\n([\s\S]*)/)

    const summary = summaryMatch?.[1]?.trim() || result.trim()
    const knowledgeRaw = knowledgeMatch?.[1]?.trim()
    const knowledge = knowledgeRaw && !/^nothing new/i.test(knowledgeRaw) ? knowledgeRaw : null

    return { summary, knowledge }
  }

  async function appendToKnowledge(content: string): Promise<void> {
    const knowledgePath = join(getKnowledgeDir(), 'USER.md')
    const file = Bun.file(knowledgePath)
    const timestamp = new Date().toISOString().slice(0, 10)
    const entry = `\n## ${timestamp}\n\n${content}\n`

    if (await file.exists()) {
      const existing = await file.text()
      await Bun.write(knowledgePath, existing + entry)
    } else {
      await Bun.write(knowledgePath, `# About the user\n${entry}`)
    }
  }

  async function appendToDailyLog(content: string, sessionId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    const dailyLogPath = join(getKnowledgeDir(), `${today}.md`)
    const file = Bun.file(dailyLogPath)
    const timestamp = new Date().toISOString().slice(11, 19)
    const entry = `\n### ${timestamp} (session ${sessionId})\n\n${content}\n`

    if (await file.exists()) {
      const existing = await file.text()
      await Bun.write(dailyLogPath, existing + entry)
    } else {
      await Bun.write(dailyLogPath, `# Daily Log - ${today}\n${entry}`)
    }
  }

  async function compactSession(sessionId: string): Promise<string> {
    const beforeTokens = await estimateSessionTokens(sessionId)
    console.log(`session-manager: compacting session ${sessionId} (${beforeTokens} tokens)`)

    const rawMessages = await loadSession(sessionId)
    if (rawMessages.length === 0) {
      // nothing to compact, just create new session
      const newId = await generateSessionId()
      await markSessionFinished(sessionId)
      await setCurrentSessionId(newId)
      return newId
    }

    // repair interrupted tool calls before sending to API
    const messages = repairMessages(rawMessages)

    // generate summary + extract knowledge in one call (cache-friendly)
    const { summary, knowledge } = await compactAndExtract(messages)

    // write summary to daily log
    await appendToDailyLog(summary, sessionId)

    // write user knowledge to USER.md (only salient/permanent info)
    if (knowledge) {
      console.log(`session-manager: extracted knowledge`)
      await appendToKnowledge(knowledge)
    }

    // mark old session as finished
    await markSessionFinished(sessionId)

    // create new session with summary as context
    const newId = await generateSessionId()
    const summaryMessage: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Previous conversation summary]\n\n${summary}\n\n[End of summary - new conversation starts here]`,
      }],
    }
    await writeSession(newId, [summaryMessage])
    await setCurrentSessionId(newId)

    const afterTokens = await estimateSessionTokens(newId)
    console.log(`session-manager: compacted ${beforeTokens} -> ${afterTokens} tokens (new session ${newId})`)

    // send compaction report to discord if routeOutput is available
    if (routeOutput && config.notifyOnRestart) {
      try {
        const formattedBefore = beforeTokens.toLocaleString()
        const formattedAfter = afterTokens.toLocaleString()
        await routeOutput(config.notifyOnRestart, {
          type: 'text',
          text: `compacted: ${formattedBefore} → ${formattedAfter} tokens`
        })
        await routeOutput(config.notifyOnRestart, { type: 'text_block_end' })
      } catch (err) {
        console.error(`session-manager: failed to send compaction notification:`, err)
      }
    }

    return newId
  }

  return {
    async getSessionForMessage(): Promise<string> {
      const sessionId = await getCurrentSessionId()

      // check if session is finished
      if (await isSessionFinished(sessionId)) {
        // create new session
        const newId = await generateSessionId()
        await setCurrentSessionId(newId)
        return newId
      }

      // check if session is stale (inactive for too long) — compact before new message lands
      const lastActivity = await getSessionLastActivity(sessionId)
      if (lastActivity) {
        const ageSeconds = (Date.now() - lastActivity.getTime()) / 1000
        if (ageSeconds >= lifespanSeconds) {
          console.log(`session-manager: session ${sessionId} is ${Math.floor(ageSeconds / 60)} minutes stale, compacting before new message`)
          const newId = await compactSession(sessionId)
          return newId
        }
      }

      return sessionId
    },

    async checkCompaction(sessionId: string): Promise<void> {
      // check token count
      const tokens = await estimateSessionTokens(sessionId)
      if (tokens >= compactAtTokens) {
        console.log(`session-manager: session ${sessionId} has ${tokens} tokens, compacting`)
        await compactSession(sessionId)
        return
      }

      // check lifespan
      const lastActivity = await getSessionLastActivity(sessionId)
      if (lastActivity) {
        const ageSeconds = (Date.now() - lastActivity.getTime()) / 1000
        if (ageSeconds >= lifespanSeconds) {
          console.log(`session-manager: session ${sessionId} is ${Math.floor(ageSeconds / 60)} minutes old, compacting`)
          await compactSession(sessionId)
          return
        }
      }
    },

    async forceCompact(sessionId: string): Promise<string> {
      console.log(`session-manager: forcing compaction of session ${sessionId}`)
      return await compactSession(sessionId)
    },

    async getSessionInfo(sessionId: string) {
      const messages = await loadSession(sessionId)
      const tokens = await estimateSessionTokens(sessionId)
      const createdAt = await getSessionCreatedAt(sessionId)
      const lastActivity = await getSessionLastActivity(sessionId)

      return {
        id: sessionId,
        messageCount: messages.length,
        estimatedTokens: tokens,
        createdAt,
        lastActivity,
      }
    },
  }
}
