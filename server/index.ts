import type { ServerWebSocket } from 'bun'
import type { ClientMessage, Tool, ContentBlock } from './types.ts'
import { PluginManager } from './plugin.ts'
import { loadConfig, saveConfig } from './config.ts'
import { ensureDataDirs, loadSession, loadSessionEntries, getSoulPath, listSessions, getWorkspaceDir, getDataDir, setLastOutputTarget, getLastOutputTarget, getCurrentSessionId, getActiveRoutes, sessionEvents, getActiveTurns, setActiveTurn, routeFromSessionId, type ActiveTurnState } from './session.ts'
import { runAgentTurn } from './agent.ts'
import { createSessionManager } from './session-manager.ts'
import { AnthropicProvider, getModelPricing as anthropicPricing } from '../llm-providers/anthropic.ts'
import { MoonshotProvider, getModelPricing as moonshotPricing } from '../llm-providers/moonshot.ts'
import { ChatGPTCodexProvider } from '../llm-providers/chatgpt-codex.ts'
import type { LlmProvider } from './llm-provider.ts'
import { registerPricingProvider } from './cost.ts'
import { shouldAutoResume, getInterruptedTurnResumeContent } from './auto-resume.ts'
import { runCompactWithInterrupt } from './compact-interrupt.ts'
import { migrateQueuedMessages, type QueuedMessage } from './queue-migration.ts'

// register provider pricing lookups
registerPricingProvider(anthropicPricing)
registerPricingProvider(moonshotPricing)
import { setTimezone, formatLocalTime, getTimezone } from './time.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'os'
import { join } from 'path'
import { acquirePidfile, releasePidfile } from './pidfile.ts'

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

const LEARN_PROMPT_PATH = join(homedir(), '.toebeans', 'prompts', 'learn.md')
const DEFAULT_LEARN_PROMPT = `Summarize this conversation for your future self, then call session_finalize with the summary. The summary will be the ONLY context available when the conversation continues — nothing else carries over.

Priorities:
- Preserve the overall conversation flow: what the user asked for, what you decided, and what happened.
- Tool call outputs can generally be summarized briefly — focus on conclusions and outcomes, not raw output.
- Keep more detail for recent exchanges; older parts can be condensed more aggressively.
- Retain any details needed to continue the current thread of work: pending tasks, next steps, open questions, relevant IDs/names/paths/technical specifics.
- Include key decisions and their rationale, completed work, and anything you'd need to avoid repeating yourself.

After writing your summary, call session_finalize with it.`

async function loadLearnPrompt(): Promise<string> {
  const file = Bun.file(LEARN_PROMPT_PATH)
  if (await file.exists()) {
    return await file.text()
  }
  return DEFAULT_LEARN_PROMPT
}

interface WebSocketData {
  subscriptions: Set<string>
}

// track connections by session
const sessionSubscribers = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

// track pending queued messages per session (messages sent while agent is busy
// or while a learn/compact turn is in flight — queued messages are drained
// before the next LLM call or migrated to the successor session on finalize)
const messageQueues = new Map<string, QueuedMessage[]>()
const sessionBusy = new Map<string, boolean>()
const sessionAbort = new Map<string, boolean>()
const sessionAbortControllers = new Map<string, AbortController>()

// learn-turn failure tracking, keyed by session id.
// learnFailureCounts: consecutive learn turns that ended without calling
//   session_finalize. Reset to 0 on a successful finalize.
// learnStuck: session has hit MAX_LEARN_FAILURES. Auto-compaction is disabled
//   and automatic messages (timers, coding-agent notifications, etc) are dropped.
//   Manual user messages still flow through so the user can intervene.
const MAX_LEARN_FAILURES = 3
const learnFailureCounts = new Map<string, number>()
const learnStuck = new Set<string>()

// sessions currently being compacted via /compact (or any explicit interrupt+compact).
// while a session is in this set, the plugin input loop and processSession's
// stranded-restart branch must queue new messages instead of kicking off a fresh
// processSession — otherwise we'd race with the learn turn we just triggered.
const compactPending = new Set<string>()

async function main() {
  console.log('toebeans server starting...')

  await ensureDataDirs()

  // single-instance guard: exit if another live server holds the pidfile
  if (!await acquirePidfile()) {
    console.error('[server] another toebeans server instance is already running. exiting.')
    process.exit(1)
  }
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
    case 'moonshot':
    case 'openai-compatible': {
      // top-level fields preferred; fall back to nested moonshot/openai blocks
      const legacy = config.llm.moonshot ?? config.llm.openai
      provider = new MoonshotProvider({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl ?? legacy?.baseUrl,
        model: config.llm.model,
        maxOutputTokens: config.llm.maxOutputTokens,
        thinking: config.llm.thinking ?? legacy?.thinking,
        temperature: config.llm.temperature ?? legacy?.temperature,
        topP: config.llm.topP ?? legacy?.topP,
      })
      break
    }
    case 'chatgpt-codex':
      provider = new ChatGPTCodexProvider({
        model: config.llm.model,
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

  // prepare server context for plugins (will be populated with routeOutput/requestStop/sessionManager after they're defined)
  const serverContext: Record<string, any> = { routeOutput: null, requestStop: null, config, pluginManager }

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

  // map route → outputTarget so requestStop can send replies when called with a route
  const routeToOutputTarget = new Map<string, string>()

  // directly abort a session by route (or legacy outputTarget)
  async function requestStop(route: string): Promise<boolean> {
    const conversationSessionId = await sessionManager.getSessionForMessage(route)

    if (!sessionBusy.get(conversationSessionId)) {
      return false // nothing to stop
    }

    console.log(`[server] requestStop for session ${conversationSessionId} (route: ${route})`)
    sessionAbort.set(conversationSessionId, true)

    const controller = sessionAbortControllers.get(conversationSessionId)
    if (controller) {
      controller.abort()
    }

    // reply via the outputTarget (which may differ from the route)
    const replyTarget = routeToOutputTarget.get(route) || route
    await routeOutput(replyTarget, { type: 'text', text: 'stopped ✋' })
    await routeOutput(replyTarget, { type: 'text_block_end' })
    return true
  }

  // populate routeOutput and requestStop in server context now that they're defined
  serverContext.routeOutput = routeOutput
  serverContext.requestStop = requestStop

  // create session manager with routeOutput available
  const resolveOutputTarget = (route: string) => routeToOutputTarget.get(route) || route
  const sessionManager = createSessionManager(provider, config, routeOutput, pluginManager, buildSystemPrompt, resolveOutputTarget)

  // expose session manager on server context so core plugins (session) can access it
  serverContext.sessionManager = sessionManager

  // expose requestCompact so plugins can trigger learn/finalize on demand.
  // if a turn is mid-flight for that session we abort it, wait for it to
  // settle, run the learn turn, then resume the interrupted turn on the
  // successor session using the same semantics as restart recovery.
  serverContext.requestCompact = async (route: string): Promise<string | null> => {
    const sessionId = await sessionManager.getSessionForMessage(route)
    const outputTarget = resolveOutputTarget(route)
    return runCompactWithInterrupt(sessionId, route, outputTarget, {
      sessionBusy,
      sessionAbort,
      sessionAbortControllers,
      sessionProcessing,
      messageQueues,
      compactPending,
      getActiveTurns,
      runLearnTurn,
      startRecoveredSession,
      restartMessage: config.restartMessage,
    })
  }

  // always load the core session plugin (provides session_finalize)
  try {
    await pluginManager.loadPlugin('session')
    console.log('loaded core plugin: session')
  } catch (err) {
    console.error('failed to load core session plugin:', err)
  }

  // load plugins from config
  for (const [name, pluginConfig] of Object.entries(config.plugins)) {
    if (name === 'session') continue // already loaded as core plugin
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

  // per-session processing: runs agent turns and drains queued messages
  // keyed by sessionId to prevent concurrent processing of the same session
  const sessionProcessing = new Map<string, Promise<void>>()

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

  // run a learn/finalize turn on the given session. the agent summarizes
  // the conversation and calls session_finalize to roll over to a successor.
  // returns the new session ID if finalization succeeded, null otherwise.
  // cost stays on the old session since the learn turn runs there.
  async function runLearnTurn(
    sessionId: string,
    route: string,
    effectiveOutputTarget: string | null,
  ): Promise<string | null> {
    const sessionPlugin = pluginManager.getPlugin('session')
    if (!sessionPlugin) {
      console.error('[server] session plugin not loaded, cannot run learn turn')
      return null
    }

    const plugin = sessionPlugin.plugin as any
    plugin.prepareFinalizeSession(sessionId, route)

    try {
      const learnPrompt = await loadLearnPrompt()
      console.log(`[server] running learn turn on session ${sessionId} (route: ${route})`)

      const outputFn: ((message: ServerMessage) => Promise<void>) | null =
        effectiveOutputTarget ? (message) => routeOutput(effectiveOutputTarget, message) : null

      await runAgentTurn(
        [{ type: 'text', text: learnPrompt }],
        {
          provider,
          system: buildSystemPrompt,
          tools: getTools,
          sessionId,
          workingDir: getWorkspaceDir(),
          onChunk: async (chunk: ServerMessage) => {
            broadcast(sessionId, chunk)
            if (outputFn) await outputFn(chunk)
          },
          outputTarget: effectiveOutputTarget || undefined,
          ...agentLlmConfig,
        },
      )

      // check if finalization succeeded (route now points to a different session)
      const currentSession = await getCurrentSessionId(route)
      if (currentSession !== sessionId) {
        console.log(`[server] learn turn finalized: ${sessionId} → ${currentSession}`)
        // success - clear failure tracking for the old session
        learnFailureCounts.delete(sessionId)
        learnStuck.delete(sessionId)
        return currentSession
      }

      const failures = (learnFailureCounts.get(sessionId) || 0) + 1
      learnFailureCounts.set(sessionId, failures)
      console.log(`[server] learn turn completed without calling session_finalize, leaving session in place (failure ${failures}/${MAX_LEARN_FAILURES})`)
      if (failures >= MAX_LEARN_FAILURES && !learnStuck.has(sessionId)) {
        learnStuck.add(sessionId)
        console.log(`[server] session ${sessionId} marked learn-stuck after ${failures} failed learn turns; suppressing auto-compaction and automatic messages until a manual finalize`)
        if (effectiveOutputTarget) {
          routeOutput(effectiveOutputTarget, {
            type: 'text',
            text: `\`\`\`\n⚠️ session ${sessionId} stuck after ${failures} failed learn turns. auto-compaction disabled, automatic messages (timers, coding-agent notifications) will be dropped. send a manual message to finalize.\n\`\`\``,
          }).then(() => routeOutput(effectiveOutputTarget, { type: 'text_block_end' }))
            .catch(err => console.error('[server] failed to send learn-stuck notice:', err))
        }
      }
      return null
    } catch (err) {
      console.error(`[server] learn turn failed for session ${sessionId}:`, err)
      const failures = (learnFailureCounts.get(sessionId) || 0) + 1
      learnFailureCounts.set(sessionId, failures)
      if (failures >= MAX_LEARN_FAILURES) learnStuck.add(sessionId)
      return null
    } finally {
      // clean up pending finalization if it wasn't consumed
      plugin.clearPendingFinalization(sessionId)
    }
  }

  async function processSession(
    initialSessionId: string,
    initialContent: ContentBlock[],
    effectiveOutputTarget: string | null,
    route: string,
    pluginName: string,
  ) {
    let conversationSessionId = initialSessionId

    const outputFn: ((message: ServerMessage) => Promise<void>) | null =
      effectiveOutputTarget ? (message) => routeOutput(effectiveOutputTarget, message) : null

    // track output target + route for auto-resume after restart
    if (effectiveOutputTarget) {
      await setLastOutputTarget(effectiveOutputTarget, route)
    }

    // pre-turn: if session is stale or over threshold, run learn turn first
    if (!learnStuck.has(conversationSessionId) && await sessionManager.needsCompaction(conversationSessionId, route)) {
      const newId = await runLearnTurn(conversationSessionId, route, effectiveOutputTarget)
      if (newId) {
        // Migrate any messages queued while the learn turn ran onto the
        // successor so they're delivered on the new session (drained by the
        // agent loop's checkQueuedMessages after the initial turn).
        migrateQueuedMessages(conversationSessionId, newId, messageQueues)
        sessionBusy.delete(conversationSessionId)
        sessionAbort.delete(conversationSessionId)
        sessionAbortControllers.delete(conversationSessionId)
        sessionProcessing.delete(conversationSessionId)
        conversationSessionId = newId
        sessionBusy.set(conversationSessionId, true)
        sessionAbort.set(conversationSessionId, false)
      }
      // if learn turn failed, continue on old session; messages queued during
      // the learn attempt stay on messageQueues[oldId] and will be drained by
      // the upcoming agent turn's checkQueuedMessages.
    }

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

    async function runPersistentAgentTurn(turnContent: ContentBlock[]): Promise<void> {
      let activeTurn: ActiveTurnState = {
        sessionId: conversationSessionId,
        route,
        outputTarget: effectiveOutputTarget,
        pluginName,
        startedAt: new Date().toISOString(),
        initialContent: turnContent,
        userMessagePersisted: false,
      }
      await setActiveTurn(activeTurn)
      try {
        const abortController = new AbortController()
        sessionAbortControllers.set(conversationSessionId, abortController)

        await runAgentTurn(turnContent, {
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
          route,
          onUserMessagePersisted: async () => {
            if (!activeTurn.userMessagePersisted) {
              activeTurn = { ...activeTurn, userMessagePersisted: true }
              await setActiveTurn(activeTurn)
            }
          },
          ...agentLlmConfig,
        })
      } finally {
        await setActiveTurn(null, conversationSessionId)
      }
    }

    let compacted = false
    try {

      await runPersistentAgentTurn(initialContent)

      // drain any remaining queued messages that arrived during a no-tool-use response
      // (checkQueuedMessages only runs after tool calls, so these would be stranded)
      while (!agentCheckAbort()) {
        const remaining = agentCheckQueued()
        if (remaining.length === 0) break
        console.log(`[${pluginName}] draining ${remaining.length} queued message(s) as new turn`)
        const queuedContent: ContentBlock[] = remaining.flatMap(r => r.content)

        await runPersistentAgentTurn(queuedContent)
      }

      // post-turn: check if session needs compaction, run learn turn if so.
      // session stays busy during learn turn to prevent concurrent processSession calls.
      if (!learnStuck.has(conversationSessionId) && await sessionManager.needsCompaction(conversationSessionId, route)) {
        const newSessionId = await runLearnTurn(conversationSessionId, route, effectiveOutputTarget)

        if (newSessionId) {
          // learn turn finalized — migrate queued messages that arrived during it
          console.log(`[${pluginName}] session finalized: ${conversationSessionId} → ${newSessionId}`)
          const queued = messageQueues.get(conversationSessionId) || []
          messageQueues.delete(conversationSessionId)
          sessionAbort.delete(conversationSessionId)
          sessionAbortControllers.delete(conversationSessionId)
          sessionProcessing.delete(conversationSessionId)
          sessionBusy.delete(conversationSessionId)

          if (queued.length > 0) {
            console.log(`[${pluginName}] migrating ${queued.length} queued message(s) to new session ${newSessionId}`)
            sessionBusy.set(newSessionId, true)
            sessionAbort.set(newSessionId, false)
            const queuedContent: ContentBlock[] = queued.flatMap(r => r.content)
            const processing = processSession(newSessionId, queuedContent, effectiveOutputTarget, route, pluginName)
            sessionProcessing.set(newSessionId, processing)
          }
          compacted = true
        }
        // if learn turn failed, leave old session in place (no retry)
      }
    } catch (err) {
      console.error(`agent error for ${conversationSessionId}:`, err)
      broadcast(conversationSessionId, { type: 'error', message: String(err) })

      // send error output
      if (outputFn) {
        await outputFn({ type: 'error', message: String(err) })
      }
    } finally {
      if (!compacted) {
        // mark session as not busy and clear abort flag
        sessionBusy.set(conversationSessionId, false)
        sessionAbort.set(conversationSessionId, false)
        sessionAbortControllers.delete(conversationSessionId)
        sessionProcessing.delete(conversationSessionId)

        // TOCTOU fix: messages may have arrived between the drain loop's empty check
        // and sessionBusy=false (e.g. during the learn turn's async work). If so,
        // kick off a new processSession to handle them — unless a /compact is in
        // flight for this session, in which case the compact-interrupt flow owns
        // the handoff and will migrate queued messages to the successor itself.
        const stranded = messageQueues.get(conversationSessionId)
        if (stranded && stranded.length > 0 && !compactPending.has(conversationSessionId)) {
          messageQueues.set(conversationSessionId, [])
          console.log(`[${pluginName}] ${stranded.length} stranded message(s) found after busy=false, starting new turn`)
          sessionBusy.set(conversationSessionId, true)
          sessionAbort.set(conversationSessionId, false)
          const strandedContent: ContentBlock[] = stranded.flatMap(r => r.content)
          // send dequeued notifications for stranded messages
          for (const queued of stranded) {
            if (queued.outputTarget && queued.metadata) {
              routeOutput(queued.outputTarget, { type: 'dequeued', metadata: queued.metadata })
                .catch(() => {})
            }
          }
          const processing = processSession(conversationSessionId, strandedContent, effectiveOutputTarget, route, pluginName)
          sessionProcessing.set(conversationSessionId, processing)
        }
      }
    }
  }

  async function startRecoveredSession(
    sessionId: string,
    content: ContentBlock[],
    outputTarget: string | null,
    route: string,
    pluginName: string,
  ): Promise<void> {
    sessionBusy.set(sessionId, true)
    sessionAbort.set(sessionId, false)
    const processing = processSession(sessionId, content, outputTarget, route, pluginName)
    sessionProcessing.set(sessionId, processing)
  }

  const interruptedTurns = await getActiveTurns()
  if (interruptedTurns.length > 0) {
    for (const interruptedTurn of interruptedTurns) {
      const resumeContent = getInterruptedTurnResumeContent(interruptedTurn, config.restartMessage)
      console.log(`[server] resuming interrupted turn for session ${interruptedTurn.sessionId} (route: ${interruptedTurn.route})`)
      if (interruptedTurn.outputTarget && interruptedTurn.route !== interruptedTurn.outputTarget) {
        routeToOutputTarget.set(interruptedTurn.route, interruptedTurn.outputTarget)
      }
      await startRecoveredSession(
        interruptedTurn.sessionId,
        resumeContent,
        interruptedTurn.outputTarget,
        interruptedTurn.route,
        interruptedTurn.pluginName || 'auto-resume',
      )
    }
  } else {
    // check if we should auto-continue after restart
    const resumeInfo = await getLastOutputTarget()
    if (resumeInfo) {
      const { outputTarget: lastOutputTarget, route: resumeRoute } = resumeInfo
      console.log(`[server] checking for auto-continue (output target: ${lastOutputTarget}, route: ${resumeRoute})`)
      try {
        const sessionId = await getCurrentSessionId(resumeRoute)
        const messages = await loadSession(sessionId)

        if (shouldAutoResume(messages)) {
          console.log(`[server] auto-continuing session ${sessionId} on output target ${lastOutputTarget}`)
          // clear the restart marker so a successful resume does not loop on future startups
          await setLastOutputTarget(null)
          await startRecoveredSession(
            sessionId,
            [{ type: 'text', text: config.restartMessage }],
            lastOutputTarget,
            resumeRoute,
            'auto-resume',
          )
        } else {
          console.log(`[server] no restart_server tool call found in last assistant message, not auto-continuing`)
          await setLastOutputTarget(null)
        }
      } catch (err) {
        console.error(`[server] error checking for auto-continue:`, err)
        await setLastOutputTarget(null)
      }
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
          const { message, outputTarget, metadata, triggerNotice, automatic } = queuedMsg as any
          // route determines session grouping; plugins can supply a friendly route
          // (e.g. "discord:dm-alice-123") separate from outputTarget ("discord:123")
          const route = (queuedMsg as any).route || outputTarget || name
          // track route→outputTarget so requestStop can reply via the correct target
          if (outputTarget && route !== outputTarget) {
            routeToOutputTarget.set(route, outputTarget)
          }
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

          // drop automatic messages while the session is learn-stuck.
          if (automatic && learnStuck.has(conversationSessionId)) {
            console.log(`[${name}] dropping automatic message for learn-stuck session ${conversationSessionId}`)
            continue
          }

          console.log(`[${name}] message -> session: ${conversationSessionId} (route: ${route})`)

          // send trigger notice to outputTarget before processing
          if (triggerNotice && outputTarget) {
            routeOutput(outputTarget, { type: 'trigger_notice', text: triggerNotice })
              .catch((err) => console.error(`[${name}] failed to send trigger notice:`, err))
          }

          const content = message.content
          if (content.length === 0) continue

          const effectiveOutputTarget = outputTarget || null

          // check if session is busy (agent turn in progress, learn/finalize
          // turn running, or /compact is in the interrupt-and-handoff phase).
          // Messages arriving here are queued — they drain via the agent loop's
          // checkQueuedMessages, or migrate to the successor on finalize.
          if (sessionBusy.get(conversationSessionId) || compactPending.has(conversationSessionId)) {
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

    // then context
    parts.push(`Time session started: ${formatLocalTime(new Date())} (${getTimezone()})`)
    parts.push(`Current working directory: ${getWorkspaceDir()}`)

    // unified plugins section (descriptions + plugin-contributed prompts)
    const pluginsSection = await pluginManager.buildPluginsSection()
    if (pluginsSection) {
      parts.push(pluginsSection)
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
        const processing = processSession(
          wsSessionId,
          [{ type: 'text', text: msg.content }],
          null,
          wsRoute,
          'websocket',
        )
        sessionProcessing.set(wsSessionId, processing)
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

      // status API: aggregated runtime state for the dashboard
      if (url.pathname === '/status') {
        const routes = getActiveRoutes()
        const sessionDetails = await Promise.all(
          Array.from(routes.entries()).map(async ([route, sessionId]) => {
            const busy = sessionBusy.get(sessionId) ?? false
            const queued = messageQueues.get(sessionId)?.length ?? 0
            const subscribers = sessionSubscribers.get(sessionId)?.size ?? 0
            let tokens = 0
            let messageCount = 0
            let lastActivity: string | null = null
            let createdAt: string | null = null
            let cost = 0
            try {
              const info = await sessionManager.getSessionInfo(sessionId)
              tokens = info.estimatedTokens
              messageCount = info.messageCount
              lastActivity = info.lastActivity?.toISOString() ?? null
              createdAt = info.createdAt?.toISOString() ?? null
              const { loadCostEntries } = await import('./session.ts')
              const costEntries = await loadCostEntries(sessionId)
              cost = costEntries.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)
            } catch {}
            return {
              route: route || '(default)',
              sessionId,
              busy,
              queuedMessages: queued,
              wsConnections: subscribers,
              tokens,
              messageCount,
              cost: Math.round(cost * 10000) / 10000,
              lastActivity,
              createdAt,
            }
          })
        )

        const pluginNames = Array.from(pluginManager.getAllPlugins().keys())
        const toolCount = getTools().length

        // collect plugin statuses (coding agent sessions, etc.)
        const pluginStatuses: Record<string, unknown> = {}
        const statuses = await pluginManager.getPluginStatuses()
        for (const [name, s] of statuses) {
          pluginStatuses[name] = s
        }

        const status = {
          uptime: process.uptime(),
          llm: {
            provider: config.llm.provider,
            model: config.llm.model,
            effort: config.llm.effort ?? null,
          },
          session: {
            warnAtTokens: config.session.warnAtTokens,
            compactAtTokens: config.session.compactAtTokens,
            lifespanSeconds: config.session.lifespanSeconds,
          },
          plugins: pluginNames,
          toolCount,
          sessions: sessionDetails,
          pluginStatuses,
        }
        return new Response(JSON.stringify(status), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        })
      }

      // plugin context API: per-plugin system prompt contributions, tools, descriptions
      if (url.pathname === '/status/plugin-context') {
        const contexts = await pluginManager.getPluginContexts()
        return new Response(JSON.stringify(contexts), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        })
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
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
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

      // get full session entries (with timestamps, costs, system prompts)
      const entriesMatch = url.pathname.match(/^\/session\/(.+)\/entries$/)
      if (entriesMatch) {
        const entries = await loadSessionEntries(entriesMatch[1]!)
        return new Response(JSON.stringify(entries), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        })
      }

      // POST /session/:id/message — send a message to a specific session (dashboard chat)
      const msgPostMatch = url.pathname.match(/^\/session\/(.+)\/message$/)
      if (msgPostMatch && req.method === 'POST') {
        const targetSessionId = msgPostMatch[1]!
        try {
          const body = await req.json() as { text: string }
          if (!body.text || typeof body.text !== 'string') {
            return new Response(JSON.stringify({ error: 'text field required' }), {
              status: 400,
              headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            })
          }

          // derive route from active routes map, or parse from session ID
          let route: string | undefined
          for (const [r, sid] of getActiveRoutes()) {
            if (sid === targetSessionId) { route = r; break }
          }
          if (!route) {
            route = routeFromSessionId(targetSessionId) || 'dashboard'
          }

          const content: ContentBlock[] = [{ type: 'text', text: body.text }]

          if (sessionBusy.get(targetSessionId)) {
            if (!messageQueues.has(targetSessionId)) {
              messageQueues.set(targetSessionId, [])
            }
            messageQueues.get(targetSessionId)!.push({ content, outputTarget: '' })
            broadcast(targetSessionId, { type: 'queued' })
            return new Response(JSON.stringify({ status: 'queued' }), {
              headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            })
          }

          sessionBusy.set(targetSessionId, true)
          sessionAbort.set(targetSessionId, false)
          const processing = processSession(targetSessionId, content, null, route, 'dashboard')
          sessionProcessing.set(targetSessionId, processing)

          return new Response(JSON.stringify({ status: 'processing' }), {
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), {
            status: 500,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          })
        }
      }

      // CORS preflight for session message POST
      if (msgPostMatch && req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        })
      }

      // SSE stream for live session entries
      const streamMatch = url.pathname.match(/^\/session\/(.+)\/stream$/)
      if (streamMatch) {
        const sessionId = streamMatch[1]!
        const entries = await loadSessionEntries(sessionId)
        let closed = false

        const stream = new ReadableStream({
          start(controller) {
            // send all existing entries as initial batch
            const initData = JSON.stringify(entries)
            controller.enqueue(`event: init\ndata: ${initData}\n\n`)

            // listen for new entries
            const onEntry = ({ sessionId: sid, entry }: { sessionId: string; entry: unknown }) => {
              if (sid !== sessionId || closed) return
              controller.enqueue(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`)
            }
            sessionEvents.on('entry', onEntry)

            // keepalive every 15s
            const keepalive = setInterval(() => {
              if (closed) return
              controller.enqueue(': keepalive\n\n')
            }, 15000)

            // cleanup on close
            req.signal.addEventListener('abort', () => {
              closed = true
              sessionEvents.off('entry', onEntry)
              clearInterval(keepalive)
              try { controller.close() } catch {}
            })
          },
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'access-control-allow-origin': '*',
          },
        })
      }

      // coding session output: GET /coding-session/:agent/:id/output?tail=N
      const codingMatch = url.pathname.match(/^\/coding-session\/([^/]+)\/([^/]+)\/output$/)
      if (codingMatch) {
        const agent = codingMatch[1]!
        const sessionId = codingMatch[2]!
        const allowedAgents = ['claude-code', 'gemini-cli', 'openai-codex']
        if (!allowedAgents.includes(agent)) {
          return new Response(JSON.stringify({ error: 'unknown agent' }), {
            status: 400,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          })
        }

        const tail = parseInt(url.searchParams.get('tail') ?? '50', 10)
        const logPath = join(getDataDir(), agent, `${sessionId}.log`)
        const metaPath = join(getDataDir(), agent, `${sessionId}.meta.json`)

        try {
          const [logFile, metaFile] = [Bun.file(logPath), Bun.file(metaPath)]
          const meta = await metaFile.exists() ? await metaFile.json() : null

          let lines: string[] = []
          if (await logFile.exists()) {
            const text = await logFile.text()
            const allLines = text.split('\n').filter(l => l.trim())
            lines = tail > 0 ? allLines.slice(-tail) : allLines
          }

          // parse log lines into a readable summary
          const parsed: { type: string; text?: string; tool?: string; status?: string; result?: string; cost?: number; duration_ms?: number }[] = []
          for (const line of lines) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'assistant') {
                const parts: string[] = []
                if (obj.message?.content) {
                  for (const block of obj.message.content) {
                    if (block.type === 'text' && block.text) parts.push(block.text)
                    else if (block.type === 'tool_use') parts.push(`[tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`)
                  }
                }
                if (parts.length > 0) parsed.push({ type: 'assistant', text: parts.join(' ') })
              } else if (obj.type === 'user') {
                const hasResults = obj.message?.content?.some((b: { type: string }) => b.type === 'tool_result')
                parsed.push({ type: 'user', text: hasResults ? '[tool results]' : '[message]' })
              } else if (obj.type === 'result') {
                parsed.push({ type: 'result', result: obj.result, cost: obj.cost, duration_ms: obj.duration_ms })
              } else if (obj.type === 'status') {
                if (obj.status) parsed.push({ type: 'status', status: obj.status })
              }
            } catch {}
          }

          return new Response(JSON.stringify({ meta, output: parsed, lineCount: lines.length }), {
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          })
        } catch (err: unknown) {
          return new Response(JSON.stringify({ error: (err as Error).message }), {
            status: 500,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          })
        }
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

      // config API: read current config + plugin config schemas
      if (url.pathname === '/config' && req.method === 'GET') {
        const pluginSchemas = pluginManager.getPluginConfigSchemas()
        return new Response(JSON.stringify({ config, pluginSchemas }), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        })
      }

      // config API: save updated config
      if (url.pathname === '/config' && req.method === 'POST') {
        try {
          const body = await req.json() as Record<string, unknown>
          // merge into current config
          const updated = { ...config, ...body }
          await saveConfig(updated)
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), {
            status: 400,
            headers: {
              'content-type': 'application/json',
              'access-control-allow-origin': '*',
            },
          })
        }
      }

      // CORS preflight for config POST
      if (url.pathname === '/config' && req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        })
      }

      // dashboard UI — served from the main server, polls /status directly
      if (url.pathname === '/dashboard') {
        const { dashboardHtml } = await import('./dashboard-html')
        return new Response(dashboardHtml('/status', ''), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
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

  // graceful shutdown — clean up plugin processes (TTS, whisper, etc.) on exit
  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[server] received ${signal}, shutting down...`)
    try {
      await pluginManager.destroy()
    } catch (err) {
      console.error('[server] error during plugin cleanup:', err)
    }
    await releasePidfile()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(console.error)
