import type { LlmProvider } from './llm-provider.ts'
import type { Message, ContentBlock, Tool, ToolContext, StreamChunk, ToolDef, AgentResult, ServerMessage } from './types.ts'
import { loadSession, appendMessage } from './session.ts'

const MAX_TOOL_RESULT_LENGTH = 50000 // ~12k tokens

// repair message history to handle interrupted tool calls
// ensures every tool_use has a matching tool_result
export function repairMessages(messages: Message[]): Message[] {
  const repaired: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    repaired.push(msg)

    // check if this assistant message has tool_use blocks
    if (msg.role === 'assistant') {
      const toolUseIds = msg.content
        .filter(b => b.type === 'tool_use')
        .map(b => (b as { type: 'tool_use'; id: string; name: string; input: unknown }).id)

      if (toolUseIds.length === 0) continue

      // check next message for tool_results
      const nextMsg = messages[i + 1]
      const existingResultIds = new Set<string>()

      if (nextMsg?.role === 'user') {
        for (const block of nextMsg.content) {
          if (block.type === 'tool_result' && 'tool_use_id' in block) {
            existingResultIds.add(block.tool_use_id)
          }
        }
      }

      // find missing tool_results
      const missingIds = toolUseIds.filter(id => !existingResultIds.has(id))

      if (missingIds.length > 0) {
        // insert synthetic tool_result message
        const syntheticResults: ContentBlock[] = missingIds.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: '(interrupted - no result received)',
          is_error: true,
        }))

        // if next message is user with some tool_results, prepend missing ones
        if (nextMsg?.role === 'user' && existingResultIds.size > 0) {
          // merge into existing user message (will be added in next iteration)
          nextMsg.content = [...syntheticResults, ...nextMsg.content]
        } else {
          // insert new user message with synthetic results
          repaired.push({ role: 'user', content: syntheticResults })
        }
      }
    }
  }

  return repaired
}

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_LENGTH) {
    return content
  }
  const half = Math.floor(MAX_TOOL_RESULT_LENGTH / 2)
  const truncatedBytes = content.length - MAX_TOOL_RESULT_LENGTH
  return content.slice(0, half) + `\n\n... [truncated ${truncatedBytes} characters] ...\n\n` + content.slice(-half)
}

export interface AgentOptions {
  provider: LlmProvider
  system: () => string | Promise<string>
  tools: () => Tool[]
  sessionId: string
  workingDir: string
  onChunk?: (chunk: ServerMessage) => void
  checkInterrupts?: () => { text: string; outputTarget: string }[]
}

export async function runAgentTurn(
  userContent: string,
  options: AgentOptions
): Promise<AgentResult> {
  const { provider, system: getSystem, tools: getTools, sessionId, workingDir, onChunk } = options

  // load existing messages and repair any interrupted tool calls
  const messages = repairMessages(await loadSession(sessionId))

  // add user message
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: userContent }],
  }
  messages.push(userMessage)
  await appendMessage(sessionId, userMessage)

  const toolContext: ToolContext = { sessionId, workingDir }

  let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  // agent loop - continue until no tool calls
  while (true) {
    // refresh tools and system prompt each iteration (for load_plugin)
    const tools = getTools()
    const system = await getSystem()
    const toolDefs: ToolDef[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
    const toolMap = new Map(tools.map(t => [t.name, t]))

    const assistantContent: ContentBlock[] = []
    let hasToolUse = false
    let hasText = false

    // stream response
    for await (const chunk of provider.stream({ messages, system, tools: toolDefs })) {
      switch (chunk.type) {
        case 'text':
          onChunk?.({ type: 'text', text: chunk.text })
          hasText = true
          // accumulate text into last text block or create new one
          const lastBlock = assistantContent[assistantContent.length - 1]
          if (lastBlock?.type === 'text') {
            lastBlock.text += chunk.text
          } else {
            assistantContent.push({ type: 'text', text: chunk.text })
          }
          break

        case 'tool_use':
          // signal end of text block before tool use (flush any buffered text)
          if (hasText) {
            onChunk?.({ type: 'text_block_end' })
            hasText = false
          }
          hasToolUse = true
          onChunk?.({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
          assistantContent.push({
            type: 'tool_use',
            id: chunk.id,
            name: chunk.name,
            input: chunk.input,
          })
          break

        case 'usage':
          totalUsage.input += chunk.input
          totalUsage.output += chunk.output
          totalUsage.cacheRead += chunk.cacheRead ?? 0
          totalUsage.cacheWrite += chunk.cacheWrite ?? 0
          break
      }
    }

    // save assistant message (skip if empty — model had nothing to say)
    if (assistantContent.length > 0) {
      const assistantMessage: Message = { role: 'assistant', content: assistantContent }
      messages.push(assistantMessage)
      await appendMessage(sessionId, assistantMessage)
    }

    if (!hasToolUse) {
      // signal end of text block before finishing (flush any buffered text)
      if (hasText) {
        onChunk?.({ type: 'text_block_end' })
      }
      // no tool calls, we're done
      onChunk?.({ type: 'done', usage: totalUsage })
      break
    }

    // execute tools and collect results
    const toolResults: ContentBlock[] = []
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const tool = toolMap.get(block.name)
        let result: { content: string; is_error?: boolean }

        if (!tool) {
          result = { content: `Unknown tool: ${block.name}`, is_error: true }
        } else {
          try {
            result = await tool.execute(block.input, toolContext)
            result.content = truncateToolResult(result.content)
          } catch (err) {
            result = { content: `Tool error: ${err}`, is_error: true }
          }
        }

        onChunk?.({ type: 'tool_result', tool_use_id: block.id, content: result.content, is_error: result.is_error })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        })
      }
    }

    // add tool results as user message
    const toolResultMessage: Message = { role: 'user', content: toolResults }
    messages.push(toolResultMessage)
    await appendMessage(sessionId, toolResultMessage)

    // check for interrupt messages before next round
    if (options.checkInterrupts) {
      const interrupts = options.checkInterrupts()
      if (interrupts.length > 0) {
        console.log(`[agent] injecting ${interrupts.length} interrupt(s) into conversation`)
        // inject interrupt messages into conversation
        for (const interrupt of interrupts) {
          const interruptMessage: Message = {
            role: 'user',
            content: [{ type: 'text', text: interrupt.text }],
          }
          messages.push(interruptMessage)
          await appendMessage(sessionId, interruptMessage)
        }
      }
    }
  }

  return { messages, usage: totalUsage }
}
