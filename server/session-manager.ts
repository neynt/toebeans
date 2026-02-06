import type { LlmProvider } from './llm-provider.ts'
import type { Message } from './types.ts'
import type { Config } from './config.ts'
import {
  getCurrentSessionId,
  loadSession,
  markSessionFinished,
  isSessionFinished,
  estimateSessionTokens,
  getSessionLastActivity,
  writeSession,
  setCurrentSessionId,
  generateSessionId,
  getKnowledgeDir,
} from './session.ts'
import { join } from 'path'

const SUMMARY_PROMPT = `Summarize this conversation concisely. Include:
1. Key topics discussed
2. Important decisions or conclusions
3. Any tasks that were completed or are pending
4. Relevant context for continuing the conversation

Be brief but preserve important details. Write in past tense.`

const KNOWLEDGE_PROMPT = `Based on this conversation, extract any new facts learned about the user that would be useful to remember for future conversations. This includes:
- Personal preferences
- Technical environment details
- Projects they're working on
- Communication style preferences
- Important dates or deadlines mentioned

If nothing new was learned, respond with "NONE".
Format as bullet points if there are items to note.`

export interface SessionManager {
  getSessionForMessage(): Promise<string>
  checkCompaction(sessionId: string): Promise<void>
}

export function createSessionManager(
  provider: LlmProvider,
  config: Config,
): SessionManager {
  const { compactAtTokens, lifespanSeconds } = config.session

  async function summarizeSession(messages: Message[]): Promise<string> {
    const conversationText = messages
      .map(m => {
        const role = m.role
        const text = m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        return `${role}: ${text}`
      })
      .join('\n\n')

    let summary = ''
    for await (const chunk of provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `${SUMMARY_PROMPT}\n\n---\n\n${conversationText}` }],
      }],
      system: 'You are a helpful assistant that summarizes conversations.',
      tools: [],
    })) {
      if (chunk.type === 'text') {
        summary += chunk.text
      }
    }
    return summary.trim()
  }

  async function extractKnowledge(messages: Message[]): Promise<string | null> {
    const conversationText = messages
      .map(m => {
        const role = m.role
        const text = m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        return `${role}: ${text}`
      })
      .join('\n\n')

    let knowledge = ''
    for await (const chunk of provider.stream({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `${KNOWLEDGE_PROMPT}\n\n---\n\n${conversationText}` }],
      }],
      system: 'You are a helpful assistant that extracts user information from conversations.',
      tools: [],
    })) {
      if (chunk.type === 'text') {
        knowledge += chunk.text
      }
    }

    const trimmed = knowledge.trim()
    if (trimmed === 'NONE' || trimmed.length === 0) {
      return null
    }
    return trimmed
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

  async function compactSession(sessionId: string): Promise<string> {
    console.log(`session-manager: compacting session ${sessionId}`)

    const messages = await loadSession(sessionId)
    if (messages.length === 0) {
      // nothing to compact, just create new session
      const newId = await generateSessionId()
      await markSessionFinished(sessionId)
      await setCurrentSessionId(newId)
      return newId
    }

    // generate summary
    const summary = await summarizeSession(messages)
    console.log(`session-manager: generated summary (${summary.length} chars)`)

    // extract knowledge
    const knowledge = await extractKnowledge(messages)
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
    const ackMessage: Message = {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Got it, I have the context from our previous conversation. How can I help?',
      }],
    }
    await writeSession(newId, [summaryMessage, ackMessage])
    await setCurrentSessionId(newId)

    console.log(`session-manager: created new session ${newId}`)
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
  }
}
