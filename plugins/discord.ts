import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, Message } from '../server/types.ts'
import { Client, GatewayIntentBits, Partials, Events, ChannelType, type TextChannel, type DMChannel, type Message as DiscordMessage } from 'discord.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import https from 'https'
import http from 'http'

const execAsync = promisify(exec)

interface DiscordConfig {
  token: string
  allowedUsers: string[]  // user IDs allowed to interact (required for safety)
  channels?: string[]  // channel IDs to listen to (empty = all accessible)
  respondToMentions?: boolean  // only respond when mentioned
  allowDMs?: boolean  // respond to direct messages (default: true)
  transcribeVoice?: boolean  // transcribe voice messages (default: true)
}

interface QueuedMessage {
  sessionId: string
  message: Message
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

async function transcribeAudio(audioPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`uvx --from openai-whisper whisper "${audioPath}" --model tiny --language en --output_format txt`)
    // whisperx outputs a .txt file in the same directory
    const txtPath = audioPath.replace(/\.[^.]+$/, '.txt')
    try {
      const { stdout: transcription } = await execAsync(`cat "${txtPath}"`)
      await unlink(txtPath)
      return transcription.trim()
    } catch {
      // if txt file doesn't exist, return stdout
      return stdout.trim() || '(transcription failed)'
    }
  } catch (err) {
    console.error('Transcription error:', err)
    return `(transcription failed: ${err})`
  }
}

export default function createDiscordPlugin(): Plugin {
  let client: Client | null = null
  let config: DiscordConfig | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  // track buffered content per session (for sentence-based sending)
  const messageBuffers = new Map<string, string>()
  // lock to prevent concurrent sends per session
  const sendLocks = new Map<string, Promise<void>>()

  function queueMessage(channelId: string, content: string, author: string, isDM: boolean) {
    const channelContext = isDM
      ? `[DM from ${author}, channel_id: ${channelId}]`
      : `[#channel ${channelId}, from ${author}]`

    const msg: QueuedMessage = {
      sessionId: `discord:${channelId}`,
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${channelContext}\n${content}` }],
      },
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
          await (channel as TextChannel | DMChannel).send(truncated)
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
            .map(m => `[${m.author.username}] ${m.content}`)
            .join('\n')
          return { content: formatted || '(no messages)' }
        } catch (err) {
          return { content: `Failed to read: ${err}`, is_error: true }
        }
      },
    },
    {
      name: 'discord_react',
      description: 'Add a reaction to a message.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID' },
          message_id: { type: 'string', description: 'Message ID to react to' },
          emoji: { type: 'string', description: 'Emoji to react with (unicode or custom emoji name)' },
        },
        required: ['channel_id', 'message_id', 'emoji'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!client) {
          return { content: 'Discord client not connected', is_error: true }
        }
        const { channel_id, message_id, emoji } = input as { channel_id: string; message_id: string; emoji: string }
        try {
          const channel = await client.channels.fetch(channel_id)
          if (!channel?.isTextBased()) {
            return { content: 'Channel not found or not a text channel', is_error: true }
          }
          const message = await (channel as TextChannel).messages.fetch(message_id)
          await message.react(emoji)
          return { content: `Reacted with ${emoji}` }
        } catch (err) {
          return { content: `Failed to react: ${err}`, is_error: true }
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
    summary: 'Discord integration. Use load_plugin("discord") to send/read messages.',
    description: `Discord bot integration. Your text responses are automatically sent back to the channel/DM.

Automatically transcribes voice messages using WhisperX.

Tools (only use these for special cases):
- discord_send: Send a message to a different channel than you're responding to
- discord_read_history: Read recent messages from a channel
- discord_react: Add emoji reaction to a message
- discord_list_channels: List accessible channels

Messages include [channel_id: X] - use this if you need to call discord tools.`,

    tools,

    input: inputGenerator(),

    async output(sessionId: string, content: string) {
      if (!client) return

      // sessionId format: channelId (already stripped of discord: prefix by routeOutput)
      const channelId = sessionId
      if (!channelId) return

      // serialize sends per session to prevent out-of-order messages
      const prevLock = sendLocks.get(sessionId) || Promise.resolve()
      const currentLock = prevLock.then(async () => {
        // special marker to flush remaining buffer
        const shouldFlush = content === '__FLUSH__'

        try {
          const channel = await client!.channels.fetch(channelId)
          if (!channel?.isTextBased()) return
          const textChannel = channel as TextChannel | DMChannel

          // helper to send a message with human-like delay, splitting if over 2000 chars
          const sendMessage = async (text: string, moreToFollow: boolean) => {
            const trimmed = text.trim()
            if (!trimmed) return

            // human-like delay: 300ms + 10ms per character, max 1s
            const delay = Math.min(1000, 300 + trimmed.length * 10)
            await new Promise(resolve => setTimeout(resolve, delay))

            let remaining = trimmed
            while (remaining.length > 0) {
              const chunk = remaining.slice(0, 2000)
              await textChannel.send(chunk)
              remaining = remaining.slice(2000)
            }

            // show typing indicator if more content is coming
            if (moreToFollow) {
              textChannel.sendTyping().catch(() => {})
            }
          }

          // get or create buffer for this session
          let buffer = messageBuffers.get(sessionId) || ''

          if (shouldFlush) {
            // send any remaining buffer
            if (buffer.trim()) {
              await sendMessage(buffer, false)
            }
            messageBuffers.delete(sessionId)
            sendLocks.delete(sessionId)
            return
          }

          // append new content to buffer
          buffer += content
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

            // no complete paragraph found, wait for more content
            break
          }
        } catch (err) {
          console.error(`discord output error:`, err)
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
          if (config!.respondToMentions && client?.user && !msg.mentions.has(client.user.id)) {
            return
          }
        }

        // start typing immediately
        const typingChannel = msg.channel as TextChannel | DMChannel
        typingChannel.sendTyping().catch(() => {})

        let content = msg.content

        // handle voice messages / audio attachments
        if (config!.transcribeVoice !== false && msg.attachments.size > 0) {
          for (const attachment of msg.attachments.values()) {
            // check if it's an audio file
            const isAudio = attachment.contentType?.startsWith('audio/') || 
                           /\.(mp3|wav|ogg|m4a|opus|webm)$/i.test(attachment.name || '')
            
            if (isAudio) {
              try {
                const tempFile = join(tmpdir(), `discord-audio-${Date.now()}-${attachment.name}`)
                await downloadFile(attachment.url, tempFile)
                const transcription = await transcribeAudio(tempFile)
                await unlink(tempFile).catch(() => {})
                
                content += `\n\n[Voice message transcription: ${transcription}]`
              } catch (err) {
                console.error('Failed to transcribe audio:', err)
                content += `\n\n[Voice message - transcription failed]`
              }
            }
          }
        }

        queueMessage(msg.channelId, content, msg.author.username, isDM)
      })

      client.on(Events.ClientReady, () => {
        console.log(`discord: logged in as ${client!.user?.tag}`)
      })

      await client.login(config.token)
    },

    async destroy() {
      if (client) {
        await client.destroy()
        client = null
      }
    },
  }
}
