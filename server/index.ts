import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage, Tool, ContentBlock } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig } from './config.ts'
import { ensureDataDirs, loadSession, getSoulPath, listSessions, getWorkspaceDir, setLastOutputTarget, getLastOutputTarget, getCurrentSessionId } from './session.ts'
import { runAgentTurn } from './agent.ts'
import { createSessionManager } from './session-manager.ts'
import { AnthropicProvider } from '../llm-providers/anthropic.ts'

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

// track pending interrupt messages per session
interface InterruptMessage {
  content: ContentBlock[]
  outputTarget: string
}
const interruptBuffers = new Map<string, InterruptMessage[]>()
const sessionBusy = new Map<string, boolean>()
const sessionAbort = new Map<string, boolean>()

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
    effort: config.llm.effort,
  })

  const pluginManager = new PluginManager()

  // prepare server context for plugins (will be populated with routeOutput after it's defined)
  const serverContext = { routeOutput: null as any, config }

  pluginManager.setServerContext(serverContext)

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

  // populate routeOutput in server context now that it's defined
  serverContext.routeOutput = routeOutput

  // create session manager with routeOutput available
  const sessionManager = createSessionManager(provider, config, routeOutput, pluginManager)

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

  // send restart notification if configured
  if (config.notifyOnRestart) {
    console.log(`[server] sending restart notification to: ${config.notifyOnRestart}`)
    try {
      await routeOutput(config.notifyOnRestart, { type: 'text', text: 'back online ✓' })
      await routeOutput(config.notifyOnRestart, { type: 'text_block_end' })
    } catch (err) {
      console.error(`[server] failed to send restart notification:`, err)
    }
  }

  // check if we should auto-continue after restart
  const lastOutputTarget = await getLastOutputTarget()
  if (lastOutputTarget) {
    console.log(`[server] checking for auto-continue (last output target: ${lastOutputTarget})`)
    try {
      const resumeRoute = lastOutputTarget  // route = outputTarget string
      const sessionId = await getCurrentSessionId(resumeRoute)
      const messages = await loadSession(sessionId)

      // check if last assistant message had restart_server tool call
      let shouldResume = false
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg?.role === 'assistant') {
          // check if this assistant message has a restart_server tool use
          for (const block of msg.content) {
            if (block.type === 'tool_use' && block.name === 'restart_server') {
              shouldResume = true
              break
            }
          }
          break // only check the last assistant message
        }
      }

      if (shouldResume) {
        console.log(`[server] auto-continuing session ${sessionId} on output target ${lastOutputTarget}`)
        // clear the last output target so we don't auto-resume again
        await setLastOutputTarget(null)

        // trigger a new agent turn with a system message
        const outputFn = (message: ServerMessage) => routeOutput(lastOutputTarget, message)

        // mark session as busy
        sessionBusy.set(sessionId, true)

        try {
          sessionAbort.set(sessionId, false)
          const resumeOnChunk = async (chunk: ServerMessage) => {
            broadcast(sessionId, chunk)
            await outputFn(chunk)
          }
          const resumeCheckInterrupts = () => {
            const buffer = interruptBuffers.get(sessionId) || []
            interruptBuffers.set(sessionId, [])
            return buffer
          }
          const resumeCheckAbort = () => {
            return sessionAbort.get(sessionId) || false
          }

          await runAgentTurn([{ type: 'text', text: 'server restarted successfully. continuing from where you left off.' }], {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId,
            workingDir: getWorkspaceDir(),
            onChunk: resumeOnChunk,
            checkInterrupts: resumeCheckInterrupts,
            checkAbort: resumeCheckAbort,
          })

          // drain remaining interrupts as new turns
          while (true) {
            const remaining = resumeCheckInterrupts()
            if (remaining.length === 0) break
            console.log(`[server] draining ${remaining.length} remaining interrupt(s) as new turn`)
            const interruptContent: ContentBlock[] = remaining.flatMap(r => r.content)
            await runAgentTurn(interruptContent, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId,
              workingDir: getWorkspaceDir(),
              onChunk: resumeOnChunk,
              checkInterrupts: resumeCheckInterrupts,
              checkAbort: resumeCheckAbort,
            })
          }

          await sessionManager.checkCompaction(sessionId, resumeRoute)
        } catch (err) {
          console.error(`[server] auto-continue error:`, err)
          broadcast(sessionId, { type: 'error', message: String(err) })
          await outputFn({ type: 'error', message: String(err) })
        } finally {
          sessionBusy.set(sessionId, false)
        }
      } else {
        console.log(`[server] no restart_server tool call found in last assistant message, not auto-continuing`)
        await setLastOutputTarget(null)
      }
    } catch (err) {
      console.error(`[server] error checking for auto-continue:`, err)
      await setLastOutputTarget(null)
    }
  }

  // start consuming inputs from all loaded plugins
  for (const [name, loaded] of pluginManager.getAllPlugins()) {
    if (!loaded.plugin.input) continue

    console.log(`[server] starting input consumer for plugin: ${name}`)
    ;(async () => {
      try {
        console.log(`[server] entering input loop for plugin: ${name}`)
        for await (const queuedMsg of loaded.plugin.input!) {
          const { message, outputTarget } = queuedMsg as any
          // route = outputTarget (e.g. "discord:1466679760976609393")
          // this ensures each channel/DM/source gets its own session
          const route = outputTarget || name
          const conversationSessionId = await sessionManager.getSessionForMessage(route)

          // handle stop request
          if ((queuedMsg as any).stopRequested) {
            console.log(`[${name}] stop requested for session ${conversationSessionId}`)
            sessionAbort.set(conversationSessionId, true)

            // send confirmation back to the plugin
            if (outputTarget) {
              await routeOutput(outputTarget, { type: 'text', text: 'stopped ✋' })
              await routeOutput(outputTarget, { type: 'text_block_end' })
            }
            continue
          }

          console.log(`[${name}] message -> session: ${conversationSessionId} (route: ${route})`)
          const content = message.content
          if (content.length === 0) continue

          // determine output function and target
          const effectiveOutputTarget = outputTarget || null
          let outputFn: ((message: ServerMessage) => Promise<void>) | null = null
          if (effectiveOutputTarget) {
            outputFn = (message) => routeOutput(effectiveOutputTarget, message)
          }

          // check if session is busy (agent is currently processing)
          if (sessionBusy.get(conversationSessionId)) {
            // buffer this message as an interrupt
            console.log(`[${name}] session ${conversationSessionId} busy, buffering interrupt`)
            if (!interruptBuffers.has(conversationSessionId)) {
              interruptBuffers.set(conversationSessionId, [])
            }
            interruptBuffers.get(conversationSessionId)!.push({
              content,
              outputTarget: effectiveOutputTarget || '',
            })

            // notify the sender that their message will be injected
            if (effectiveOutputTarget) {
              routeOutput(effectiveOutputTarget, { type: 'text', text: '(queued — will inject between tool calls)' })
                .then(() => routeOutput(effectiveOutputTarget, { type: 'text_block_end' }))
                .catch(() => {}) // best-effort notification
            }
            continue
          }

          // mark session as busy and clear any previous abort flag
          sessionBusy.set(conversationSessionId, true)
          sessionAbort.set(conversationSessionId, false)

          // track output target for auto-resume after restart
          if (effectiveOutputTarget) {
            await setLastOutputTarget(effectiveOutputTarget)
          }

          try {
            const agentOnChunk = async (chunk: ServerMessage) => {
              broadcast(conversationSessionId, chunk)
              if (outputFn) {
                await outputFn(chunk)
              }
            }
            const agentCheckInterrupts = () => {
              const buffer = interruptBuffers.get(conversationSessionId) || []
              interruptBuffers.set(conversationSessionId, [])
              return buffer
            }
            const agentCheckAbort = () => {
              return sessionAbort.get(conversationSessionId) || false
            }

            await runAgentTurn(content, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId: conversationSessionId,
              workingDir: getWorkspaceDir(),
              onChunk: agentOnChunk,
              checkInterrupts: agentCheckInterrupts,
              checkAbort: agentCheckAbort,
            })

            // drain any remaining interrupts that arrived during a no-tool-use response
            // (checkInterrupts only runs between tool calls, so these would be stranded)
            while (true) {
              const remaining = agentCheckInterrupts()
              if (remaining.length === 0) break
              console.log(`[${name}] draining ${remaining.length} remaining interrupt(s) as new turn`)
              const interruptContent: ContentBlock[] = remaining.flatMap(r => r.content)
              await runAgentTurn(interruptContent, {
                provider,
                system: buildSystemPrompt,
                tools: getTools,
                sessionId: conversationSessionId,
                workingDir: getWorkspaceDir(),
                onChunk: agentOnChunk,
                checkInterrupts: agentCheckInterrupts,
                checkAbort: agentCheckAbort,
              })
            }

            // check if session needs compaction
            await sessionManager.checkCompaction(conversationSessionId, route)
          } catch (err) {
            console.error(`agent error for ${conversationSessionId}:`, err)
            broadcast(conversationSessionId, { type: 'error', message: String(err) })

            // send error output
            if (outputFn) {
              await outputFn({ type: 'error', message: String(err) })
            }
          } finally {
            // mark session as not busy and clear abort flag
            sessionBusy.set(conversationSessionId, false)
            sessionAbort.set(conversationSessionId, false)
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

    // plugin-contributed prompts (memory, etc.)
    const pluginPrompts = await pluginManager.buildSystemPrompts()
    parts.push(...pluginPrompts)

    // then context
    parts.push(`Current working directory: ${getWorkspaceDir()}`)

    // then plugin instructions (tool descriptions)
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
        // websocket messages get their own route
        const wsRoute = 'ws'
        const wsSessionId = await sessionManager.getSessionForMessage(wsRoute)
        console.log(`message for session ${wsSessionId}: ${msg.content.slice(0, 50)}...`)

        // check if session is busy
        if (sessionBusy.get(wsSessionId)) {
          console.log(`[websocket] session ${wsSessionId} busy, buffering interrupt`)
          if (!interruptBuffers.has(wsSessionId)) {
            interruptBuffers.set(wsSessionId, [])
          }
          interruptBuffers.get(wsSessionId)!.push({
            content: [{ type: 'text', text: msg.content }],
            outputTarget: '',
          })
          // notify via websocket broadcast
          broadcast(wsSessionId, { type: 'text', text: '(queued — will inject between tool calls)' })
          broadcast(wsSessionId, { type: 'text_block_end' })
          break
        }

        // mark session as busy and clear any previous abort flag
        sessionBusy.set(wsSessionId, true)
        sessionAbort.set(wsSessionId, false)

        // clear output target for websocket messages (no auto-resume needed)
        await setLastOutputTarget(null)

        try {
          const wsOnChunk = (chunk: ServerMessage) => broadcast(wsSessionId, chunk)
          const wsCheckInterrupts = () => {
            const buffer = interruptBuffers.get(wsSessionId) || []
            interruptBuffers.set(wsSessionId, [])
            return buffer
          }
          const wsCheckAbort = () => {
            return sessionAbort.get(wsSessionId) || false
          }

          await runAgentTurn([{ type: 'text', text: msg.content }], {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId: wsSessionId,
            workingDir: getWorkspaceDir(),
            onChunk: wsOnChunk,
            checkInterrupts: wsCheckInterrupts,
            checkAbort: wsCheckAbort,
          })

          // drain remaining interrupts as new turns
          while (true) {
            const remaining = wsCheckInterrupts()
            if (remaining.length === 0) break
            console.log(`[websocket] draining ${remaining.length} remaining interrupt(s) as new turn`)
            const interruptContent: ContentBlock[] = remaining.flatMap(r => r.content)
            await runAgentTurn(interruptContent, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId: wsSessionId,
              workingDir: getWorkspaceDir(),
              onChunk: wsOnChunk,
              checkInterrupts: wsCheckInterrupts,
              checkAbort: wsCheckAbort,
            })
          }

          await sessionManager.checkCompaction(wsSessionId, wsRoute)
        } catch (err) {
          console.error('agent error:', err)
          broadcast(wsSessionId, { type: 'error', message: String(err) })
        } finally {
          sessionBusy.set(wsSessionId, false)
          sessionAbort.set(wsSessionId, false)
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

      // get current session for a route (for TUI to connect to)
      // optional ?route= param, defaults to 'ws'
      if (url.pathname === '/session/current') {
        const route = url.searchParams.get('route') || 'ws'
        const sessionId = await sessionManager.getSessionForMessage(route)
        return new Response(JSON.stringify({ sessionId, route }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // legacy: /session/new now returns current session
      if (url.pathname === '/session/new') {
        const route = url.searchParams.get('route') || 'ws'
        const sessionId = await sessionManager.getSessionForMessage(route)
        return new Response(JSON.stringify({ sessionId, route }), {
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

      // debug endpoint: GET /debug/system
      if (url.pathname === '/debug/system') {
        const system = await buildSystemPrompt()
        return new Response(system, {
          headers: { 'content-type': 'text/plain' },
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
