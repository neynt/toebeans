import type { Plugin, PreCompactionContext } from '../../server/plugin.ts'
import type { Tool, ToolResult, Message } from '../../server/types.ts'
import { getKnowledgeDir } from '../../server/session.ts'
import { join } from 'path'
import { $ } from 'bun'

const EXTRACTION_PROMPT = `You are extracting knowledge from a conversation that is about to be compacted. Respond with two sections:

## Summary
Brief summary of what happened in this conversation. Include key events, decisions, and outcomes.

## User Knowledge
New facts learned about the user (preferences, environment, projects, communication style). If nothing new was learned, write "nothing new".

Be concise.`

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

function createMemoryTools(): Tool[] {
  return [
    {
      name: 'remember',
      description: 'Store information in long-term memory. Creates a markdown file in the knowledge directory.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic/filename for the memory (e.g., "user-preferences")' },
          content: { type: 'string', description: 'Markdown content to store' },
          append: { type: 'boolean', description: 'If true, append to existing file instead of overwriting' },
        },
        required: ['topic', 'content'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { topic, content, append } = input as { topic: string; content: string; append?: boolean }
        const knowledgeDir = getKnowledgeDir()
        const filename = topic.endsWith('.md') ? topic : `${topic}.md`
        const filepath = join(knowledgeDir, filename)

        try {
          if (append) {
            const file = Bun.file(filepath)
            const existing = (await file.exists()) ? await file.text() : ''
            await Bun.write(filepath, existing + '\n\n' + content)
          } else {
            await Bun.write(filepath, content)
          }
          return { content: `Stored memory: ${filename}` }
        } catch (err) {
          return { content: `Failed to store memory: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'recall',
      description: 'Search and retrieve information from long-term memory.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (searches file names and content)' },
          topic: { type: 'string', description: 'Specific topic/file to read (optional)' },
        },
        required: [],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { query, topic } = input as { query?: string; topic?: string }
        const knowledgeDir = getKnowledgeDir()

        try {
          // if specific topic requested, just read that file
          if (topic) {
            const filename = topic.endsWith('.md') ? topic : `${topic}.md`
            const filepath = join(knowledgeDir, filename)
            const file = Bun.file(filepath)

            if (await file.exists()) {
              const content = await file.text()
              return { content: `# ${topic}\n\n${content}` }
            } else {
              return { content: `No memory found for topic: ${topic}` }
            }
          }

          // list all memories if no query
          if (!query) {
            const glob = new Bun.Glob('*.md')
            const files: string[] = []
            for await (const file of glob.scan(knowledgeDir)) {
              files.push(file.replace('.md', ''))
            }
            if (files.length === 0) {
              return { content: 'No memories stored yet.' }
            }
            return { content: `Available memories:\n${files.map(f => `- ${f}`).join('\n')}` }
          }

          // search with grep
          try {
            const result = await $`rg --line-number --max-count 20 -i ${query} ${knowledgeDir}`.quiet()
            const output = result.stdout.toString()
            if (!output) {
              return { content: `No memories matching: ${query}` }
            }
            return { content: output }
          } catch (err: unknown) {
            const error = err as { exitCode?: number }
            if (error.exitCode === 1) {
              return { content: `No memories matching: ${query}` }
            }
            throw err
          }
        } catch (err) {
          return { content: `Failed to recall memory: ${err}`, is_error: true }
        }
      },
    },
  ]
}

interface MemoryConfig {
  recentLogDays?: number
}

export default function createMemoryPlugin(serverContext?: { config?: { session?: { compactionTrimLength?: number } } }): Plugin {
  let pluginConfig: MemoryConfig = {}
  const compactionTrimLength = serverContext?.config?.session?.compactionTrimLength ?? 200

  return {
    name: 'memory',
    description: `Long-term memory. Stored as markdown files in ~/.toebeans/knowledge/.`,
    tools: createMemoryTools(),

    async init(cfg: unknown) {
      pluginConfig = (cfg as MemoryConfig) ?? {}
    },

    async onPreCompaction(context: PreCompactionContext) {
      const { sessionId, messages, provider } = context

      // trim tool results before sending to LLM
      const trimmed = trimForCompaction(messages, compactionTrimLength)

      // append extraction prompt
      const lastMsg = trimmed[trimmed.length - 1]
      if (lastMsg?.role === 'user') {
        lastMsg.content.push({ type: 'text', text: EXTRACTION_PROMPT })
      } else {
        trimmed.push({
          role: 'user',
          content: [{ type: 'text', text: EXTRACTION_PROMPT }],
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

      // parse sections
      const summaryMatch = result.match(/## Summary\s*\n([\s\S]*?)(?=## User Knowledge|$)/)
      const knowledgeMatch = result.match(/## User Knowledge\s*\n([\s\S]*)/)

      const summary = summaryMatch?.[1]?.trim() || result.trim()
      const knowledgeRaw = knowledgeMatch?.[1]?.trim()
      const knowledge = knowledgeRaw && !/^nothing new/i.test(knowledgeRaw) ? knowledgeRaw : null

      // write summary to daily log
      await appendToDailyLog(summary, sessionId)

      // write user knowledge to USER.md
      if (knowledge) {
        console.log(`memory: extracted knowledge from session ${sessionId}`)
        await appendToKnowledge(knowledge)
      }
    },

    async buildSystemPrompt() {
      const parts: string[] = []
      const knowledgeDir = getKnowledgeDir()

      // user knowledge
      const userKnowledgePath = join(knowledgeDir, 'USER.md')
      const userKnowledgeFile = Bun.file(userKnowledgePath)
      if (await userKnowledgeFile.exists()) {
        const content = await userKnowledgeFile.text()
        if (content.trim()) {
          parts.push(content)
        }
      }

      // recent daily logs
      const recentLogDays = pluginConfig.recentLogDays ?? 2
      const recentLogs: string[] = []
      const today = new Date()
      const dates: Date[] = []
      for (let i = 0; i < recentLogDays; i++) {
        const d = new Date(today)
        d.setDate(d.getDate() - i)
        dates.push(d)
      }

      for (const date of dates) {
        const dateStr = date.toISOString().slice(0, 10)
        const dailyLogPath = join(knowledgeDir, `${dateStr}.md`)
        const dailyLogFile = Bun.file(dailyLogPath)
        if (await dailyLogFile.exists()) {
          const content = await dailyLogFile.text()
          if (content.trim()) {
            recentLogs.push(content)
          }
        }
      }

      if (recentLogs.length > 0) {
        parts.push('## Recent Activity\n\n' + recentLogs.join('\n\n'))
      }

      return parts.length > 0 ? parts.join('\n\n') : null
    },
  }
}
