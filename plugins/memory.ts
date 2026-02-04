import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, ToolContext } from '../server/types.ts'
import { getKnowledgeDir } from '../server/session.ts'
import { join, resolve } from 'path'
import { $ } from 'bun'

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

export default function createMemoryPlugin(): Plugin {
  return {
    name: 'memory',
    summary: 'Long-term memory available. Use load_plugin("memory") for remember/recall tools.',
    description: `Long-term memory system:
- remember(topic, content): Store markdown content under a topic
- recall(query): Search memories by content
- recall(topic=...): Read a specific memory file

Memories are stored as markdown files in ~/.local/share/toebeans/knowledge/`,
    tools: createMemoryTools(),
  }
}
