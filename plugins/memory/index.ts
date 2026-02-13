import type { Plugin, PreCompactionContext } from '../../server/plugin.ts'
import type { Message } from '../../server/types.ts'
import { getKnowledgeDir } from '../../server/session.ts'
import { join } from 'path'

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

const DEFAULT_USER_MD = `\
### Identity
- **Name**: ...
- **Location**: ...
- **Job/Role**: ...

### Preferences
- **Communication style**: ...
- **Interests**: ...

### Daily Life
- **Routines**: ...
- **Hobbies**: ...

### Projects
- ...

### Accounts & Services
- ...
`

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

export default function createMemoryPlugin(serverContext?: { config?: { session?: { compactionTrimLength?: number } } }): Plugin {
  const compactionTrimLength = serverContext?.config?.session?.compactionTrimLength ?? 200

  return {
    name: 'memory',
    description: `Long-term memory. Stored as markdown files in ~/.toebeans/knowledge/.`,

    async onPreCompaction(context: PreCompactionContext) {
      const { sessionId, messages, provider } = context

      // trim tool results before sending to LLM
      const trimmed = trimForCompaction(messages, compactionTrimLength)

      // append extraction prompt
      const extractionPrompt = buildExtractionPrompt()
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
        await Bun.write(userKnowledgePath, DEFAULT_USER_MD)
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
          `Use bash to read any of these files when you need context. ` +
          `You can also create or edit markdown files here and they'll be surfaced automatically in future conversations.`
        )
      }

      return parts.length > 0 ? parts.join('\n\n') : null
    },
  }
}
