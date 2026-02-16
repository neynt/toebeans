import type { Plugin } from '../../server/plugin.ts'
import { join } from 'path'
import { homedir } from 'os'
import { readdir, mkdir } from 'node:fs/promises'

const SKILLS_DIR = join(homedir(), '.toebeans', 'skills')

interface SkillEntry {
  name: string
  description: string
  dir: string
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return null
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/)
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  return result
}

async function discoverSkills(): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []
  const glob = new Bun.Glob('*/SKILL.md')
  for await (const path of glob.scan(SKILLS_DIR)) {
    const dir = path.replace('/SKILL.md', '')
    const fullPath = join(SKILLS_DIR, path)
    try {
      const content = await Bun.file(fullPath).text()
      const fm = parseFrontmatter(content)
      if (fm?.name && fm?.description) {
        skills.push({ name: fm.name, description: fm.description, dir })
      }
    } catch {
      // skip unreadable files
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

export default function createSkillsPlugin(): Plugin {
  return {
    name: 'skills',
    description: `Manages reusable Skills — markdown instruction sets in ${SKILLS_DIR}/`,

    tools: [
      {
        name: 'skills_list',
        description: 'List all available skills with their names and descriptions',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        async execute() {
          const skills = await discoverSkills()
          if (skills.length === 0) {
            return { content: `No skills found in ${SKILLS_DIR}/` }
          }
          const lines = skills.map(s => `- **${s.name}** (${s.dir}/): ${s.description}`)
          return { content: lines.join('\n') }
        },
      },
      {
        name: 'skills_read',
        description: 'Read a skill file. Returns the content of a file within a skill directory.',
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill directory name (e.g. "writing-skills")' },
            file: { type: 'string', description: 'File to read, relative to skill dir. Defaults to SKILL.md', default: 'SKILL.md' },
          },
          required: ['skill'],
        },
        async execute(input: unknown) {
          const { skill, file = 'SKILL.md' } = input as { skill: string; file?: string }
          const filePath = join(SKILLS_DIR, skill, file)
          try {
            const content = await Bun.file(filePath).text()
            return { content }
          } catch {
            return { content: `File not found: ${filePath}`, is_error: true }
          }
        },
      },
      {
        name: 'skills_create',
        description: 'Create a new skill skeleton with a SKILL.md file',
        inputSchema: {
          type: 'object',
          properties: {
            dirName: { type: 'string', description: 'Directory name for the skill (kebab-case, e.g. "processing-pdfs")' },
            name: { type: 'string', description: 'Skill name (kebab-case gerund, e.g. "processing-pdfs")' },
            description: { type: 'string', description: 'What the skill does and when to use it (third person, include trigger keywords)' },
            content: { type: 'string', description: 'Markdown body of the SKILL.md (everything after the frontmatter)' },
          },
          required: ['dirName', 'name', 'description', 'content'],
        },
        async execute(input: unknown) {
          const { dirName, name, description, content } = input as {
            dirName: string; name: string; description: string; content: string
          }
          const skillDir = join(SKILLS_DIR, dirName)
          const skillPath = join(skillDir, 'SKILL.md')

          // check if it already exists
          if (await Bun.file(skillPath).exists()) {
            return { content: `Skill already exists at ${skillPath}. Use bash to edit it directly.`, is_error: true }
          }

          await mkdir(skillDir, { recursive: true })
          const fileContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`
          await Bun.write(skillPath, fileContent)
          return { content: `Created skill at ${skillPath}` }
        },
      },
      {
        name: 'skills_list_files',
        description: 'List all files in a skill directory',
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill directory name' },
          },
          required: ['skill'],
        },
        async execute(input: unknown) {
          const { skill } = input as { skill: string }
          const skillDir = join(SKILLS_DIR, skill)
          try {
            const entries = await readdir(skillDir)
            return { content: entries.join('\n') }
          } catch {
            return { content: `Skill directory not found: ${skillDir}`, is_error: true }
          }
        },
      },
    ],

    async buildSystemPrompt() {
      try {
        const skills = await discoverSkills()
        if (skills.length === 0) return null

        const lines = skills.map(s => `- **${s.name}**: ${s.description}`)
        return (
          `## Available Skills\n\n` +
          `Skills are located in ${SKILLS_DIR}/. Use the skills_read tool to load a skill when relevant.\n\n` +
          lines.join('\n')
        )
      } catch {
        return null
      }
    },
  }
}
