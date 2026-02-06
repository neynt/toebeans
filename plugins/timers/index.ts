import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, Message } from '../../server/types.ts'
import { getDataDir, generateSessionId } from '../../server/session.ts'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'

interface QueuedMessage {
  sessionId: string
  message: Message
  outputTarget?: string
}

interface TimerFrontmatter {
  session?: string
  output?: string
}

function parseFrontmatter(content: string): { frontmatter: TimerFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const yamlBlock = match[1]!
  const body = match[2]!
  const frontmatter: TimerFrontmatter = {}

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key === 'session') frontmatter.session = value
    if (key === 'output') frontmatter.output = value
  }

  return { frontmatter, body }
}

interface ScheduledTimer {
  filename: string
  timeout: Timer
  nextFire: Date
}

function getTimersDir(): string {
  return join(getDataDir(), 'timers')
}

// parse filename into schedule info
// formats:
//   2024-02-05T14:30:00.md - absolute ISO datetime (local timezone)
//   daily-08:00.md - every day at 08:00
//   weekly-mon-09:00.md - every monday at 09:00
//   hourly-30.md - every hour at :30
function parseSchedule(filename: string): { type: 'absolute' | 'daily' | 'weekly' | 'hourly'; next: Date; repeat: boolean } | null {
  const name = filename.replace('.md', '')

  // absolute: 2024-02-05T14:30:00 or 2024-02-05T14:30
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(name)) {
    const date = new Date(name)
    if (isNaN(date.getTime())) return null
    return { type: 'absolute', next: date, repeat: false }
  }

  // daily: daily-HH:MM
  const dailyMatch = name.match(/^daily-(\d{2}):(\d{2})$/)
  if (dailyMatch) {
    const next = getNextDaily(parseInt(dailyMatch[1]!), parseInt(dailyMatch[2]!))
    return { type: 'daily', next, repeat: true }
  }

  // weekly: weekly-day-HH:MM
  const weeklyMatch = name.match(/^weekly-(mon|tue|wed|thu|fri|sat|sun)-(\d{2}):(\d{2})$/)
  if (weeklyMatch) {
    const next = getNextWeekly(weeklyMatch[1]!, parseInt(weeklyMatch[2]!), parseInt(weeklyMatch[3]!))
    return { type: 'weekly', next, repeat: true }
  }

  // hourly: hourly-MM
  const hourlyMatch = name.match(/^hourly-(\d{2})$/)
  if (hourlyMatch) {
    const next = getNextHourly(parseInt(hourlyMatch[1]!))
    return { type: 'hourly', next, repeat: true }
  }

  return null
}

function getNextDaily(hours: number, minutes: number): Date {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hours, minutes, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

function getNextWeekly(day: string, hours: number, minutes: number): Date {
  const days: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  const targetDay = days[day] ?? 0
  const now = new Date()
  const next = new Date(now)
  next.setHours(hours, minutes, 0, 0)

  const currentDay = now.getDay()
  let daysUntil = targetDay - currentDay
  if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
    daysUntil += 7
  }
  next.setDate(next.getDate() + daysUntil)
  return next
}

function getNextHourly(minutes: number): Date {
  const now = new Date()
  const next = new Date(now)
  next.setMinutes(minutes, 0, 0)
  if (next <= now) {
    next.setHours(next.getHours() + 1)
  }
  return next
}

function formatTimeUntil(date: Date): string {
  const ms = date.getTime() - Date.now()
  if (ms < 0) return 'past'
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  if (mins > 0) return `${mins}m`
  return `${secs}s`
}

export default function createTimersPlugin(): Plugin {
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null
  const scheduledTimers = new Map<string, ScheduledTimer>()
  const timersDir = getTimersDir()

  async function queueTimerMessage(filename: string, content: string) {
    const { frontmatter, body } = parseFrontmatter(content)

    // use session from frontmatter or generate a new one
    const sessionId = frontmatter.session || await generateSessionId()

    const msg: QueuedMessage = {
      sessionId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: `[Timer fired: ${filename}]\n\n${body}` }],
      },
      outputTarget: frontmatter.output,
    }
    messageQueue.push(msg)
    if (resolveWaiter) {
      resolveWaiter()
      resolveWaiter = null
    }
  }

  async function* inputGenerator(): AsyncGenerator<QueuedMessage> {
    while (true) {
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!
      }
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
    }
  }

  async function scheduleTimer(filename: string) {
    const schedule = parseSchedule(filename)
    if (!schedule) {
      return
    }

    // cancel existing timer if any
    const existing = scheduledTimers.get(filename)
    if (existing) {
      clearTimeout(existing.timeout)
    }

    const msUntil = schedule.next.getTime() - Date.now()
    if (msUntil < 0 && !schedule.repeat) {
      return
    }

    const actualMs = Math.max(0, msUntil)
    console.log(`timers: scheduled ${filename} for ${schedule.next.toLocaleString()} (in ${formatTimeUntil(schedule.next)})`)

    const timeout = setTimeout(async () => {
      try {
        const filePath = join(timersDir, filename)
        const content = await Bun.file(filePath).text()
        console.log(`timers: firing ${filename}`)
        await queueTimerMessage(filename, content)

        // reschedule if repeating, otherwise just remove from memory
        // (file stays around for history - past timers are ignored on load)
        if (schedule.repeat) {
          scheduleTimer(filename)
        } else {
          scheduledTimers.delete(filename)
        }
      } catch (err) {
        console.error(`timers: error firing ${filename}:`, err)
      }
    }, actualMs)

    scheduledTimers.set(filename, {
      filename,
      timeout,
      nextFire: schedule.next,
    })
  }

  async function loadAllTimers() {
    try {
      await mkdir(timersDir, { recursive: true })
      const glob = new Bun.Glob('*.md')
      for await (const filename of glob.scan(timersDir)) {
        await scheduleTimer(filename)
      }
    } catch (err) {
      console.error('timers: error loading timers:', err)
    }
  }

  const tools: Tool[] = [
    {
      name: 'timer_create',
      description: `Create a timer that will wake you up at a specific time.
Filename formats (all times are local timezone):
- Absolute: 2024-02-05T14:30.md (one-shot, deleted after firing)
- Daily: daily-08:00.md (every day at 08:00)
- Weekly: weekly-mon-09:00.md (every Monday at 09:00)
- Hourly: hourly-30.md (every hour at :30)

Content supports optional YAML frontmatter:
---
session: my-session-name   # reuse a session (optional, generates new if omitted)
output: discord:channelId  # route response to a plugin (optional, no output if omitted)
---
Your prompt here...

The body (after frontmatter) is the message you'll receive when the timer fires.`,
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Timer filename (e.g., daily-08:00.md)' },
          content: { type: 'string', description: 'Message content for when timer fires' },
        },
        required: ['filename', 'content'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { filename, content } = input as { filename: string; content: string }

        if (!filename.endsWith('.md')) {
          return { content: 'Filename must end with .md', is_error: true }
        }

        const schedule = parseSchedule(filename)
        if (!schedule) {
          return { content: 'Invalid schedule format. Use: YYYY-MM-DDTHH:MM.md, daily-HH:MM.md, weekly-day-HH:MM.md, or hourly-MM.md', is_error: true }
        }

        try {
          await mkdir(timersDir, { recursive: true })
          await Bun.write(join(timersDir, filename), content)
          await scheduleTimer(filename)
          return {
            content: `Timer created: ${filename}\nNext fire: ${schedule.next.toLocaleString()} (in ${formatTimeUntil(schedule.next)})\nRepeating: ${schedule.repeat}`,
          }
        } catch (err) {
          return { content: `Failed to create timer: ${err}`, is_error: true }
        }
      },
    },

    {
      name: 'timer_list',
      description: 'List all scheduled timers.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<ToolResult> {
        if (scheduledTimers.size === 0) {
          return { content: '(no timers scheduled)' }
        }

        const lines: string[] = []
        for (const [filename, timer] of scheduledTimers) {
          lines.push(`${filename} - next: ${timer.nextFire.toLocaleString()} (in ${formatTimeUntil(timer.nextFire)})`)
        }
        return { content: lines.join('\n') }
      },
    },

    {
      name: 'timer_delete',
      description: 'Delete a timer.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Timer filename to delete' },
        },
        required: ['filename'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { filename } = input as { filename: string }

        const timer = scheduledTimers.get(filename)
        if (timer) {
          clearTimeout(timer.timeout)
          scheduledTimers.delete(filename)
        }

        try {
          const filePath = join(timersDir, filename)
          const file = Bun.file(filePath)
          if (await file.exists()) {
            await Bun.write(filePath + '.deleted', await file.text())
            // bun doesn't have a simple delete, use shell
            await Bun.$`rm ${filePath}`.quiet()
          }
          return { content: `Timer deleted: ${filename}` }
        } catch (err) {
          return { content: `Failed to delete timer: ${err}`, is_error: true }
        }
      },
    },

    {
      name: 'timer_read',
      description: 'Read the content of a timer.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Timer filename to read' },
        },
        required: ['filename'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { filename } = input as { filename: string }
        try {
          const content = await Bun.file(join(timersDir, filename)).text()
          return { content }
        } catch (err) {
          return { content: `Failed to read timer: ${err}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'timers',
    description: `Schedule future tasks. Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Timer filenames encode the schedule (daily-HH:MM.md, weekly-day-HH:MM.md, hourly-MM.md, YYYY-MM-DDTHH:MM.md). YAML frontmatter supports session and output (e.g. "discord:channelId") fields. When a timer fires, you receive its content as a message.`,

    tools,
    input: inputGenerator(),

    async init() {
      await loadAllTimers()
    },

    async destroy() {
      for (const timer of scheduledTimers.values()) {
        clearTimeout(timer.timeout)
      }
      scheduledTimers.clear()
    },
  }
}
