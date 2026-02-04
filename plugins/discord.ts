import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, Message } from '../server/types.ts'
import { Client, GatewayIntentBits, Partials, Events, ChannelType, type TextChannel, type DMChannel, type Message as DiscordMessage } from 'discord.js'

interface DiscordConfig {
  token: string
  channels?: string[]  // channel IDs to listen to (empty = all accessible)
  respondToMentions?: boolean  // only respond when mentioned
  allowDMs?: boolean  // respond to direct messages (default: true)
}

interface QueuedMessage {
  sessionId: string
  message: Message
}

export default function createDiscordPlugin(): Plugin {
  let client: Client | null = null
  let config: DiscordConfig | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  function queueMessage(channelId: string, content: string, author: string) {
    const msg: QueuedMessage = {
      sessionId: `discord:${channelId}`,
      message: {
        role: 'user',
        content: [{ type: 'text', text: `[${author}]: ${content}` }],
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
    description: `Discord bot integration:
- discord_send: Send a message to a channel
- discord_read_history: Read recent messages from a channel
- discord_react: Add emoji reaction to a message
- discord_list_channels: List accessible channels

The bot listens for messages and can respond to conversations.`,

    tools,

    input: inputGenerator(),

    async output(sessionId: string, content: string) {
      if (!client) return

      // sessionId format: discord:channelId
      const channelId = sessionId.replace(/^discord:/, '')
      if (!channelId) return

      try {
        const channel = await client.channels.fetch(channelId)
        if (!channel?.isTextBased()) return

        // split long messages (discord limit is 2000 chars)
        const chunks: string[] = []
        let remaining = content
        while (remaining.length > 0) {
          if (remaining.length <= 2000) {
            chunks.push(remaining)
            break
          }
          // try to split at newline
          let splitAt = remaining.lastIndexOf('\n', 2000)
          if (splitAt === -1 || splitAt < 1000) splitAt = 2000
          chunks.push(remaining.slice(0, splitAt))
          remaining = remaining.slice(splitAt).trimStart()
        }

        for (const chunk of chunks) {
          await (channel as TextChannel | DMChannel).send(chunk)
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

        const isDM = msg.channel.type === ChannelType.DM

        // handle DMs
        if (isDM) {
          if (config!.allowDMs === false) return
          // start typing immediately
          ;(msg.channel as DMChannel).sendTyping().catch(() => {})
          queueMessage(msg.channelId, msg.content, msg.author.username)
          return
        }

        // filter by channels if configured (only for guild messages)
        if (config!.channels?.length && !config!.channels.includes(msg.channelId)) {
          return
        }

        // filter by mentions if configured
        if (config!.respondToMentions && client?.user && !msg.mentions.has(client.user.id)) {
          return
        }

        // start typing immediately
        if ('sendTyping' in msg.channel) {
          ;(msg.channel as TextChannel).sendTyping().catch(() => {})
        }
        queueMessage(msg.channelId, msg.content, msg.author.username)
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
