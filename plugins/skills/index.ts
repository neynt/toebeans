import type { Plugin } from '../../server/plugin.ts'
import { join, dirname } from 'path'
import { homedir } from 'os'

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const CORE_SKILLS_DIR = join(REPO_ROOT, 'skills')
const USER_SKILLS_DIR = join(homedir(), '.toebeans', 'skills')

type SkillSource = 'core' | 'user'

interface SkillEntry {
  name: string
  description: string
  dir: string
  source: SkillSource
  group?: string   // optional group for collapsing in UI/prompt
}

/** Known prefix → group mappings for auto-grouping. */
const PREFIX_GROUPS: [string, string][] = [
  ['gws-', 'Google Workspace'],
  ['recipe-', 'Recipes'],
  ['persona-', 'Personas'],
]

export interface SkillGroup {
  name: string
  skills: { name: string; dir: string; source: SkillSource; description: string }[]
}

export interface GroupedSkills {
  /** Skills not in any group — shown prominently. */
  ungrouped: { name: string; dir: string; source: SkillSource; description: string }[]
  /** Skill families collapsed behind a group label. */
  groups: SkillGroup[]
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return null
  const result: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/)
    if (kv) {
      result[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim()
    }
  }
  return result
}

async function scanSkillsDir(baseDir: string, source: SkillSource): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []
  const glob = new Bun.Glob('*/SKILL.md')
  try {
    for await (const path of glob.scan({ cwd: baseDir, followSymlinks: true })) {
      const dir = path.replace('/SKILL.md', '')
      const fullPath = join(baseDir, path)
      try {
        const content = await Bun.file(fullPath).text()
        const fm = parseFrontmatter(content)
        if (fm?.name && fm?.description) {
          // explicit group from frontmatter, or auto-detect from prefix
          let group = fm.group
          if (!group) {
            for (const [prefix, groupName] of PREFIX_GROUPS) {
              if (dir.startsWith(prefix)) {
                group = groupName
                break
              }
            }
          }
          skills.push({ name: fm.name, description: fm.description, dir, source, group })
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

/** Group skills into ungrouped (foundational) and named groups. */
function groupSkills(skills: SkillEntry[]): GroupedSkills {
  const groupMap = new Map<string, SkillGroup>()
  const ungrouped: GroupedSkills['ungrouped'] = []

  for (const s of skills) {
    const entry = { name: s.name, dir: s.dir, source: s.source, description: s.description }
    if (s.group) {
      let group = groupMap.get(s.group)
      if (!group) {
        group = { name: s.group, skills: [] }
        groupMap.set(s.group, group)
      }
      group.skills.push(entry)
    } else {
      ungrouped.push(entry)
    }
  }

  const groups = [...groupMap.values()]
  groups.sort((a, b) => a.name.localeCompare(b.name))
  return { ungrouped, groups }
}

export default function create(): Plugin {
  return {
    name: 'skills',
    description: `Provides reusable Skills. Core skills live in ${CORE_SKILLS_DIR}/ and user skills live in ${USER_SKILLS_DIR}/, with user skills overriding core skills that use the same directory name. Inspect skill directories directly with bash when you need to read them.`,

    async status() {
      try {
        const skills = await discoverSkills()
        return {
          skills: skills.map(s => ({
            name: s.name,
            description: s.description,
            dir: s.dir,
            source: s.source,
          })),
        }
      } catch {
        return null
      }
    },

    async buildSystemPrompt() {
      try {
        const skills = await discoverSkills()
        if (skills.length === 0) return null

        const { ungrouped, groups } = groupSkills(skills)
        const lines: string[] = []

        // foundational skills listed individually
        for (const s of ungrouped) {
          const tag = s.source === 'core' ? '[core]' : '[user]'
          const baseDir = s.source === 'user' ? USER_SKILLS_DIR : CORE_SKILLS_DIR
          lines.push(`- **${s.name}** ${tag} (${join(baseDir, s.dir)}): ${s.description}`)
        }

        // groups collapsed to one-liner summaries
        for (const g of groups) {
          const sample = g.skills.slice(0, 3).map(s => s.name).join(', ')
          const more = g.skills.length > 3 ? ', ...' : ''
          lines.push(`- **${g.name}** (${g.skills.length} skills): ${sample}${more}`)
        }

        return (
          `### Available Skills\n\n` +
          `Skills are loaded from two locations:\n` +
          `- Core: ${CORE_SKILLS_DIR}/\n` +
          `- User: ${USER_SKILLS_DIR}/\n\n` +
          `If a user skill and core skill share the same directory name, the user skill overrides the core one.\n` +
          `Inspect skills directly with bash when relevant. Start with SKILL.md in the chosen skill directory, then read only the additional files it points to.\n` +
          `To create a new skill, mkdir a directory in ${USER_SKILLS_DIR}/ and write a SKILL.md file with YAML frontmatter (name, description) followed by markdown content.\n\n` +
          lines.join('\n')
        )
      } catch {
        return null
      }
    },

    /** Provide structured skill data for dashboard rendering. */
    async dashboardData() {
      try {
        const skills = await discoverSkills()
        return groupSkills(skills)
      } catch {
        return null
      }
    },
  }
}
