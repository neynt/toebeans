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

  // track streaming state per session
  const streamingMessages = new Map<string, { channel: TextChannel | DMChannel; messageId: string; buffer: string; lastUpdate: number }>()

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

      // sessionId format: discord:channelId
      const channelId = sessionId.replace(/^discord:/, '')
      if (!channelId) return

      // special marker to flush and end streaming
      const shouldFlush = content === '__FLUSH__'

      try {
        const channel = await client.channels.fetch(channelId)
        if (!channel?.isTextBased()) return

        const textChannel = channel as TextChannel | DMChannel
        let streamState = streamingMessages.get(sessionId)

        if (shouldFlush) {
          // flush final buffer
          if (streamState) {
            try {
              const msg = await textChannel.messages.fetch(streamState.messageId)
              if (streamState.buffer.length > 2000) {
                // split overflow into multiple messages
                await msg.edit(streamState.buffer.slice(0, 2000))
                let remaining = streamState.buffer.slice(2000)
                while (remaining.length > 0) {
                  const chunk = remaining.slice(0, 2000)
                  await textChannel.send(chunk)
                  remaining = remaining.slice(2000)
                }
              } else {
                await msg.edit(streamState.buffer)
              }
            } catch (err) {
              console.error('discord flush error:', err)
            }
            streamingMessages.delete(sessionId)
          }
          return
        }

        if (!streamState) {
          // start new streaming message
          const initialContent = content.slice(0, 2000) || '...'
          const msg = await textChannel.send(initialContent)
          streamState = {
            channel: textChannel,
            messageId: msg.id,
            buffer: content,
            lastUpdate: Date.now(),
          }
          streamingMessages.set(sessionId, streamState)
        } else {
          // append to existing buffer
          streamState.buffer += content

          // rate limit updates (max every 500ms to avoid discord rate limits)
          const now = Date.now()
          if (now - streamState.lastUpdate >= 500) {
            try {
              const msg = await textChannel.messages.fetch(streamState.messageId)
              // if buffer exceeds 2000 chars, send overflow as new message
              if (streamState.buffer.length > 2000) {
                await msg.edit(streamState.buffer.slice(0, 2000))
                const overflow = streamState.buffer.slice(2000)
                const newMsg = await textChannel.send(overflow.slice(0, 2000))
                streamState.messageId = newMsg.id
                streamState.buffer = overflow
              } else {
                await msg.edit(streamState.buffer)
              }
              streamState.lastUpdate = now
            } catch (err) {
              console.error('discord edit error:', err)
              // if edit fails, send as new message
              const msg = await textChannel.send(content.slice(0, 2000) || '...')
              streamState.messageId = msg.id
              streamState.buffer = content
              streamState.lastUpdate = now
            }
          }
        }
      } catch (err) {
        console.error(`discord output error:`, err)
      }
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
