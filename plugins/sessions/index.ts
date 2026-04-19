import type { Plugin, PluginStatus } from '../../server/plugin.ts'
import type { Tool, ToolResult, ToolContext, Message, ServerMessage } from '../../server/types.ts'
import { listSessions, getActiveRoutes, getCurrentSessionId, appendMessage, loadSession } from '../../server/session.ts'
import { join } from 'path'
import { homedir } from 'os'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')

interface SpawnedSession {
  spawnId: string
  callerSessionId: string
  callerOutputTarget?: string
  route: string
  prompt: string
  startedAt: string
}

interface QueuedInput {
  message: Message
  outputTarget?: string
  route?: string
  triggerNotice?: string
}

export default function create(_serverContext: any): Plugin {
  // message queue for plugin input generator (same pattern as bash/timers)
  const inputQueue: QueuedInput[] = []
  let resolveWaiter: (() => void) | null = null

  // spawned sessions awaiting completion
  const spawnedSessions = new Map<string, SpawnedSession>()

  function queueInput(msg: QueuedInput) {
    inputQueue.push(msg)
    if (resolveWaiter) {
      resolveWaiter()
      resolveWaiter = null
    }
  }

  async function* inputGenerator(): AsyncGenerator<QueuedInput> {
    while (true) {
      while (inputQueue.length > 0) {
        yield inputQueue.shift()!
      }
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
    }
  }

  // infer route from session ID filename: "discord-channel-123-2026-04-01-0003" -> "discord-channel-123"
  // route prefix is everything before the date portion (YYYY-MM-DD-NNNN)
  function inferRouteFromSessionId(sessionId: string): string | null {
    const match = sessionId.match(/^(.+)-\d{4}-\d{2}-\d{2}-\d{4}$/)
    return match?.[1] ?? null
  }

  const tools: Tool[] = [
    {
      name: 'list_sessions',
      description: 'List active sessions sorted by recent activity. Shows session ID, route, JSONL file path, and last activity time. Use this to discover sessions you can communicate with.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max number of sessions to return (default: 10)',
          },
        },
      },
      async execute(input: any, context: ToolContext): Promise<ToolResult> {
        const limit = input.limit ?? 10
        const sessions = await listSessions()
        const activeRoutes = getActiveRoutes()

        // build reverse map: sessionId -> route
        const sessionToRoute = new Map<string, string>()
        for (const [route, sessionId] of activeRoutes) {
          sessionToRoute.set(sessionId, route)
        }

        const results = sessions.slice(0, limit).map(s => {
          const route = sessionToRoute.get(s.id) || inferRouteFromSessionId(s.id) || null
          const isCurrent = route !== null && sessionToRoute.get(s.id) === route
          return {
            sessionId: s.id,
            route,
            filePath: join(SESSIONS_DIR, `${s.id}.jsonl`),
            lastActiveAt: s.lastActiveAt.toISOString(),
            createdAt: s.createdAt.toISOString(),
            isCurrentForRoute: isCurrent,
            isCallerSession: s.id === context.sessionId,
          }
        })

        return {
          content: JSON.stringify(results, null, 2),
        }
      },
    },

    {
      name: 'send_message',
      description: `Send a message to another session by route. By default, this wakes/continues the target session (triggers an agent turn). With silent=true, the message is appended to the session's JSONL without triggering a turn — useful for leaving notes or context for the next time that session runs.`,
      inputSchema: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description: 'Target session route (e.g., "discord:channel-123", "ws"). Use list_sessions to discover routes.',
          },
          message: {
            type: 'string',
            description: 'The message text to send.',
          },
          silent: {
            type: 'boolean',
            description: 'If true, append the message to the session without triggering an agent turn. Default: false.',
          },
        },
        required: ['route', 'message'],
      },
      async execute(input: any, context: ToolContext): Promise<ToolResult> {
        const { route, message, silent } = input

        if (!route || !message) {
          return { content: 'route and message are required', is_error: true }
        }

        if (silent) {
          // append directly to the session JSONL without triggering an agent turn
          const sessionId = await getCurrentSessionId(route)
          await appendMessage(sessionId, {
            role: 'user',
            content: [{ type: 'text', text: `[from session ${context.sessionId}]\n${message}` }],
          })
          return { content: `silently appended message to session ${sessionId} (route: ${route})` }
        }

        // queue through input generator — server will route to the right session and trigger an agent turn
        queueInput({
          message: {
            role: 'user',
            content: [{ type: 'text', text: `[from session ${context.sessionId}]\n${message}` }],
          },
          route,
          triggerNotice: `Message from session ${context.sessionId}`,
        })

        const sessionId = await getCurrentSessionId(route)
        return { content: `message sent to session ${sessionId} (route: ${route}). the target session will process it.` }
      },
    },

    {
      name: 'spawn_session',
      description: `Spawn a new session with an initial prompt. Creates a fresh session on a unique route, sends the prompt, and returns immediately with a spawn ID. When the spawned session completes its agent turn, a notification is sent back to your session. This is essentially a subagent pattern.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The initial prompt for the spawned session.',
          },
          route_prefix: {
            type: 'string',
            description: 'Optional prefix for the spawn route (default: "subagent"). The full route will be "{prefix}-{id}".',
          },
        },
        required: ['prompt'],
      },
      async execute(input: any, context: ToolContext): Promise<ToolResult> {
        const { prompt, route_prefix } = input
        if (!prompt) {
          return { content: 'prompt is required', is_error: true }
        }

        const prefix = route_prefix || 'subagent'
        const spawnId = crypto.randomUUID().slice(0, 8)
        const route = `${prefix}-${spawnId}`

        const spawn: SpawnedSession = {
          spawnId,
          callerSessionId: context.sessionId,
          callerOutputTarget: context.outputTarget,
          route,
          prompt,
          startedAt: new Date().toISOString(),
        }
        spawnedSessions.set(spawnId, spawn)

        // yield through input generator with outputTarget pointing back to this plugin
        // so we receive the 'done' event in our output() handler
        queueInput({
          message: {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
          route,
          outputTarget: `sessions:${spawnId}`,
          triggerNotice: `Spawned by session ${context.sessionId}`,
        })

        return {
          content: JSON.stringify({
            spawnId,
            route,
            message: `session spawned on route "${route}". you will receive a notification when it completes.`,
          }),
        }
      },
    },
  ]

  return {
    name: 'sessions',
    description: 'Inter-session communication. Use list_sessions to discover sessions, send_message to communicate with them, and spawn_session to create subagent sessions.',

    tools,

    input: inputGenerator(),

    // output handler: receives ServerMessage events for spawned sessions
    // (because we set outputTarget to "sessions:{spawnId}")
    async output(target: string, message: ServerMessage) {
      if (message.type === 'done') {
        const spawn = spawnedSessions.get(target)
        if (!spawn) return

        // spawned session completed its turn — notify the caller
        spawnedSessions.delete(target)

        // read the spawned session's last assistant message for a summary
        const sessionId = await getCurrentSessionId(spawn.route)
        const messages = await loadSession(sessionId)
        const lastAssistant = messages.filter(m => m.role === 'assistant').pop()

        let summary = '(no response)'
        if (lastAssistant) {
          const textBlocks = lastAssistant.content.filter(b => b.type === 'text')
          summary = textBlocks.map(b => (b as any).text).join('\n')
          // truncate if very long
          if (summary.length > 2000) {
            summary = summary.slice(0, 2000) + '\n... (truncated)'
          }
        }

        const notification = `[spawn_session completed]\nSpawn ID: ${spawn.spawnId}\nRoute: ${spawn.route}\nSession: ${sessionId}\n\nResponse:\n${summary}`

        // find the caller's route from the active routes map
        const activeRoutes = getActiveRoutes()
        let callerRoute: string | null = null
        for (const [route, sid] of activeRoutes) {
          if (sid === spawn.callerSessionId) {
            callerRoute = route
            break
          }
        }

        // queue a notification back to the caller's session
        queueInput({
          message: {
            role: 'user',
            content: [{ type: 'text', text: notification }],
          },
          route: callerRoute ?? undefined,
          outputTarget: spawn.callerOutputTarget,
          triggerNotice: `Subagent ${spawn.spawnId} completed`,
        })
      }
    },

    status(): PluginStatus | null {
      if (spawnedSessions.size === 0) return null
      const tasks = [...spawnedSessions.values()].map(s => ({
        id: s.spawnId,
        description: `subagent on route ${s.route}`,
        startedAt: s.startedAt,
        callerSession: s.callerSessionId,
      }))
      return { tasks }
    },
  }
}
