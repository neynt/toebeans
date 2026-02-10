import type { LlmProvider } from './llm-provider.ts'
import type { Message, ContentBlock, Tool, ToolContext, ToolResultContent, StreamChunk, ToolDef, AgentResult, ServerMessage } from './types.ts'
import { loadSession, appendMessage } from './session.ts'
import { countTokens } from '@anthropic-ai/tokenizer'
import { estimateImageTokens } from './tokens.ts'

// defaults — can be overridden via AgentOptions
const DEFAULT_MAX_TOOL_RESULT_CHARS = 50000
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 10_000

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

function truncateString(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content
  }
  const half = Math.floor(maxChars / 2)
  const truncatedBytes = content.length - maxChars
  return content.slice(0, half) + `\n\n... [truncated ${truncatedBytes} characters] ...\n\n` + content.slice(-half)
}

function truncateToolResult(content: ToolResultContent, maxChars: number): ToolResultContent {
  if (typeof content === 'string') {
    return truncateString(content, maxChars)
  }
  // for rich content, truncate text blocks only
  return content.map(block => {
    if (block.type === 'text') {
      return { ...block, text: truncateString(block.text, maxChars) }
    }
    return block
  })
}

function toolResultText(content: ToolResultContent): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('\n')
}

function truncateStringByTokens(text: string, tokenCount: number, maxTokens: number): string {
  if (tokenCount <= maxTokens) return text
  // estimate char cutoff — ~4 chars/token, trim conservatively then verify
  let cutoff = Math.floor(text.length * (maxTokens / tokenCount) * 0.9)
  let trimmed = text.slice(0, cutoff)
  // expand slightly if we undershot
  while (countTokens(trimmed) < maxTokens && cutoff < text.length) {
    cutoff = Math.min(cutoff + 500, text.length)
    trimmed = text.slice(0, cutoff)
  }
  // shrink if we overshot
  while (countTokens(trimmed) > maxTokens && cutoff > 0) {
    cutoff -= 200
    trimmed = text.slice(0, cutoff)
  }
  return trimmed + `\n\n[truncated — result was ${tokenCount} tokens, limit is ${maxTokens}]`
}

function truncateToolResultByTokens(content: ToolResultContent, maxTokens: number): ToolResultContent {
  const text = toolResultText(content)
  const textTokens = countTokens(text)

  // calculate image tokens from any image blocks
  let imageTokens = 0
  if (typeof content !== 'string') {
    for (const block of content) {
      if (block.type === 'image') {
        imageTokens += estimateImageTokens(block.source)
      }
    }
  }

  const totalTokens = textTokens + imageTokens
  if (totalTokens <= maxTokens) return content

  if (typeof content === 'string') {
    return truncateStringByTokens(content, textTokens, maxTokens)
  }
  // for rich content, give text the remaining budget after image tokens
  const textBudget = Math.max(100, maxTokens - imageTokens)
  const truncatedText = truncateStringByTokens(text, textTokens, textBudget)
  const nonTextBlocks = content.filter(b => b.type !== 'text')
  return [{ type: 'text' as const, text: truncatedText }, ...nonTextBlocks]
}

export interface AgentOptions {
  provider: LlmProvider
  system: () => string | Promise<string>
  tools: () => Tool[]
  sessionId: string
  workingDir: string
  onChunk?: (chunk: ServerMessage) => void
  checkInterrupts?: () => { content: ContentBlock[]; outputTarget: string }[]
  checkAbort?: () => boolean
  maxToolResultChars?: number
  maxToolResultTokens?: number
}

export async function runAgentTurn(
  userContent: ContentBlock[],
  options: AgentOptions
): Promise<AgentResult> {
  const { provider, system: getSystem, tools: getTools, sessionId, workingDir, onChunk } = options
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  const maxToolResultTokens = options.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS

  // load existing messages and repair any interrupted tool calls
  const messages = repairMessages(await loadSession(sessionId))

  // add user message
  const userMessage: Message = {
    role: 'user',
    content: userContent,
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
        let result: { content: ToolResultContent; is_error?: boolean }

        if (!tool) {
          result = { content: `Unknown tool: ${block.name}`, is_error: true }
        } else {
          try {
            result = await tool.execute(block.input, toolContext)
            result.content = truncateToolResult(result.content, maxToolResultChars)
            result.content = truncateToolResultByTokens(result.content, maxToolResultTokens)
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

    // check for interrupt messages before saving tool results
    // interrupts must be merged into the tool result message to maintain
    // alternating user/assistant message structure required by the API
    let interruptBlocks: ContentBlock[] = []
    if (options.checkInterrupts) {
      const interrupts = options.checkInterrupts()
      if (interrupts.length > 0) {
        console.log(`[agent] injecting ${interrupts.length} interrupt(s) into conversation`)
        for (const interrupt of interrupts) {
          interruptBlocks.push(...interrupt.content)
        }
      }
    }

    // add tool results (+ any interrupt content) as a single user message
    const toolResultMessage: Message = {
      role: 'user',
      content: [...toolResults, ...interruptBlocks],
    }
    messages.push(toolResultMessage)
    await appendMessage(sessionId, toolResultMessage)

    // check if abort was requested
    if (options.checkAbort?.()) {
      console.log(`[agent] abort requested for session ${sessionId}`)
      onChunk?.({ type: 'done', usage: totalUsage })
      return { messages, usage: totalUsage, aborted: true }
    }
  }

  return { messages, usage: totalUsage }
}
