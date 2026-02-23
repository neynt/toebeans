import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, Message, ServerMessage } from '../../server/types.ts'
import { Client, GatewayIntentBits, Partials, Events, ChannelType, type TextChannel, type DMChannel, type Message as DiscordMessage } from 'discord.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { readdir, stat } from 'fs/promises'
import { getDataDir } from '../../server/session.ts'
import { countTokens } from '../../server/tokens.ts'
import { countToolResultTokens } from '../../server/tokens.ts'
import { formatLocalTime } from '../../server/time.ts'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

// --- helpers for /session enrichment ---

interface ClaudeCodeMeta {
  sessionId: string
  task: string
  workingDir: string
  startedAt: string
  pid: number
  exitCode?: number
  endedAt?: string
}

async function getActiveClaudeCodeSessions(): Promise<ClaudeCodeMeta[]> {
  const dir = join(getDataDir(), 'claude-code')
  try {
    const files = await readdir(dir)
    const metaFiles = files.filter(f => f.endsWith('.meta.json'))

    const active: ClaudeCodeMeta[] = []
    for (const file of metaFiles) {
      try {
        const meta: ClaudeCodeMeta = await Bun.file(join(dir, file)).json()
        if (meta.endedAt) continue
        // check if process is still alive
        try {
          process.kill(meta.pid, 0)
          active.push(meta)
        } catch {
          // process dead, skip
        }
      } catch {
        // bad meta file, skip
      }
    }
    return active.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
  } catch {
    return []
  }
}

interface UpcomingTimer {
  filename: string
  nextFire: Date
}

function parseTimerSchedule(filename: string): { next: Date } | null {
  const name = filename.replace('.md', '')

  // absolute: 2024-02-05T14:30:00
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(name)) {
    const date = new Date(name)
    if (isNaN(date.getTime()) || date <= new Date()) return null
    return { next: date }
  }

  const now = new Date()

  // daily: daily-HH:MM
  const dailyMatch = name.match(/^daily-(\d{2}):(\d{2})$/)
  if (dailyMatch) {
    const next = new Date(now)
    next.setHours(parseInt(dailyMatch[1]!), parseInt(dailyMatch[2]!), 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return { next }
  }

  // weekly: weekly-day-HH:MM
  const weeklyMatch = name.match(/^weekly-(mon|tue|wed|thu|fri|sat|sun)-(\d{2}):(\d{2})$/)
  if (weeklyMatch) {
    const days: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
    const targetDay = days[weeklyMatch[1]!] ?? 0
    const next = new Date(now)
    next.setHours(parseInt(weeklyMatch[2]!), parseInt(weeklyMatch[3]!), 0, 0)
    let daysUntil = targetDay - now.getDay()
    if (daysUntil < 0 || (daysUntil === 0 && next <= now)) daysUntil += 7
    next.setDate(next.getDate() + daysUntil)
    return { next }
  }

  // hourly: hourly-MM
  const hourlyMatch = name.match(/^hourly-(\d{2})$/)
  if (hourlyMatch) {
    const next = new Date(now)
    next.setMinutes(parseInt(hourlyMatch[1]!), 0, 0)
    if (next <= now) next.setHours(next.getHours() + 1)
    return { next }
  }

  return null
}

async function getUpcomingTimers(limit: number = 5): Promise<UpcomingTimer[]> {
  const dir = join(getDataDir(), 'timers')
  try {
    const files = await readdir(dir)
    const timers: UpcomingTimer[] = []
    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue
      const schedule = parseTimerSchedule(file)
      if (schedule) {
        timers.push({ filename: file, nextFire: schedule.next })
      }
    }
    timers.sort((a, b) => a.nextFire.getTime() - b.nextFire.getTime())
    return timers.slice(0, limit)
  } catch {
    return []
  }
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

interface DiscordConfig {
  token: string
  allowedUsers: string[]  // user IDs allowed to interact (required for safety)
  channels?: string[]  // channel IDs to listen to (empty = all accessible)
  onlyRespondToMentions?: boolean  // in guilds, only process messages that @mention the bot
  allowDMs?: boolean  // respond to direct messages (default: true)
  transcribeVoice?: boolean  // transcribe voice messages (default: true)
  sessionManager?: any  // session manager instance for slash commands
  whisperModel?: string  // whisper model for voice transcription (default: medium)
  typingDelayMaxMs?: number  // max typing delay in ms (default: 1000)
  typingDelayPerCharMs?: number  // per-character typing delay in ms (default: 10)
}

interface QueuedMessage {
  message: Message
  outputTarget?: string
  stopRequested?: boolean
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', async () => {
        try {
          await writeFile(outputPath, Buffer.concat(chunks))
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      response.on('error', reject)
    }).on('error', reject)
  })
}

async function downloadImageAsBase64(url: string): Promise<{ media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }> {
  const tmpInput = join('/tmp', `discord-img-${Date.now()}-input`)
  const tmpOutput = join('/tmp', `discord-img-${Date.now()}-output`)

  try {
    // download to temp file
    await downloadFile(url, tmpInput)

    // check file size - if base64 would exceed ~4MB, resize
    const stats = await Bun.file(tmpInput).size
    const base64Size = Math.ceil((stats * 4) / 3) // estimate base64 size
    const maxSize = 4 * 1024 * 1024 // 4MB

    let finalPath = tmpInput
    let media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/jpeg'

    // detect media type from file extension or content
    const urlLower = url.toLowerCase()
    if (urlLower.includes('.png')) media_type = 'image/png'
    else if (urlLower.includes('.gif')) media_type = 'image/gif'
    else if (urlLower.includes('.webp')) media_type = 'image/webp'

    if (base64Size > maxSize) {
      console.log(`discord: image too large (${Math.round(base64Size / 1024 / 1024)}MB), resizing...`)

      // use imagemagick to resize - preserve format by using appropriate extension
      const ext = media_type === 'image/png' ? 'png' : 'jpg'
      const outputPath = `${tmpOutput}.${ext}`

      const proc = Bun.spawn(['magick', tmpInput, '-resize', '2048x2048>', '-quality', '85', outputPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`magick failed: ${stderr}`)
      }

      finalPath = outputPath
      // convert gif/webp to jpeg for simplicity after resize
      if (media_type === 'image/gif' || media_type === 'image/webp') {
        media_type = 'image/jpeg'
      }
    }

    // read and encode
    const buffer = await Bun.file(finalPath).arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')

    return { media_type, data: base64 }
  } finally {
    // cleanup temp files
    try { await unlink(tmpInput) } catch {}
    try { await unlink(tmpOutput + '.png') } catch {}
    try { await unlink(tmpOutput + '.jpg') } catch {}
  }
}

async function transcribeAudio(audioPath: string, model: string = 'medium'): Promise<string> {
  const initialPrompt = 'commit, push, pull, git, merge, rebase, branch, repo, deploy, API, endpoint, TypeScript, JavaScript, Python, npm, Docker, Kubernetes, Claude, LLM'
  // output_dir must be explicit since whisperx defaults to cwd
  const outputDir = audioPath.replace(/\/[^/]+$/, '')
  const baseCmd = `uvx whisperx "${audioPath}" --model ${model} --language en --output_format txt --output_dir "${outputDir}" --no_align --initial_prompt "${initialPrompt}"`

  // detect CUDA availability, fall back to CPU
  const devices: Array<{ device: string; computeType: string }> = []
  try {
    await execAsync('nvidia-smi', { timeout: 5000 })
    devices.push({ device: 'cuda', computeType: 'float16' })
  } catch {}
  devices.push({ device: 'cpu', computeType: 'int8' })

  for (const { device, computeType } of devices) {
    const cmd = `${baseCmd} --device ${device} --compute_type ${computeType}`
    try {
      await execAsync(cmd, {
        timeout: 120000,
        env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' },
      })
      // whisperx outputs a .txt file in the output directory
      const txtPath = audioPath.replace(/\.[^.]+$/, '.txt')
      try {
        const txtContent = await Bun.file(txtPath).text()
        await unlink(txtPath)
        return txtContent.trim()
      } catch {
        return '(transcription failed: could not read output file)'
      }
    } catch (err) {
      if (device !== 'cpu') {
        console.warn(`Transcription: ${device} failed, falling back:`, (err as Error).message?.slice(0, 100))
        continue
      }
      console.error('Transcription error:', err)
      return `(transcription failed: ${err})`
    }
  }
  return '(transcription failed)'
}

const ATTACHMENT_DIR = join(getDataDir(), 'discord-attachments')
const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

async function cleanupOldAttachments() {
  try {
    await mkdir(ATTACHMENT_DIR, { recursive: true })
    const files = await readdir(ATTACHMENT_DIR)
    const now = Date.now()
    for (const file of files) {
      try {
        const filePath = join(ATTACHMENT_DIR, file)
        const fileStat = await stat(filePath)
        if (now - fileStat.mtimeMs > ATTACHMENT_MAX_AGE_MS) {
          await unlink(filePath)
        }
      } catch {}
    }
  } catch (err) {
    console.error('discord: attachment cleanup failed:', err)
  }
}

interface ServerContext {
  routeOutput: (target: string, message: any) => Promise<void>
  requestStop: (outputTarget: string) => Promise<boolean>
  config: any
}

export default function createDiscordPlugin(serverContext?: ServerContext): Plugin {
  let client: Client | null = null
  let config: DiscordConfig | null = null
  let cleanupInterval: ReturnType<typeof setInterval> | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  // track buffered content per session (for sentence-based sending)
  const messageBuffers = new Map<string, string>()
  // track tool use messages by tool_use_id so we can edit them
  const toolMessages = new Map<string, { channelId: string; messageId: string; toolName: string; originalContent: string; inputTokens: number }>()
  // lock to prevent concurrent sends per session
  const sendLocks = new Map<string, Promise<void>>()
  // track last message ID per channel (for "last" shorthand in discord_react)
  const lastMessageIds = new Map<string, string>()
  // persistent typing indicators per channel
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
  const typingDelays = new Map<string, ReturnType<typeof setTimeout>>()

  const MAX_TYPING_MS = 5 * 60 * 1000 // 5 min safety cap
  const TYPING_START_DELAY_MS = 300

  function startTyping(channel: TextChannel | DMChannel) {
    stopTyping(channel.id)
    const delay = setTimeout(() => {
      typingDelays.delete(channel.id)
      channel.sendTyping().catch(() => {})
      const interval = setInterval(() => {
        channel.sendTyping().catch(() => {})
      }, 4000)
      typingIntervals.set(channel.id, interval)
      setTimeout(() => stopTyping(channel.id), MAX_TYPING_MS)
    }, TYPING_START_DELAY_MS)
    typingDelays.set(channel.id, delay)
  }

  function stopTyping(channelId: string) {
    const delay = typingDelays.get(channelId)
    if (delay) {
      clearTimeout(delay)
      typingDelays.delete(channelId)
    }
    const interval = typingIntervals.get(channelId)
    if (interval) {
      clearInterval(interval)
      typingIntervals.delete(channelId)
    }
  }

  function queueMessage(channelId: string, content: string, author: string, isDM: boolean, images: Array<{ media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }> = []) {
    const channelContext = isDM
      ? `[DM from ${author}, channel_id: ${channelId}]`
      : `[#channel ${channelId}, from ${author}]`

    const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }> = [
      { type: 'text', text: `${channelContext}\n${content}` }
    ]

    // add image blocks after text
    for (const img of images) {
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })
    }

    const msg: QueuedMessage = {
      message: {
        role: 'user',
        content: contentBlocks,
      },
      outputTarget: `discord:${channelId}`,
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

  const tools: Tool[] = [
    {
      name: 'discord_send',
      description: 'Send a message to a Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID to send to' },
          content: { type: 'string', description: 'Message content (max 2000 chars)' },
        },
        required: ['channel_id', 'content'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, content } = input as { channel_id: string; content: string }
        try {
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }
          const truncated = content.slice(0, 2000)
          // works for both TextChannel and DMChannel
          const sent = await (channel as TextChannel | DMChannel).send(truncated)
          lastMessageIds.set(channel_id, sent.id)
          return { content: `Sent message to channel ${channel_id}` }
        } catch (err) {
          return { content: `Failed to send: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_read_history',
      description: 'Read recent messages from a Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID' },
          limit: { type: 'number', description: 'Number of messages to fetch (default 20, max 100)' },
        },
        required: ['channel_id'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, limit = 20 } = input as { channel_id: string; limit?: number }
        try {
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }
          const messages = await (channel as TextChannel).messages.fetch({ limit: Math.min(limit, 100) })
          const formatted = messages
            .reverse()
            .map(m => {
              let line = `[${m.id}] [${m.author.username}] ${m.content}`
              if (m.attachments.size > 0) {
                const atts = [...m.attachments.values()].map(a => `${a.name} (${a.contentType || 'unknown'}, ${a.size} bytes)`).join(', ')
                line += ` [attachments: ${atts}]`
              }
              return line
            })
            .join('\n')
          return { content: formatted || '(no messages)' }
        } catch (err) {
          return { content: `Failed to read: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_react',
      description: 'Add a reaction to a message. Use message_id "last" to react to the most recent message in the channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID' },
          message_id: { type: 'string', description: 'Message ID to react to, or "last" for the most recent message in the channel' },
          emoji: { type: 'string', description: 'Emoji to react with (unicode or custom emoji name)' },
        },
        required: ['channel_id', 'message_id', 'emoji'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, emoji } = input as { channel_id: string; message_id: string; emoji: string }
        let { message_id } = input as { message_id: string }

        // resolve "last" to the most recent tracked message in this channel
        if (message_id === 'last') {
          const lastId = lastMessageIds.get(channel_id)
          if (!lastId) {
            return { content: `No tracked messages in channel ${channel_id}. Use a specific message ID, or send/receive a message first.`, is_error: true }
          }
          message_id = lastId
        }

        try {
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }
          const message = await (channel as TextChannel).messages.fetch(message_id)
          await message.react(emoji)
          return { content: `Reacted with ${emoji} on message ${message_id}` }
        } catch (err) {
          return { content: `Failed to react: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_send_image',
      description: 'Send an image file to a Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID to send to' },
          image_path: { type: 'string', description: 'Path to the image file to send' },
          message: { type: 'string', description: 'Optional message text to include with the image' },
        },
        required: ['channel_id', 'image_path'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, image_path, message } = input as { channel_id: string; image_path: string; message?: string }
        try {
          const file = Bun.file(image_path)
          if (!(await file.exists())) {
            return { content: `image file not found: ${image_path}`, is_error: true }
          }
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }
          const buffer = Buffer.from(await file.arrayBuffer())
          const filename = image_path.split('/').pop() || 'image.png'
          await (channel as TextChannel | DMChannel).send({
            content: message || undefined,
            files: [{ attachment: buffer, name: filename }],
          })
          return { content: `image sent to channel ${channel_id}` }
        } catch (err) {
          return { content: `Failed to send image: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_fetch_attachment',
      description: 'Fetch a specific message by ID and download its attachment(s) to disk. Returns local file paths for further processing. Handles voice messages (audio), images, and general file attachments.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID containing the message' },
          message_id: { type: 'string', description: 'Message ID to fetch attachments from' },
          attachment_index: { type: 'number', description: 'Optional: download only the Nth attachment (0-indexed). If omitted, downloads all.' },
        },
        required: ['channel_id', 'message_id'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, message_id, attachment_index } = input as { channel_id: string; message_id: string; attachment_index?: number }
        try {
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }

          let msg: DiscordMessage
          try {
            msg = await (channel as TextChannel).messages.fetch(message_id)
          } catch {
            return { content: `Message ${message_id} not found in channel ${channel_id}`, is_error: true }
          }

          if (msg.attachments.size === 0) {
            return { content: `Message ${message_id} has no attachments. Content: ${msg.content || '(empty)'}`, is_error: true }
          }

          const attachments = [...msg.attachments.values()]
          let toDownload = attachments
          if (attachment_index !== undefined) {
            if (attachment_index < 0 || attachment_index >= attachments.length) {
              return { content: `Attachment index ${attachment_index} out of range (message has ${attachments.length} attachment(s))`, is_error: true }
            }
            toDownload = [attachments[attachment_index]] as typeof attachments
          }

          await mkdir(ATTACHMENT_DIR, { recursive: true })
          const results: string[] = []

          for (const attachment of toDownload) {
            const safeName = (attachment.name || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
            const filename = `${msg.id}_${attachment.id}_${safeName}`
            const filePath = join(ATTACHMENT_DIR, filename)
            await downloadFile(attachment.url, filePath)
            results.push(JSON.stringify({
              path: filePath,
              name: attachment.name,
              contentType: attachment.contentType,
              size: attachment.size,
            }))
          }

          return { content: `Downloaded ${results.length} attachment(s):\n${results.join('\n')}` }
        } catch (err) {
          return { content: `Failed to fetch attachment: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_list_channels',
      description: 'List accessible text channels in all guilds.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        try {
          const channels: string[] = []
          for (const guild of client.guilds.cache.values()) {
            for (const channel of guild.channels.cache.values()) {
              if (channel.isTextBased() && 'name' in channel) {
                channels.push(`${guild.name} / #${channel.name} (${channel.id})`)
              }
            }
          }
          return { content: channels.join('\n') || '(no channels)' }
        } catch (err) {
          return { content: `Failed to list: ${err}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'discord',
    description: `Discord bot. Text responses are automatically sent back to the channel/DM. Voice messages are transcribed. Messages include [channel_id: X] for routing.`,

    tools,

    input: inputGenerator(),

    async output(sessionId: string, message: ServerMessage) {
      if (!client) return

      // sessionId format: channelId (already stripped of discord: prefix by routeOutput)
      const channelId = sessionId
      if (!channelId) return

      // serialize sends per session to prevent out-of-order messages
      const prevLock = sendLocks.get(sessionId) || Promise.resolve()
      const currentLock = prevLock.then(async () => {
        try {
          const channel = await client!.channels.fetch(channelId)
          if (!channel?.isTextBased()) return
          const textChannel = channel as TextChannel | DMChannel

          // helper to send a message with human-like delay, splitting if over 2000 chars
          const sendMessage = async (text: string, moreToFollow: boolean) => {
            const trimmed = text.trim()
            if (!trimmed) return

            // human-like delay: 300ms + per-char delay, capped at max
            const maxDelay = config?.typingDelayMaxMs ?? 1000
            const perChar = config?.typingDelayPerCharMs ?? 10
            const delay = Math.min(maxDelay, 300 + trimmed.length * perChar)
            await new Promise(resolve => setTimeout(resolve, delay))

            let remaining = trimmed
            const messages: DiscordMessage[] = []
            while (remaining.length > 0) {
              const chunk = remaining.slice(0, 2000)
              const msg = await textChannel.send(chunk)
              messages.push(msg)
              remaining = remaining.slice(2000)
            }

            // show typing indicator if more content is coming
            if (moreToFollow) {
              textChannel.sendTyping().catch(() => {})
            }

            return messages[0] // return first message for tracking
          }

          // handle different message types
          if (message.type === 'text') {
            // accumulate text in buffer
            let buffer = messageBuffers.get(sessionId) || ''
            buffer += message.text
            messageBuffers.set(sessionId, buffer)

            // look for complete paragraphs to send (double newline)
            while (true) {
              const paraBreak = buffer.indexOf('\n\n')
              if (paraBreak !== -1) {
                const toSend = buffer.slice(0, paraBreak)
                buffer = buffer.slice(paraBreak + 2)
                messageBuffers.set(sessionId, buffer)
                const hasMore = buffer.trim().length > 0
                await sendMessage(toSend, hasMore)
                continue
              }
              break
            }
          } else if (message.type === 'text_block_end') {
            // flush remaining buffer when text block ends
            const buffer = messageBuffers.get(sessionId) || ''
            if (buffer.trim()) {
              await sendMessage(buffer, false)
              messageBuffers.delete(sessionId)
            }
          } else if (message.type === 'tool_use') {
            // calculate input tokens
            const inputStr = typeof message.input === 'string'
              ? message.input
              : JSON.stringify(message.input)
            const inputTokens = countTokens(inputStr)

            // create concise single-line tool message
            let toolMessage = `🔧 ${message.name}`

            // add brief summary based on tool type
            if (message.name === 'bash') {
              const cmd = (message.input as any)?.command
              if (cmd) {
                const truncated = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd
                toolMessage += `: ${truncated}`
              }
            } else if (message.name === 'write_file' || message.name === 'read_file' || message.name === 'edit_file') {
              const path = (message.input as any)?.path || (message.input as any)?.file_path
              if (path) {
                const basename = path.split('/').pop() || path
                toolMessage += `: ${basename}`
              }
            } else if (message.name === 'spawn_claude_code') {
              const task = (message.input as any)?.task
              if (task) {
                const truncated = task.length > 50 ? task.slice(0, 47) + '...' : task
                toolMessage += `: ${truncated}`
              }
            } else if (message.name === 'discord_send' || message.name === 'discord_send_image' || message.name === 'discord_read_history' || message.name === 'discord_react' || message.name === 'discord_fetch_attachment') {
              // just the tool name, no params
            } else if (message.name === 'remember' || message.name === 'recall') {
              const topic = (message.input as any)?.topic || (message.input as any)?.query
              if (topic) {
                const truncated = topic.length > 50 ? topic.slice(0, 47) + '...' : topic
                toolMessage += `: ${truncated}`
              }
            } else if (message.name === 'timer_create' || message.name === 'timer_delete' || message.name === 'timer_read' || message.name === 'timer_list') {
              const filename = (message.input as any)?.filename || (message.input as any)?.timer_filename
              if (filename) {
                toolMessage += `: ${filename}`
              }
            } else if (message.name === 'web_browse') {
              const url = (message.input as any)?.url
              if (url) {
                const truncated = url.length > 50 ? url.slice(0, 47) + '...' : url
                toolMessage += `: ${truncated}`
              }
            } else if (message.name === 'generate_image') {
              const prompt = (message.input as any)?.prompt
              if (prompt) {
                const truncated = prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt
                toolMessage += `: ${truncated}`
              }
            } else {
              // fallback: first 50 chars of JSON
              const truncated = inputStr.length > 50 ? inputStr.slice(0, 47) + '...' : inputStr
              toolMessage += `: ${truncated}`
            }

            // append token count
            toolMessage += ` (${inputTokens} tokens)`

            // escape backticks so they don't break Discord inline code formatting
            toolMessage = toolMessage.replaceAll('`', "'")

            const msg = await textChannel.send(`\`${toolMessage}\``)
            toolMessages.set(message.id, { channelId, messageId: msg.id, toolName: message.name, originalContent: toolMessage, inputTokens })
          } else if (message.type === 'tool_result') {
            // swap emoji and add result token count
            const toolInfo = toolMessages.get(message.tool_use_id)
            if (toolInfo) {
              try {
                const msg = await textChannel.messages.fetch(toolInfo.messageId)
                const status = message.is_error ? '❌' : '✅'

                // calculate result tokens (image-aware)
                const resultTokens = countToolResultTokens(message.content)

                // replace emoji and update token info
                const newContent = toolInfo.originalContent
                  .replace(/^🔧/, status)
                  .replace(/ \(.*? tokens\)$/, ` (${toolInfo.inputTokens} + ${resultTokens} tokens)`)

                await msg.edit(`\`${newContent}\``)
                toolMessages.delete(message.tool_use_id)
              } catch (err) {
                console.error('failed to edit tool message:', err)
              }
            }
          } else if (message.type === 'done') {
            // flush remaining buffer
            const buffer = messageBuffers.get(sessionId) || ''
            if (buffer.trim()) {
              await sendMessage(buffer, false)
            }
            messageBuffers.delete(sessionId)
            sendLocks.delete(sessionId)
            stopTyping(channelId)
          } else if (message.type === 'error') {
            // send error message
            await textChannel.send(`❌ Error: ${message.message}`)
            stopTyping(channelId)
          }
        } catch (err) {
          console.error(`discord output error:`, err)
          stopTyping(channelId)
        }
      })

      sendLocks.set(sessionId, currentLock)
      await currentLock
    },

    async init(cfg: unknown) {
      config = cfg as DiscordConfig
      if (!config?.token) {
        console.warn('discord plugin: no token provided, tools will fail')
        return
      }

      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel],  // required for DM events
      })

      client.on(Events.MessageCreate, async (msg: DiscordMessage) => {
        // ignore bot messages
        if (msg.author.bot) return

        // check user whitelist (required for safety)
        if (!config!.allowedUsers.includes(msg.author.id)) {
          console.log(`discord: ignored message from non-whitelisted user ${msg.author.username} (${msg.author.id})`)
          return
        }

        const isDM = msg.channel.type === ChannelType.DM

        // handle DMs
        if (isDM) {
          if (config!.allowDMs === false) return
        } else {
          // filter by channels if configured (only for guild messages)
          if (config!.channels?.length && !config!.channels.includes(msg.channelId)) {
            return
          }

          // filter by mentions if configured
          if (config!.onlyRespondToMentions && client?.user && !msg.mentions.has(client.user.id)) {
            return
          }
        }

        // handle /stop command — bypass message queue and abort directly
        if (msg.content.trim() === '/stop') {
          if (serverContext?.requestStop) {
            await serverContext.requestStop(`discord:${msg.channelId}`)
          }
          return
        }

        // handle /reset command (reset session without summary)
        if (msg.content.trim() === '/reset') {
          if (!config!.sessionManager) return
          const route = `discord:${msg.channelId}`
          try {
            const sessionId = await config!.sessionManager.getSessionForMessage(route)
            const newId = await config!.sessionManager.resetSession(sessionId, route)
            const channel = msg.channel as TextChannel | DMChannel
            await channel.send(`✅ reset session \`${sessionId}\` → \`${newId}\``)
          } catch (err) {
            const channel = msg.channel as TextChannel | DMChannel
            await channel.send(`❌ reset failed: ${err}`)
          }
          return
        }

        // start persistent typing indicator (re-fires every 4s until stopped)
        startTyping(msg.channel as TextChannel | DMChannel)

        let content = msg.content
        const images: Array<{ media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }> = []

        // handle attachments
        if (msg.attachments.size > 0) {
          console.log(`discord: attachments count: ${msg.attachments.size}, types: ${[...msg.attachments.values()].map(a => a.contentType).join(", ")}`)
          for (const attachment of msg.attachments.values()) {
            // check if it's an image
            const isImage = attachment.contentType?.startsWith('image/') &&
                           (attachment.contentType === 'image/png' ||
                            attachment.contentType === 'image/jpeg' ||
                            attachment.contentType === 'image/jpg' ||
                            attachment.contentType === 'image/gif' ||
                            attachment.contentType === 'image/webp')

            if (isImage) {
              try {
                const imageData = await downloadImageAsBase64(attachment.url)
                images.push(imageData)
              } catch (err) {
                console.error('Failed to download image:', err)
                content += `\n\n[Image attachment - download failed]`
              }
              continue
            }

            // check if it's an audio file
            const isAudio = attachment.contentType?.startsWith('audio/') ||
                           /\.(mp3|wav|ogg|m4a|opus|webm)$/i.test(attachment.name || '')

            if (isAudio && config!.transcribeVoice !== false) {
              try {
                const audioDir = join(getDataDir(), 'discord')
                await mkdir(audioDir, { recursive: true })
                const audioFile = join(audioDir, `${Date.now()}-${attachment.name}`)
                await downloadFile(attachment.url, audioFile)
                const transcription = await transcribeAudio(audioFile, config!.whisperModel ?? 'medium')

                // echo transcription back to the channel so user can verify
                const echoChannel = msg.channel as TextChannel | DMChannel
                await echoChannel.send(`[Voice transcription]: ${transcription}`)

                content += `\n\n[Voice message transcription: ${transcription}]`
              } catch (err) {
                console.error('Failed to transcribe audio:', err)
                content += `\n\n[Voice message - transcription failed]`
              }
              continue
            }

            // general attachment: download and save to disk
            try {
              await mkdir(ATTACHMENT_DIR, { recursive: true })
              const safeName = (attachment.name || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
              const filename = `${msg.id}_${attachment.id}_${safeName}`
              const filePath = join(ATTACHMENT_DIR, filename)
              await downloadFile(attachment.url, filePath)
              content += `\n\n[attachment: ${filePath}]`
              console.log(`discord: saved attachment ${filename} (${attachment.contentType || 'unknown type'})`)
            } catch (err) {
              console.error('Failed to download attachment:', err)
              content += `\n\n[attachment: download failed - ${attachment.name || 'unknown'}]`
            }
          }
        }

        // track last message ID for this channel (enables "last" shorthand in discord_react)
        lastMessageIds.set(msg.channelId, msg.id)

        queueMessage(msg.channelId, content, msg.author.username, isDM, images)
      })

      client.on(Events.ClientReady, async () => {
        console.log(`discord: logged in as ${client!.user?.tag}`)

        // register slash commands
        try {
          await client!.application?.commands.set([
            { name: 'compact', description: 'Force compact the current session' },
            { name: 'reset', description: 'Reset session without summary (clean slate)' },
            { name: 'session', description: 'Show current session info' },
            { name: 'stop', description: 'Stop the current operation immediately' },
          ])
          console.log('discord: registered slash commands')
        } catch (err) {
          console.error('discord: failed to register slash commands:', err)
        }
      })

      client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return

        // check user whitelist
        if (!config!.allowedUsers.includes(interaction.user.id)) {
          await interaction.reply({ content: '❌ not authorized', ephemeral: true })
          return
        }

        if (!config!.sessionManager) {
          await interaction.reply({ content: '❌ session manager not available', ephemeral: true })
          return
        }

        try {
          const route = `discord:${interaction.channelId}`
          if (interaction.commandName === 'stop') {
            if (serverContext?.requestStop) {
              await serverContext.requestStop(route)
            }
            await interaction.reply({ content: 'stopping...', ephemeral: true })
            return
          } else if (interaction.commandName === 'compact') {
            await interaction.deferReply()
            const sessionId = await config!.sessionManager.getSessionForMessage(route)
            const newId = await config!.sessionManager.forceCompact(sessionId, route)
            await interaction.editReply(`✅ compacted session \`${sessionId}\` → \`${newId}\``)
          } else if (interaction.commandName === 'reset') {
            await interaction.deferReply()
            const sessionId = await config!.sessionManager.getSessionForMessage(route)
            const newId = await config!.sessionManager.resetSession(sessionId, route)
            await interaction.editReply(`✅ reset session \`${sessionId}\` → \`${newId}\``)
          } else if (interaction.commandName === 'session') {
            await interaction.deferReply()
            const sessionId = await config!.sessionManager.getSessionForMessage(route)
            const info = await config!.sessionManager.getSessionInfo(sessionId)

            const createdStr = info.createdAt ? formatLocalTime(info.createdAt) : 'unknown'
            const lastActivityStr = info.lastActivity ? formatLocalTime(info.lastActivity) : 'unknown'
            const ageMinutes = info.createdAt ? Math.floor((Date.now() - info.createdAt.getTime()) / 60000) : 0

            let reply = '📊 **Session Info**\n'
            reply += `**ID:** \`${info.id}\`\n`
            reply += `**Messages:** ${info.messageCount}\n`
            reply += `**Tokens:** ~${info.estimatedTokens} (system: ~${info.systemPromptTokens})\n`
            reply += `**Created:** ${createdStr}\n`
            reply += `**Last Activity:** ${lastActivityStr}\n`
            reply += `**Age:** ${ageMinutes} minutes`

            // active claude code sessions
            const ccSessions = await getActiveClaudeCodeSessions()
            if (ccSessions.length > 0) {
              reply += '\n\n🖥️ **Active Claude Code Sessions**\n'
              for (const s of ccSessions) {
                const mins = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000)
                const task = s.task.length > 60 ? s.task.slice(0, 60) + '...' : s.task
                reply += `\`${s.sessionId}\` (${mins}m) — ${task}\n`
              }
            }

            // upcoming timers
            const timers = await getUpcomingTimers(5)
            if (timers.length > 0) {
              reply += '\n⏰ **Upcoming Timers**\n'
              for (const t of timers) {
                reply += `\`${t.filename}\` — ${formatLocalTime(t.nextFire)} (in ${formatTimeUntil(t.nextFire)})\n`
              }
            }

            await interaction.editReply(reply)
          }
        } catch (err) {
          const errorMsg = `❌ command error: ${err}`
          if (interaction.deferred) {
            await interaction.editReply(errorMsg)
          } else {
            await interaction.reply({ content: errorMsg, ephemeral: true })
          }
        }
      })

      await client.login(config.token)

      // run attachment cleanup on startup and every 6 hours
      cleanupOldAttachments()
      cleanupInterval = setInterval(cleanupOldAttachments, 6 * 60 * 60 * 1000)
    },

    async destroy() {
      if (cleanupInterval) {
        clearInterval(cleanupInterval)
        cleanupInterval = null
      }
      if (client) {
        await client.destroy()
        client = null
      }
    },
  }
}
