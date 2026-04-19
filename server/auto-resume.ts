import type { Message, ContentBlock } from './types.ts'
import type { ActiveTurnState } from './session.ts'

/** Tool names that trigger a server restart and should auto-resume on next startup. */
const RESUME_TOOL_NAMES = new Set(['restart_server', 'enable_plugin', 'disable_plugin'])

/** Check if the last assistant message in a session contains a tool call that restarts the server. */
export function shouldAutoResume(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && RESUME_TOOL_NAMES.has(block.name)) {
          return true
        }
      }
      return false // only check the last assistant message
    }
  }
  return false
}

export function getInterruptedTurnResumeContent(activeTurn: ActiveTurnState, restartMessage: string): ContentBlock[] {
  if (activeTurn.userMessagePersisted) {
    return [{ type: 'text', text: restartMessage }]
  }
  return activeTurn.initialContent
}
