import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage, Tool } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig } from './config.ts'
import { ensureDataDirs, loadSession, getSoulPath, listSessions, getKnowledgeDir, getWorkspaceDir } from './session.ts'
import { join } from 'path'
import { runAgentTurn } from './agent.ts'
import { createSessionManager } from './session-manager.ts'
import { AnthropicProvider } from '../llm-providers/anthropic.ts'

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

async function main() {
  console.log('toebeans server starting...')

  await ensureDataDirs()
  process.chdir(getWorkspaceDir())
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

  // create provider from config
  if (config.llm.provider !== 'anthropic') {
    throw new Error(`unsupported provider: ${config.llm.provider}`)
  }
  const provider = new AnthropicProvider({
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    thinkingBudget: config.llm.thinkingBudget,
  })

  // create session manager for handling main session and compaction
  const sessionManager = createSessionManager(provider, config)

  const pluginManager = new PluginManager()

  // load plugins from config
  for (const [name, pluginConfig] of Object.entries(config.plugins)) {
    try {
      // inject session manager into discord plugin config
      const effectiveConfig = name === 'discord'
        ? { ...(pluginConfig as object), sessionManager }
        : pluginConfig
      await pluginManager.loadPlugin(name, effectiveConfig)
      console.log(`loaded plugin: ${name}`)
    } catch (err) {
      console.error(`failed to load plugin ${name}:`, err)
    }
  }

  // route output to a plugin by target string (format: 'pluginName:target')
  async function routeOutput(target: string, message: ServerMessage) {
    const colonIdx = target.indexOf(':')
    if (colonIdx === -1) {
      console.error(`invalid output target format: ${target} (expected pluginName:target)`)
      return
    }

    const pluginName = target.slice(0, colonIdx)
    const pluginTarget = target.slice(colonIdx + 1)

    const targetPlugin = pluginManager.getPlugin(pluginName)
    if (!targetPlugin) {
      console.error(`output target plugin not found: ${pluginName}`)
      return
    }

    if (!targetPlugin.plugin.output) {
      console.error(`output target plugin has no output function: ${pluginName}`)
      return
    }

    await targetPlugin.plugin.output(pluginTarget, message)
  }

  // start consuming inputs from all loaded plugins
  for (const [name, loaded] of pluginManager.getAllPlugins()) {
    if (!loaded.plugin.input) continue

    console.log(`[server] starting input consumer for plugin: ${name}`)
    ;(async () => {
      try {
        console.log(`[server] entering input loop for plugin: ${name}`)
        for await (const { sessionId: pluginSessionId, message, outputTarget } of loaded.plugin.input!) {
          const mainSessionId = await sessionManager.getSessionForMessage()
          const conversationSessionId = mainSessionId

          console.log(`[${name}] message -> session: ${conversationSessionId} (output: ${outputTarget || pluginSessionId})`)
          const text = message.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n')
          if (!text.trim()) continue

          // determine output function and target
          const effectiveOutputTarget = outputTarget || (loaded.plugin.output ? `${name}:${pluginSessionId.split(':')[1] || pluginSessionId}` : null)
          let outputFn: ((message: ServerMessage) => Promise<void>) | null = null
          if (effectiveOutputTarget) {
            outputFn = (message) => routeOutput(effectiveOutputTarget, message)
          }

          try {
            await runAgentTurn(text, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId: conversationSessionId,
              workingDir: getWorkspaceDir(),
              onChunk: async (chunk) => {
                broadcast(conversationSessionId, chunk)

                // stream all chunks to output function
                if (outputFn) {
                  await outputFn(chunk)
                }
              },
            })

            // check if session needs compaction
            await sessionManager.checkCompaction(conversationSessionId)
          } catch (err) {
            console.error(`agent error for ${conversationSessionId}:`, err)
            broadcast(conversationSessionId, { type: 'error', message: String(err) })

            // send error output
            if (outputFn) {
              await outputFn({ type: 'error', message: String(err) })
            }
          }
        }
      } catch (err) {
        console.error(`plugin input error (${name}):`, err)
      }
    })()
  }

  async function buildSystemPrompt(): Promise<string> {
    const parts: string[] = []

    // soul first - sets the tone
    parts.push(soul)

    // user knowledge (if exists)
    const userKnowledgePath = join(getKnowledgeDir(), 'USER.md')
    const userKnowledgeFile = Bun.file(userKnowledgePath)
    if (await userKnowledgeFile.exists()) {
      const userKnowledge = await userKnowledgeFile.text()
      if (userKnowledge.trim()) {
        parts.push(userKnowledge)
      }
    }

    // recent daily logs (today and yesterday)
    const recentLogs: string[] = []
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    for (const date of [today, yesterday]) {
      const dateStr = date.toISOString().slice(0, 10)
      const dailyLogPath = join(getKnowledgeDir(), `${dateStr}.md`)
      const dailyLogFile = Bun.file(dailyLogPath)
      if (await dailyLogFile.exists()) {
        const content = await dailyLogFile.text()
        if (content.trim()) {
          recentLogs.push(content)
        }
      }
    }

    if (recentLogs.length > 0) {
      parts.push('## Recent Activity\n\n' + recentLogs.join('\n\n'))
    }

    // then context
    parts.push(`Current working directory: ${getWorkspaceDir()}`)

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
        // use main session for websocket messages too
        const wsSessionId = await sessionManager.getSessionForMessage()
        console.log(`message for session ${wsSessionId}: ${msg.content.slice(0, 50)}...`)

        try {
          await runAgentTurn(msg.content, {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId: wsSessionId,
            workingDir: getWorkspaceDir(),
            onChunk: (chunk) => broadcast(wsSessionId, chunk),
          })
          await sessionManager.checkCompaction(wsSessionId)
        } catch (err) {
          console.error('agent error:', err)
          broadcast(wsSessionId, { type: 'error', message: String(err) })
        }
        break
      }
    }
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.server.port

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

      // get current main session (for TUI to connect to)
      if (url.pathname === '/session/current') {
        const sessionId = await sessionManager.getSessionForMessage()
        return new Response(JSON.stringify({ sessionId }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // legacy: /session/new now returns current session
      if (url.pathname === '/session/new') {
        const sessionId = await sessionManager.getSessionForMessage()
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
        const messages = await loadSession(sessionMatch[1]!)
        return new Response(JSON.stringify(messages), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // debug endpoint: GET /debug/:sessionId
      const debugMatch = url.pathname.match(/^\/debug\/(.+)$/)
      if (debugMatch) {
        const sessionId = debugMatch[1]!
        const messages = await loadSession(sessionId)
        const system = await buildSystemPrompt()
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
}

main().catch(console.error)
