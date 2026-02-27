import type { Plugin, PreCompactionContext } from '../../server/plugin.ts'
import type { Message } from '../../server/types.ts'
import { getKnowledgeDir } from '../../server/session.ts'
import { join } from 'path'
import { formatLocalDate, formatLocalTimeOnly } from '../../server/time.ts'

function buildExtractionPrompt(): string {
  return `You are extracting knowledge from a conversation that is about to be compacted.

## Summary
Brief summary of what happened in this conversation. Include key events, decisions, and outcomes.`
}

function trimForCompaction(messages: Message[], trimLength: number): Message[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content.map(block => {
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          const trimmed = block.content.length > trimLength
            ? block.content.slice(0, trimLength) + '... (truncated)'
            : block.content
          return { ...block, content: trimmed }
        }
        const trimmed = block.content
          .filter(b => b.type === 'text')
          .map(b => {
            if (b.type === 'text' && b.text.length > trimLength) {
              return { ...b, text: b.text.slice(0, trimLength) + '... (truncated)' }
            }
            return b
          })
        return { ...block, content: trimmed }
      }
      return block
    }),
  }))
}

const DEFAULT_USER_MD_PATH = new URL('../../default-config/USER.md', import.meta.url)

async function getDefaultUserMd(): Promise<string> {
  return await Bun.file(DEFAULT_USER_MD_PATH).text()
}

async function appendToDailyLog(content: string, sessionId: string): Promise<void> {
  const now = new Date()
  const today = formatLocalDate(now)
  const dailyLogPath = join(getKnowledgeDir(), `${today}.md`)
  const file = Bun.file(dailyLogPath)
  const timestamp = formatLocalTimeOnly(now)
  const entry = `\n### ${timestamp} (session ${sessionId})\n\n${content}\n`

  if (await file.exists()) {
    const existing = await file.text()
    await Bun.write(dailyLogPath, existing + entry)
  } else {
    await Bun.write(dailyLogPath, `# Daily Log - ${today}\n${entry}`)
  }
}

export default function create(serverContext?: { config?: { session?: { compactionTrimLength?: number }; plugins?: { memory?: { extractionPrompt?: string } } } }): Plugin {
  const compactionTrimLength = serverContext?.config?.session?.compactionTrimLength ?? 200
  const extractionPrompt = serverContext?.config?.plugins?.memory?.extractionPrompt ?? buildExtractionPrompt()

  return {
    name: 'memory',
    description: `Long-term memory. Stored as markdown files in ~/.toebeans/knowledge/.`,

    async onPreCompaction(context: PreCompactionContext) {
      const { sessionId, messages, provider } = context

      // trim tool results before sending to LLM
      const trimmed = trimForCompaction(messages, compactionTrimLength)

      // append extraction prompt
      const lastMsg = trimmed[trimmed.length - 1]
      if (lastMsg?.role === 'user') {
        lastMsg.content.push({ type: 'text', text: extractionPrompt })
      } else {
        trimmed.push({
          role: 'user',
          content: [{ type: 'text', text: extractionPrompt }],
        })
      }

      let result = ''
      for await (const chunk of provider.stream({
        messages: trimmed,
        system: 'You are extracting knowledge before compaction. Respond with the requested sections.',
        tools: [],
      })) {
        if (chunk.type === 'text') {
          result += chunk.text
        }
      }

      // parse summary
      const summaryMatch = result.match(/## Summary\s*\n([\s\S]*)/)
      const summary = summaryMatch?.[1]?.trim() || result.trim()

      // write summary to daily log
      await appendToDailyLog(summary, sessionId)
    },

    async buildSystemPrompt() {
      const parts: string[] = []
      const knowledgeDir = getKnowledgeDir()

      // user profile (seed default if missing)
      const userKnowledgePath = join(knowledgeDir, 'USER.md')
      const userKnowledgeFile = Bun.file(userKnowledgePath)
      if (!await userKnowledgeFile.exists()) {
        await Bun.write(userKnowledgePath, await getDefaultUserMd())
      }
      const userContent = await Bun.file(userKnowledgePath).text()
      if (userContent.trim()) {
        parts.push(
          `# User info (${userKnowledgePath})\n` +
          `Below the line is what you know about the user. If you learn anything more about the user that could be useful in the future, add it to the file with bash. Pay special attention to expressed preferences and corrections.\n` +
          `---\n` +
          userContent
        )
      }

      // knowledge directory listing
      const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/
      const excludeFiles = new Set(['USER.md'])
      const glob = new Bun.Glob('*.md')
      const topicFiles: string[] = []
      for await (const file of glob.scan(knowledgeDir)) {
        if (!datePattern.test(file) && !excludeFiles.has(file)) {
          topicFiles.push(file)
        }
      }
      if (topicFiles.length > 0) {
        topicFiles.sort()
        parts.push(
          `# Knowledge directory (${knowledgeDir})\n` +
          `Files:\n` +
          topicFiles.map(f => `- ${f}`).join('\n') + '\n\n' +
          `You should read these files on-demand. Prior to working on any task, read relevant files. ` +
          `Markdown files created here will be surfaced here in future conversations.\n\n` +
          `## Proactive knowledge loading\n` +
          `Treat these knowledge files as extended memory. When the user's message contains relevant keywords or topics, ` +
          `search for and read matching knowledge files BEFORE responding. Examples:\n` +
          `- User asks about schedule, availability, or plans → look for schedule/calendar knowledge files\n` +
          `- User mentions finances, budget, or portfolio → check for finance-related knowledge files\n` +
          `- User references a project by name → load that project's knowledge file if it exists\n` +
          `- User asks about a person (by name, relationship, etc.) → check for knowledge files about that person\n` +
          `- User asks about preferences, habits, or routines → re-read USER.md and check for relevant topic files\n` +
          `- User starts a task in a domain (cooking, travel, coding, etc.) → check for domain-specific knowledge files\n\n` +
          `Don't wait to be asked — if a knowledge file likely contains relevant context, read it proactively. ` +
          `When in doubt, a quick scan of a potentially relevant file is better than missing useful context.\n\n` +
          `## Housekeeping\n` +
          `Keep ~/.toebeans/.gitignore updated to exclude generated files like logs, sessions, and attachments so commits stay clean.`
        )
      }

      return parts.length > 0 ? parts.join('\n\n') : null
    },
  }
}
