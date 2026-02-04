import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage, Tool } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig } from './config.ts'
import { ensureDataDirs, generateSessionId } from './session.ts'
import { runAgentTurn } from './agent.ts'
import { AnthropicProvider } from '../providers/anthropic.ts'
import createToolsPlugin from '../plugins/tools.ts'
import createMemoryPlugin from '../plugins/memory.ts'
import createCorePlugin from '../plugins/core.ts'
import createWritePluginPlugin from '../plugins/write-plugin.ts'
import createDiscordPlugin from '../plugins/discord.ts'

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

async function main() {
  console.log('toebeans server starting...')

  await ensureDataDirs()
  const config = await loadConfig()

  const pluginManager = new PluginManager()

  // register builtin plugins
  pluginManager.registerBuiltin('tools', createToolsPlugin)
  pluginManager.registerBuiltin('memory', createMemoryPlugin)
  pluginManager.registerBuiltin('write-plugin', createWritePluginPlugin)
  pluginManager.registerBuiltin('discord', createDiscordPlugin)
  // core needs the plugin manager reference
  pluginManager.registerBuiltin('core', () => createCorePlugin(pluginManager))

  // load plugins from config
  for (const [name, pluginConfig] of Object.entries(config.plugins)) {
    try {
      await pluginManager.loadPlugin(name, pluginConfig)
      console.log(`loaded plugin: ${name} (${pluginConfig.state})`)
    } catch (err) {
      console.error(`failed to load plugin ${name}:`, err)
    }
  }

  const provider = new AnthropicProvider()

  // start consuming plugin inputs (for channel plugins like discord)
  async function consumePluginInputs() {
    for (const [name, loaded] of pluginManager.getAllPlugins()) {
      if (loaded.plugin.input && loaded.state === 'loaded') {
        ;(async () => {
          try {
            for await (const { sessionId, message } of loaded.plugin.input!) {
              console.log(`[${name}] incoming message for session: ${sessionId}`)
              const text = message.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map(b => b.text)
                .join('\n')
              if (!text.trim()) continue

              try {
                await runAgentTurn(text, {
                  provider,
                  system: buildSystemPrompt,
                  tools: getTools,
                  sessionId,
                  workingDir: process.cwd(),
                  onChunk: (chunk) => broadcast(sessionId, chunk),
                })
              } catch (err) {
                console.error(`agent error for ${sessionId}:`, err)
                broadcast(sessionId, { type: 'error', message: String(err) })
              }
            }
          } catch (err) {
            console.error(`plugin input error (${name}):`, err)
          }
        })()
      }
    }
  }

  function buildSystemPrompt(): string {
    const base = `You are a helpful AI assistant called toebeans. You have access to various tools and plugins to help users.

Current working directory: ${process.cwd()}`

    const pluginSection = pluginManager.getSystemPromptSection()

    return pluginSection ? `${base}\n\n${pluginSection}` : base
  }

  function getTools(): Tool[] {
    return pluginManager.getTools()
  }

  function broadcast(sessionId: string, message: ServerMessage) {
    const subscribers = sessionSubscribers.get(sessionId)
    if (subscribers) {
      const data = JSON.stringify(message)
      for (const ws of subscribers) {
        ws.send(data)
      }
    }
  }

  async function handleMessage(ws: ServerWebSocket<WebSocketData>, msg: ClientMessage) {
    switch (msg.type) {
      case 'subscribe': {
        ws.data.subscriptions.add(msg.sessionId)
        let subscribers = sessionSubscribers.get(msg.sessionId)
        if (!subscribers) {
          subscribers = new Set()
          sessionSubscribers.set(msg.sessionId, subscribers)
        }
        subscribers.add(ws)
        console.log(`client subscribed to session: ${msg.sessionId}`)
        break
      }

      case 'message': {
        console.log(`message for session ${msg.sessionId}: ${msg.content.slice(0, 50)}...`)

        try {
          await runAgentTurn(msg.content, {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId: msg.sessionId,
            workingDir: process.cwd(),
            onChunk: (chunk) => broadcast(msg.sessionId, chunk),
          })
        } catch (err) {
          console.error('agent error:', err)
          broadcast(msg.sessionId, { type: 'error', message: String(err) })
        }
        break
      }
    }
  }

  const port = parseInt(process.env.PORT ?? '3000', 10)

  const server = Bun.serve<WebSocketData>({
    port,
    fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req, {
          data: { subscriptions: new Set() },
        })
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 })
        }
        return undefined
      }

      if (url.pathname === '/health') {
        return new Response('ok')
      }

      if (url.pathname === '/session/new') {
        const sessionId = generateSessionId()
        return new Response(JSON.stringify({ sessionId }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response('toebeans server', { status: 200 })
    },

    websocket: {
      open(ws) {
        console.log('client connected')
      },

      message(ws, message) {
        try {
          const msg = JSON.parse(message.toString()) as ClientMessage
          handleMessage(ws, msg)
        } catch (err) {
          console.error('invalid message:', err)
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
        }
      },

      close(ws) {
        console.log('client disconnected')
        // remove from all subscriptions
        for (const sessionId of ws.data.subscriptions) {
          const subscribers = sessionSubscribers.get(sessionId)
          if (subscribers) {
            subscribers.delete(ws)
            if (subscribers.size === 0) {
              sessionSubscribers.delete(sessionId)
            }
          }
        }
      },
    },
  })

  console.log(`server running on http://localhost:${server.port}`)

  // start plugin input consumers
  consumePluginInputs()
}

main().catch(console.error)
