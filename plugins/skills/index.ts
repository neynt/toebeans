import type { Plugin } from '../../server/plugin.ts'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { readdir, mkdir } from 'node:fs/promises'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const CORE_SKILLS_DIR = join(REPO_ROOT, 'skills')
const USER_SKILLS_DIR = join(homedir(), '.toebeans', 'skills')

type SkillSource = 'core' | 'user'

interface SkillEntry {
  name: string
  description: string
  dir: string
  source: SkillSource
  skillDir: string // absolute path to the skill's root directory
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

async function scanSkillsDir(baseDir: string, source: SkillSource): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []
  const glob = new Bun.Glob('*/SKILL.md')
  try {
    for await (const path of glob.scan(baseDir)) {
      const dir = path.replace('/SKILL.md', '')
      const fullPath = join(baseDir, path)
      try {
        const content = await Bun.file(fullPath).text()
        const fm = parseFrontmatter(content)
        if (fm?.name && fm?.description) {
          skills.push({ name: fm.name, description: fm.description, dir, source, skillDir: join(baseDir, dir) })
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory doesn't exist, that's fine
  }
  return skills
}

async function discoverSkills(): Promise<SkillEntry[]> {
  const [coreSkills, userSkills] = await Promise.all([
    scanSkillsDir(CORE_SKILLS_DIR, 'core'),
    scanSkillsDir(USER_SKILLS_DIR, 'user'),
  ])

  // user skills override core skills with the same dir name
  const byDir = new Map<string, SkillEntry>()
  for (const s of coreSkills) byDir.set(s.dir, s)
  for (const s of userSkills) byDir.set(s.dir, s)

  const skills = [...byDir.values()]
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/** Resolve a skill dir name to its absolute path, checking user first then core. */
async function resolveSkillDir(skill: string): Promise<{ path: string; source: SkillSource } | null> {
  const userPath = join(USER_SKILLS_DIR, skill)
  const corePath = join(CORE_SKILLS_DIR, skill)
  // check user first
  if (await Bun.file(join(userPath, 'SKILL.md')).exists()) {
    return { path: userPath, source: 'user' }
  }
  if (await Bun.file(join(corePath, 'SKILL.md')).exists()) {
    return { path: corePath, source: 'core' }
  }
  return null
}

export default function createSkillsPlugin(): Plugin {
  return {
    name: 'skills',
    description: `Manages reusable Skills — core skills in repo, user skills in ${USER_SKILLS_DIR}/`,

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
            return { content: `No skills found in ${CORE_SKILLS_DIR}/ or ${USER_SKILLS_DIR}/` }
          }
          const lines = skills.map(s => {
            const tag = s.source === 'core' ? '[core]' : '[user]'
            return `- **${s.name}** ${tag} (${s.dir}/): ${s.description}`
          })
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
          const resolved = await resolveSkillDir(skill)
          if (!resolved) {
            return { content: `Skill not found: ${skill}`, is_error: true }
          }
          const filePath = join(resolved.path, file)
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
        description: 'Create a new user skill skeleton with a SKILL.md file',
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
          const skillDir = join(USER_SKILLS_DIR, dirName)
          const skillPath = join(skillDir, 'SKILL.md')

          // check if it already exists in either location
          if (await Bun.file(skillPath).exists()) {
            return { content: `Skill already exists at ${skillPath}. Use bash to edit it directly.`, is_error: true }
          }
          const corePath = join(CORE_SKILLS_DIR, dirName, 'SKILL.md')
          if (await Bun.file(corePath).exists()) {
            return { content: `A core skill already exists at ${corePath}. Create a user override by copying it to ${skillDir}/ first.`, is_error: true }
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
          const resolved = await resolveSkillDir(skill)
          if (!resolved) {
            return { content: `Skill not found: ${skill}`, is_error: true }
          }
          try {
            const entries = await readdir(resolved.path)
            return { content: entries.join('\n') }
          } catch {
            return { content: `Skill directory not found: ${resolved.path}`, is_error: true }
          }
        },
      },
    ],

    async buildSystemPrompt() {
      try {
        const skills = await discoverSkills()
        if (skills.length === 0) return null

        const lines = skills.map(s => {
          const tag = s.source === 'core' ? '[core]' : '[user]'
          return `- **${s.name}** ${tag}: ${s.description}`
        })
        return (
          `## Available Skills\n\n` +
          `Skills are loaded from two locations:\n` +
          `- Core: ${CORE_SKILLS_DIR}/\n` +
          `- User: ${USER_SKILLS_DIR}/ (overrides core)\n\n` +
          `Use the skills_read tool to load a skill when relevant.\n\n` +
          lines.join('\n')
        )
      } catch {
        return null
      }
    },
  }
}
