import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage, Tool, ContentBlock } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig } from './config.ts'
import { ensureDataDirs, loadSession, getSoulPath, listSessions, getWorkspaceDir, setLastOutputTarget, getLastOutputTarget, getCurrentSessionId } from './session.ts'
import { runAgentTurn } from './agent.ts'
import { createSessionManager } from './session-manager.ts'
import { AnthropicProvider } from '../llm-providers/anthropic.ts'
import { OpenAICompatibleProvider } from '../llm-providers/openai-compatible.ts'
import type { LlmProvider } from './llm-provider.ts'
import { setTimezone, formatLocalTime, getTimezone } from './time.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'os'
import { join } from 'path'

// set up file logging — tee all console output to ~/.toebeans/server.log
const LOG_DIR = join(homedir(), '.toebeans')
const LOG_PATH = join(LOG_DIR, 'server.log')
mkdirSync(LOG_DIR, { recursive: true })

function writeToLog(level: string, args: unknown[]) {
  const timestamp = new Date().toISOString()
  const msg = args.map(a =>
    typeof a === 'string' ? a : (a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))
  ).join(' ')
  appendFileSync(LOG_PATH, `${timestamp} [${level}] ${msg}\n`)
}

const origLog = console.log.bind(console)
const origError = console.error.bind(console)
const origWarn = console.warn.bind(console)

console.log = (...args: unknown[]) => { origLog(...args); writeToLog('INFO', args) }
console.error = (...args: unknown[]) => { origError(...args); writeToLog('ERROR', args) }
console.warn = (...args: unknown[]) => { origWarn(...args); writeToLog('WARN', args) }

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

// track pending queued messages per session (messages sent while agent is busy)
interface QueuedMessage {
  content: ContentBlock[]
  outputTarget: string
  metadata?: Record<string, unknown>
}
const messageQueues = new Map<string, QueuedMessage[]>()
const sessionBusy = new Map<string, boolean>()
const sessionAbort = new Map<string, boolean>()
const sessionAbortControllers = new Map<string, AbortController>()

async function main() {
  console.log('toebeans server starting...')

  await ensureDataDirs()
  process.chdir(getWorkspaceDir())
  const config = await loadConfig()
  setTimezone(config.timezone)

  // load soul (or create from default)
  const soulPath = getSoulPath()
  const soulFile = Bun.file(soulPath)
  let soul: string
  if (await soulFile.exists()) {
    soul = await soulFile.text()
  } else {
    const defaultSoul = await Bun.file(new URL('../default-config/SOUL.md', import.meta.url)).text()
    await Bun.write(soulPath, defaultSoul)
    soul = defaultSoul
    console.log(`created default SOUL.md at ${soulPath}`)
  }

  // create provider from config
  let provider: LlmProvider
  switch (config.llm.provider) {
    case 'anthropic':
      provider = new AnthropicProvider({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        effort: config.llm.effort,
        maxOutputTokens: config.llm.maxOutputTokens,
      })
      break
    case 'openai-compatible':
      provider = new OpenAICompatibleProvider({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.openai?.baseUrl,
        model: config.llm.model,
        maxOutputTokens: config.llm.maxOutputTokens,
        thinking: config.llm.openai?.thinking,
        temperature: config.llm.openai?.temperature,
        topP: config.llm.openai?.topP,
      })
      break
    default:
      throw new Error(`unsupported provider: ${config.llm.provider}`)
  }

  const model = config.llm.model

  // shared agent options from config (spread into each runAgentTurn call)
  const agentLlmConfig = {
    model,
    maxToolResultChars: config.llm.maxToolResultChars,
    maxToolResultTokens: config.llm.maxToolResultTokens,
  }

  const pluginManager = new PluginManager()

  // prepare server context for plugins (will be populated with routeOutput/requestStop after they're defined)
  const serverContext = { routeOutput: null as any, requestStop: null as any, config }

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

  // directly abort a session by output target (bypasses the plugin message queue)
  async function requestStop(outputTarget: string): Promise<boolean> {
    const route = outputTarget
    const conversationSessionId = await sessionManager.getSessionForMessage(route)

    if (!sessionBusy.get(conversationSessionId)) {
      return false // nothing to stop
    }

    console.log(`[server] requestStop for session ${conversationSessionId} (output target: ${outputTarget})`)
    sessionAbort.set(conversationSessionId, true)

    const controller = sessionAbortControllers.get(conversationSessionId)
    if (controller) {
      controller.abort()
    }

    await routeOutput(outputTarget, { type: 'text', text: 'stopped ✋' })
    await routeOutput(outputTarget, { type: 'text_block_end' })
    return true
  }

  // populate routeOutput and requestStop in server context now that they're defined
  serverContext.routeOutput = routeOutput
  serverContext.requestStop = requestStop

  // create session manager with routeOutput available
  const sessionManager = createSessionManager(provider, config, routeOutput, pluginManager, buildSystemPrompt)

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
          const resumeCheckQueued = () => {
            const buffer = messageQueues.get(sessionId) || []
            messageQueues.set(sessionId, [])
            // send dequeued notifications for each message being consumed
            for (const queued of buffer) {
              if (queued.outputTarget && queued.metadata) {
                routeOutput(queued.outputTarget, { type: 'dequeued', metadata: queued.metadata })
                  .catch(() => {})
              }
            }
            return buffer
          }
          const resumeCheckAbort = () => {
            return sessionAbort.get(sessionId) || false
          }

          const resumeAbortController = new AbortController()
          sessionAbortControllers.set(sessionId, resumeAbortController)

          await runAgentTurn([{ type: 'text', text: 'server restarted successfully. continuing from where you left off.' }], {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId,
            workingDir: getWorkspaceDir(),
            onChunk: resumeOnChunk,
            checkQueuedMessages: resumeCheckQueued,
            checkAbort: resumeCheckAbort,
            abortSignal: resumeAbortController.signal,
            outputTarget: lastOutputTarget || undefined,
            ...agentLlmConfig,
          })

          // drain remaining queued messages as new turns
          while (!resumeCheckAbort()) {
            const remaining = resumeCheckQueued()
            if (remaining.length === 0) {
              sessionBusy.set(sessionId, false)
              // re-check after releasing lock to avoid TOCTOU race
              if (messageQueues.get(sessionId)?.length) {
                sessionBusy.set(sessionId, true)
                continue
              }
              break
            }
            console.log(`[server] draining ${remaining.length} queued message(s) as new turn`)
            const queuedContent: ContentBlock[] = remaining.flatMap(r => r.content)

            const drainController = new AbortController()
            sessionAbortControllers.set(sessionId, drainController)

            await runAgentTurn(queuedContent, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId,
              workingDir: getWorkspaceDir(),
              onChunk: resumeOnChunk,
              checkQueuedMessages: resumeCheckQueued,
              checkAbort: resumeCheckAbort,
              abortSignal: drainController.signal,
              outputTarget: lastOutputTarget || undefined,
              ...agentLlmConfig,
            })
          }

          await sessionManager.checkCompaction(sessionId, resumeRoute)
        } catch (err) {
          console.error(`[server] auto-continue error:`, err)
          broadcast(sessionId, { type: 'error', message: String(err) })
          await outputFn({ type: 'error', message: String(err) })
        } finally {
          sessionBusy.set(sessionId, false)
          sessionAbortControllers.delete(sessionId)
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

  // per-session processing: runs agent turns and drains queued messages
  // keyed by sessionId to prevent concurrent processing of the same session
  const sessionProcessing = new Map<string, Promise<void>>()

  async function processSession(
    conversationSessionId: string,
    initialContent: ContentBlock[],
    effectiveOutputTarget: string | null,
    route: string,
    pluginName: string,
  ) {
    const outputFn: ((message: ServerMessage) => Promise<void>) | null =
      effectiveOutputTarget ? (message) => routeOutput(effectiveOutputTarget, message) : null

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
      const agentCheckQueued = () => {
        const buffer = messageQueues.get(conversationSessionId) || []
        messageQueues.set(conversationSessionId, [])
        // send dequeued notifications for each message being consumed
        for (const queued of buffer) {
          if (queued.outputTarget && queued.metadata) {
            routeOutput(queued.outputTarget, { type: 'dequeued', metadata: queued.metadata })
              .catch(() => {})
          }
        }
        return buffer
      }
      const agentCheckAbort = () => {
        return sessionAbort.get(conversationSessionId) || false
      }

      // create abort controller for this turn (allows /stop to cancel in-progress ops)
      const abortController = new AbortController()
      sessionAbortControllers.set(conversationSessionId, abortController)

      await runAgentTurn(initialContent, {
        provider,
        system: buildSystemPrompt,
        tools: getTools,
        sessionId: conversationSessionId,
        workingDir: getWorkspaceDir(),
        onChunk: agentOnChunk,
        checkQueuedMessages: agentCheckQueued,
        checkAbort: agentCheckAbort,
        abortSignal: abortController.signal,
        outputTarget: effectiveOutputTarget || undefined,
        ...agentLlmConfig,
      })

      // drain any remaining queued messages that arrived during a no-tool-use response
      // (checkQueuedMessages only runs after tool calls, so these would be stranded)
      while (!agentCheckAbort()) {
        const remaining = agentCheckQueued()
        if (remaining.length === 0) {
          sessionBusy.set(conversationSessionId, false)
          // re-check after releasing lock to avoid TOCTOU race
          if (messageQueues.get(conversationSessionId)?.length) {
            sessionBusy.set(conversationSessionId, true)
            continue
          }
          break
        }
        console.log(`[${pluginName}] draining ${remaining.length} queued message(s) as new turn`)
        const queuedContent: ContentBlock[] = remaining.flatMap(r => r.content)

        // fresh controller for drain turns
        const drainController = new AbortController()
        sessionAbortControllers.set(conversationSessionId, drainController)

        await runAgentTurn(queuedContent, {
          provider,
          system: buildSystemPrompt,
          tools: getTools,
          sessionId: conversationSessionId,
          workingDir: getWorkspaceDir(),
          onChunk: agentOnChunk,
          checkQueuedMessages: agentCheckQueued,
          checkAbort: agentCheckAbort,
          abortSignal: drainController.signal,
          outputTarget: effectiveOutputTarget || undefined,
          ...agentLlmConfig,
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
      sessionAbortControllers.delete(conversationSessionId)
      sessionProcessing.delete(conversationSessionId)
    }
  }

  // start consuming inputs from all loaded plugins
  // the consumer loop never blocks on agent turns — it only routes messages
  // to the server's messageQueues, where checkQueuedMessages picks them up
  for (const [name, loaded] of pluginManager.getAllPlugins()) {
    if (!loaded.plugin.input) continue

    console.log(`[server] starting input consumer for plugin: ${name}`)
    ;(async () => {
      try {
        console.log(`[server] entering input loop for plugin: ${name}`)
        for await (const queuedMsg of loaded.plugin.input!) {
          const { message, outputTarget, metadata } = queuedMsg as any
          // route = outputTarget (e.g. "discord:1466679760976609393")
          // this ensures each channel/DM/source gets its own session
          const route = outputTarget || name
          const conversationSessionId = await sessionManager.getSessionForMessage(route)

          // handle stop request
          if ((queuedMsg as any).stopRequested) {
            console.log(`[${name}] stop requested for session ${conversationSessionId}`)
            sessionAbort.set(conversationSessionId, true)

            // abort in-progress operations (LLM stream, tool execution)
            const controller = sessionAbortControllers.get(conversationSessionId)
            if (controller) {
              controller.abort()
            }

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

          const effectiveOutputTarget = outputTarget || null

          // check if session is busy (agent is currently processing)
          if (sessionBusy.get(conversationSessionId)) {
            // queue this message for delivery before the next LLM call
            // (checkQueuedMessages in agent.ts picks these up after tool rounds)
            console.log(`[${name}] session ${conversationSessionId} busy, queuing message`)
            if (!messageQueues.has(conversationSessionId)) {
              messageQueues.set(conversationSessionId, [])
            }
            messageQueues.get(conversationSessionId)!.push({
              content,
              outputTarget: effectiveOutputTarget || '',
              metadata,
            })

            // notify the sender that their message has been queued
            if (effectiveOutputTarget) {
              routeOutput(effectiveOutputTarget, { type: 'queued', metadata })
                .catch(() => {}) // best-effort notification
            }
            continue
          }

          // mark session as busy and kick off processing without blocking the consumer
          sessionBusy.set(conversationSessionId, true)
          sessionAbort.set(conversationSessionId, false)

          const processing = processSession(conversationSessionId, content, effectiveOutputTarget, route, name)
          sessionProcessing.set(conversationSessionId, processing)
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
    parts.push(`Current time: ${formatLocalTime(new Date())} (${getTimezone()})`)
    parts.push(`Current working directory: ${getWorkspaceDir()}`)

    // then plugin instructions (tool descriptions)
    const pluginSection = pluginManager.getSystemPromptSection()
    if (pluginSection) {
      parts.push(`# Enabled plugins\n\n${pluginSection}`)
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
          console.log(`[websocket] session ${wsSessionId} busy, queuing message`)
          if (!messageQueues.has(wsSessionId)) {
            messageQueues.set(wsSessionId, [])
          }
          messageQueues.get(wsSessionId)!.push({
            content: [{ type: 'text', text: msg.content }],
            outputTarget: '',
          })
          // notify via websocket broadcast
          broadcast(wsSessionId, { type: 'queued' })
          break
        }

        // mark session as busy and clear any previous abort flag
        sessionBusy.set(wsSessionId, true)
        sessionAbort.set(wsSessionId, false)

        // clear output target for websocket messages (no auto-resume needed)
        await setLastOutputTarget(null)

        try {
          const wsOnChunk = (chunk: ServerMessage) => broadcast(wsSessionId, chunk)
          const wsCheckQueued = () => {
            const buffer = messageQueues.get(wsSessionId) || []
            messageQueues.set(wsSessionId, [])
            return buffer
          }
          const wsCheckAbort = () => {
            return sessionAbort.get(wsSessionId) || false
          }

          const wsAbortController = new AbortController()
          sessionAbortControllers.set(wsSessionId, wsAbortController)

          await runAgentTurn([{ type: 'text', text: msg.content }], {
            provider,
            system: buildSystemPrompt,
            tools: getTools,
            sessionId: wsSessionId,
            workingDir: getWorkspaceDir(),
            onChunk: wsOnChunk,
            checkQueuedMessages: wsCheckQueued,
            checkAbort: wsCheckAbort,
            abortSignal: wsAbortController.signal,
            ...agentLlmConfig,
          })

          // drain remaining queued messages as new turns
          while (!wsCheckAbort()) {
            const remaining = wsCheckQueued()
            if (remaining.length === 0) {
              sessionBusy.set(wsSessionId, false)
              // re-check after releasing lock to avoid TOCTOU race
              if (messageQueues.get(wsSessionId)?.length) {
                sessionBusy.set(wsSessionId, true)
                continue
              }
              break
            }
            console.log(`[websocket] draining ${remaining.length} queued message(s) as new turn`)
            const queuedContent: ContentBlock[] = remaining.flatMap(r => r.content)

            const drainController = new AbortController()
            sessionAbortControllers.set(wsSessionId, drainController)

            await runAgentTurn(queuedContent, {
              provider,
              system: buildSystemPrompt,
              tools: getTools,
              sessionId: wsSessionId,
              workingDir: getWorkspaceDir(),
              onChunk: wsOnChunk,
              checkQueuedMessages: wsCheckQueued,
              checkAbort: wsCheckAbort,
              abortSignal: drainController.signal,
              ...agentLlmConfig,
            })
          }

          await sessionManager.checkCompaction(wsSessionId, wsRoute)
        } catch (err) {
          console.error('agent error:', err)
          broadcast(wsSessionId, { type: 'error', message: String(err) })
        } finally {
          sessionBusy.set(wsSessionId, false)
          sessionAbort.set(wsSessionId, false)
          sessionAbortControllers.delete(wsSessionId)
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

      // debug endpoint: GET /debug/tools (grouped by plugin)
      if (url.pathname === '/debug/tools') {
        const grouped: Record<string, { name: string; description: string; input_schema: Record<string, unknown> }[]> = {}
        for (const [pluginName, loaded] of pluginManager.getAllPlugins()) {
          if (loaded.plugin.tools?.length) {
            grouped[pluginName] = loaded.plugin.tools.map(t => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            }))
          }
        }
        return new Response(JSON.stringify(grouped, null, 2), {
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
