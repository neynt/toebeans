import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, ToolContext } from '../../server/types.ts'

interface PendingFinalization {
  sessionId: string
  route?: string
}

export default function create(serverContext: any): Plugin {
  // pending finalizations are tracked per session so concurrent learn turns
  // do not stomp each other's session_finalize authorization.
  const pendingFinalizations = new Map<string, PendingFinalization>()

  const tools: Tool[] = [
    {
      name: 'session_finalize',
      description: `Finalize the current session and roll over to a new one. Call this at the end of a learn/compaction turn with a summary of the conversation. The summary will be the ONLY context carried into the successor session. This tool must only be called during a session finalize turn.`,
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Summary of the conversation to carry into the successor session.',
          },
        },
        required: ['summary'],
      },
      async execute(input: any, context: ToolContext): Promise<ToolResult> {
        const { summary } = input

        if (!summary || typeof summary !== 'string') {
          return { content: 'summary is required and must be a string', is_error: true }
        }

        const pendingFinalization = pendingFinalizations.get(context.sessionId)
        if (!pendingFinalization) {
          return { content: 'session_finalize can only be called during a session finalize turn', is_error: true }
        }

        const { sessionManager } = serverContext
        if (!sessionManager) {
          return { content: 'session manager not available', is_error: true }
        }

        try {
          const newId = await sessionManager.finalizeSession(
            pendingFinalization.sessionId,
            pendingFinalization.route,
            summary,
          )

          pendingFinalizations.delete(context.sessionId)

          return {
            content: JSON.stringify({
              status: 'finalized',
              oldSessionId: context.sessionId,
              newSessionId: newId,
            }),
          }
        } catch (err) {
          return {
            content: `finalization failed: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          }
        }
      },
    },
  ]

  const plugin: Plugin & {
    prepareFinalizeSession: (sessionId: string, route?: string) => void
    clearPendingFinalization: (sessionId?: string) => void
    hasPendingFinalization: (sessionId?: string) => boolean
  } = {
    name: 'session',
    description: 'Session lifecycle management. Provides session_finalize for rolling over sessions during compaction.',

    tools,

    // exposed for the server to set up pending finalization before learn turns
    prepareFinalizeSession(sessionId: string, route?: string) {
      pendingFinalizations.set(sessionId, { sessionId, route })
    },

    clearPendingFinalization(sessionId?: string) {
      if (sessionId) {
        pendingFinalizations.delete(sessionId)
        return
      }
      pendingFinalizations.clear()
    },

    hasPendingFinalization(sessionId?: string) {
      return sessionId ? pendingFinalizations.has(sessionId) : pendingFinalizations.size > 0
    },
  }

  return plugin
}
