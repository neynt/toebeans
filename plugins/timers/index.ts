import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, Message } from '../../server/types.ts'
import { getDataDir } from '../../server/session.ts'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'
import { formatLocalTime, getTimezone } from '../../server/time.ts'

interface QueuedMessage {
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
function parseSchedule(filename: string): { type: 'absolute' | 'daily' | 'weekly' | 'hourly'; next: Date; prev?: Date; repeat: boolean } | null {
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
    const h = parseInt(dailyMatch[1]!), m = parseInt(dailyMatch[2]!)
    return { type: 'daily', next: getNextDaily(h, m), prev: getPrevDaily(h, m), repeat: true }
  }

  // weekly: weekly-day-HH:MM
  const weeklyMatch = name.match(/^weekly-(mon|tue|wed|thu|fri|sat|sun)-(\d{2}):(\d{2})$/)
  if (weeklyMatch) {
    const d = weeklyMatch[1]!, h = parseInt(weeklyMatch[2]!), m = parseInt(weeklyMatch[3]!)
    return { type: 'weekly', next: getNextWeekly(d, h, m), prev: getPrevWeekly(d, h, m), repeat: true }
  }

  // hourly: hourly-MM
  const hourlyMatch = name.match(/^hourly-(\d{2})$/)
  if (hourlyMatch) {
    const m = parseInt(hourlyMatch[1]!)
    return { type: 'hourly', next: getNextHourly(m), prev: getPrevHourly(m), repeat: true }
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

function getPrevDaily(hours: number, minutes: number): Date {
  const now = new Date()
  const prev = new Date(now)
  prev.setHours(hours, minutes, 0, 0)
  if (prev > now) {
    prev.setDate(prev.getDate() - 1)
  }
  return prev
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

function getPrevWeekly(day: string, hours: number, minutes: number): Date {
  const days: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  const targetDay = days[day] ?? 0
  const now = new Date()
  const prev = new Date(now)
  prev.setHours(hours, minutes, 0, 0)

  const currentDay = now.getDay()
  let daysSince = currentDay - targetDay
  if (daysSince < 0 || (daysSince === 0 && prev > now)) {
    daysSince += 7
  }
  prev.setDate(prev.getDate() - daysSince)
  return prev
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

function getPrevHourly(minutes: number): Date {
  const now = new Date()
  const prev = new Date(now)
  prev.setMinutes(minutes, 0, 0)
  if (prev > now) {
    prev.setHours(prev.getHours() - 1)
  }
  return prev
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

// persistent lastFired tracking to detect missed fires across restarts
async function loadLastFired(timersDir: string): Promise<Record<string, number>> {
  try {
    const file = Bun.file(join(timersDir, '.lastFired.json'))
    if (await file.exists()) {
      return await file.json()
    }
  } catch {}
  return {}
}

async function saveLastFired(timersDir: string, lastFired: Record<string, number>) {
  await Bun.write(join(timersDir, '.lastFired.json'), JSON.stringify(lastFired))
}

export default function create(): Plugin {
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null
  const scheduledTimers = new Map<string, ScheduledTimer>()
  const timersDir = getTimersDir()
  let lastFired: Record<string, number> = {}

  async function queueTimerMessage(filename: string, content: string) {
    const { frontmatter, body } = parseFrontmatter(content)

    const msg: QueuedMessage = {
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

  async function fireTimer(filename: string, schedule: { repeat: boolean }) {
    try {
      const filePath = join(timersDir, filename)
      const content = await Bun.file(filePath).text()
      console.log(`timers: firing ${filename}`)
      await queueTimerMessage(filename, content)

      lastFired[filename] = Date.now()
      await saveLastFired(timersDir, lastFired)

      if (schedule.repeat) {
        scheduleTimer(filename)
      } else {
        scheduledTimers.delete(filename)
      }
    } catch (err) {
      console.error(`timers: error firing ${filename}:`, err)
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

    // detect missed fires for recurring timers
    // only catch up if the missed occurrence was recent (within CATCHUP_WINDOW_MS),
    // otherwise just wait for the next natural occurrence
    const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours
    if (schedule.repeat && schedule.prev) {
      const prevTime = schedule.prev.getTime()
      const lastFiredTime = lastFired[filename] ?? 0
      const missedAge = Date.now() - prevTime
      if (lastFiredTime < prevTime && missedAge <= CATCHUP_WINDOW_MS) {
        console.log(`timers: missed fire detected for ${filename} (should have fired ${formatLocalTime(schedule.prev)}, ${Math.round(missedAge / 60000)}m ago)`)
        // fire after a short delay to let the server finish starting up
        const catchupTimeout = setTimeout(() => fireTimer(filename, schedule), 2000)
        scheduledTimers.set(filename, { filename, timeout: catchupTimeout, nextFire: schedule.prev })
        return
      } else if (lastFiredTime < prevTime) {
        console.log(`timers: skipping stale catch-up for ${filename} (missed ${formatLocalTime(schedule.prev)}, ${Math.round(missedAge / 60000)}m ago)`)
        // update lastFired so we don't log this again on next reschedule
        lastFired[filename] = Date.now()
        await saveLastFired(timersDir, lastFired)
      }
    }

    console.log(`timers: scheduled ${filename} for ${formatLocalTime(schedule.next)} (in ${formatTimeUntil(schedule.next)})`)

    const timeout = setTimeout(() => fireTimer(filename, schedule), Math.max(0, msUntil))

    scheduledTimers.set(filename, {
      filename,
      timeout,
      nextFire: schedule.next,
    })
  }

  async function loadAllTimers() {
    try {
      await mkdir(timersDir, { recursive: true })
      lastFired = await loadLastFired(timersDir)
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
          // mark as "fired now" so we don't immediately catch up on the previous occurrence
          lastFired[filename] = Date.now()
          await saveLastFired(timersDir, lastFired)
          await scheduleTimer(filename)
          return {
            content: `Timer created: ${filename}\nNext fire: ${formatLocalTime(schedule.next)} (in ${formatTimeUntil(schedule.next)})\nRepeating: ${schedule.repeat}`,
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
          lines.push(`${filename} - next: ${formatLocalTime(timer.nextFire)} (in ${formatTimeUntil(timer.nextFire)})`)
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

        delete lastFired[filename]
        await saveLastFired(timersDir, lastFired)

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
    description: `Schedule future tasks. Timezone: ${getTimezone()}. Timer filenames encode the schedule (daily-HH:MM.md, weekly-day-HH:MM.md, hourly-MM.md, YYYY-MM-DDTHH:MM.md). YAML frontmatter supports session and output (e.g. "discord:channelId") fields. When a timer fires, you receive its content as a message.`,

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
