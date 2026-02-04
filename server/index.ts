import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage, Tool } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig } from './config.ts'
import { ensureDataDirs, generateSessionId, loadSession, getSoulPath, listSessions } from './session.ts'
import { runAgentTurn } from './agent.ts'
import { AnthropicProvider } from '../providers/anthropic.ts'
import createToolsPlugin from '../plugins/tools.ts'
import createMemoryPlugin from '../plugins/memory.ts'
import createCorePlugin from '../plugins/core.ts'
import createWritePluginPlugin from '../plugins/write-plugin.ts'
import createDiscordPlugin from '../plugins/discord.ts'
import createPluginManagerPlugin from '../plugins/plugin-manager.ts'
import createClaudeCodePlugin from '../plugins/claude-code.ts'

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

async function main() {
  console.log('toebeans server starting...')

  await ensureDataDirs()
  const config = await loadConfig()

  // load soul (or create from default)
  const soulPath = getSoulPath()
  const soulFile = Bun.file(soulPath)
  let soul: string
  if (await soulFile.exists()) {
    soul = await soulFile.text()
  } else {
    const defaultSoul = await Bun.file(new URL('./default-soul.md', import.meta.url)).text()
    await Bun.write(soulPath, defaultSoul)
    soul = defaultSoul
    console.log(`created default SOUL.md at ${soulPath}`)
  }

  const pluginManager = new PluginManager()

  // register builtin plugins
  pluginManager.registerBuiltin('tools', createToolsPlugin)
  pluginManager.registerBuiltin('memory', createMemoryPlugin)
  pluginManager.registerBuiltin('write-plugin', createWritePluginPlugin)
  pluginManager.registerBuiltin('discord', createDiscordPlugin)
  pluginManager.registerBuiltin('plugin-manager', createPluginManagerPlugin)
  pluginManager.registerBuiltin('claude-code', createClaudeCodePlugin)
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

  // create provider from config
  if (config.llm.provider !== 'anthropic') {
    throw new Error(`unsupported provider: ${config.llm.provider}`)
  }
  const provider = new AnthropicProvider({
    apiKey: config.llm.apiKey,
    model: config.llm.model,
  })

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

              // collect response text to send back via plugin output
              let responseText = ''

              try {
                await runAgentTurn(text, {
                  provider,
                  system: buildSystemPrompt,
                  tools: getTools,
                  sessionId,
                  workingDir: process.cwd(),
                  onChunk: (chunk) => {
                    broadcast(sessionId, chunk)
                    // collect text chunks for plugin output
                    if (chunk.type === 'text') {
                      responseText += chunk.text
                    }
                  },
                })

                // send response back via plugin output
                if (responseText.trim() && loaded.plugin.output) {
                  await loaded.plugin.output(sessionId, responseText)
                }
              } catch (err) {
                console.error(`agent error for ${sessionId}:`, err)
                broadcast(sessionId, { type: 'error', message: String(err) })
                // send error back via plugin output
                if (loaded.plugin.output) {
                  await loaded.plugin.output(sessionId, `error: ${err}`)
                }
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
    const parts: string[] = []

    // soul first - sets the tone
    parts.push(soul)

    // then context
    parts.push(`Current working directory: ${process.cwd()}`)

    // then plugin instructions
    const pluginSection = pluginManager.getSystemPromptSection()
    if (pluginSection) {
      parts.push(pluginSection)
    }

    return parts.join('\n\n')
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
    async fetch(req, server) {
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
        const sessionId = await generateSessionId()
        return new Response(JSON.stringify({ sessionId }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url.pathname === '/sessions') {
        const sessions = await listSessions()
        return new Response(JSON.stringify(sessions), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // get session messages
      const sessionMatch = url.pathname.match(/^\/session\/(.+)\/messages$/)
      if (sessionMatch) {
        const messages = await loadSession(sessionMatch[1])
        return new Response(JSON.stringify(messages), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // debug endpoint: GET /debug/:sessionId
      const debugMatch = url.pathname.match(/^\/debug\/(.+)$/)
      if (debugMatch) {
        const sessionId = debugMatch[1]
        const messages = await loadSession(sessionId)
        const system = buildSystemPrompt()
        const tools = getTools().map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }))

        const debug = {
          sessionId,
          system,
          messages,
          tools,
          stats: {
            messageCount: messages.length,
            systemLength: system.length,
            toolCount: tools.length,
            estimatedTokens: Math.ceil(
              (system.length + JSON.stringify(messages).length + JSON.stringify(tools).length) / 4
            ),
          },
        }

        return new Response(JSON.stringify(debug, null, 2), {
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
