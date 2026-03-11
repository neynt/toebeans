import type { LlmProvider } from '../server/llm-provider.ts'
import type { Message, StreamChunk, ToolDef } from '../server/types.ts'
import { getAccessToken } from './chatgpt-codex-auth.ts'

const API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function getCodexFunctionCallItemId(block: { id: string; provider_id?: string }): string {
  return block.provider_id ?? sanitizeToolId(block.id)
}

function isCodexToolUseBlock(block: { id: string; provider_id?: string }): block is { id: string; provider_id: string } {
  return typeof block.provider_id === 'string' && block.provider_id.startsWith('fc')
}

function formatCodexError(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return value.message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface ChatGPTCodexOptions {
  model?: string
}

// convert toebeans messages to Responses API input format
function buildInput(messages: Message[]): unknown[] {
  const input: unknown[] = []
  const replayableToolUseIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // collect text blocks
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text)
      if (textParts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join('') }],
        })
      }

      // collect tool calls
      for (const block of msg.content) {
        if (block.type === 'tool_use' && isCodexToolUseBlock(block)) {
          replayableToolUseIds.add(block.id)
          input.push({
            type: 'function_call',
            id: getCodexFunctionCallItemId(block),
            call_id: sanitizeToolId(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input),
          })
        }
      }
    } else {
      // user message — may contain text, images, tool_results
      const toolResults = msg.content.filter(b => b.type === 'tool_result') as
        { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>; is_error?: boolean }[]

      // emit tool results as function_call_output items
      for (const tr of toolResults) {
        if (!replayableToolUseIds.has(tr.tool_use_id)) {
          continue
        }
        let output: string
        if (typeof tr.content === 'string') {
          output = tr.content
        } else {
          output = tr.content
            .filter(b => b.type === 'text')
            .map(b => (b as { type: 'text'; text: string }).text)
            .join('\n')
        }
        if (tr.is_error) {
          output = `[Error] ${output}`
        }
        input.push({
          type: 'function_call_output',
          call_id: sanitizeToolId(tr.tool_use_id),
          output,
        })
      }

      // push remaining content as a user message
      const nonToolBlocks = msg.content.filter(b => b.type !== 'tool_result')
      if (nonToolBlocks.length > 0) {
        const contentParts: unknown[] = []
        for (const block of nonToolBlocks) {
          if (block.type === 'text') {
            contentParts.push({ type: 'input_text', text: block.text })
          } else if (block.type === 'image') {
            if (block.source.type === 'url') {
              contentParts.push({ type: 'input_image', url: block.source.url })
            } else if (block.source.type === 'base64') {
              contentParts.push({
                type: 'input_image',
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              })
            }
          }
        }
        if (contentParts.length > 0) {
          input.push({
            type: 'message',
            role: 'user',
            content: contentParts,
          })
        }
      }
    }
  }

  return input
}

// parse an SSE stream into individual events
async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<{ event: string; data: string }> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    // keep the last incomplete line in the buffer
    buffer = lines.pop()!

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        currentData += line.slice(6)
      } else if (line === '') {
        // empty line = end of event
        if (currentEvent || currentData) {
          yield { event: currentEvent, data: currentData }
          currentEvent = ''
          currentData = ''
        }
      }
    }
  }

  // flush any remaining event
  if (currentEvent || currentData) {
    yield { event: currentEvent, data: currentData }
  }
}

export class ChatGPTCodexProvider implements LlmProvider {
  name = 'chatgpt-codex'
  private model: string

  constructor(options: ChatGPTCodexOptions) {
    this.model = options.model ?? 'o4-mini'
  }

  async *stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
    abortSignal?: AbortSignal
  }): AsyncIterable<StreamChunk> {
    const accessToken = await getAccessToken()

    const input = buildInput(params.messages)

    const tools = params.tools.length > 0
      ? params.tools.map(t => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        }))
      : undefined

    const body: Record<string, unknown> = {
      model: this.model,
      instructions: params.system,
      input,
      stream: true,
      store: false,
      tool_choice: tools ? 'auto' : undefined,
      tools,
    }

    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: params.abortSignal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`ChatGPT Codex API error (${res.status}): ${errBody}`)
    }

    if (!res.body) {
      throw new Error('no response body from ChatGPT Codex API')
    }

    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>

    // accumulate function call arguments across streamed deltas
    const functionCalls = new Map<string, { id: string; provider_id: string; name: string; args: string }>()

    let inputTokens = 0
    let outputTokens = 0

    for await (const { event, data } of parseSSE(reader)) {
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      switch (event) {
        case 'response.output_text.delta': {
          const text = parsed.delta
          if (text) {
            yield { type: 'text', text }
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          // accumulate function call arguments
          const itemId = parsed.item_id
          const callId = parsed.call_id || itemId
          if (itemId) {
            const existing = functionCalls.get(itemId)
            if (existing) {
              existing.args += parsed.delta || ''
            } else {
              functionCalls.set(itemId, {
                id: callId || itemId,
                provider_id: itemId,
                name: parsed.name || '',
                args: parsed.delta || '',
              })
            }
          }
          break
        }

        case 'response.function_call_arguments.done': {
          // finalize a function call
          const itemId = parsed.item_id
          const acc = itemId ? functionCalls.get(itemId) : null
          if (acc) {
            let input: unknown = {}
            try {
              if (acc.args) input = JSON.parse(acc.args)
            } catch {
              // invalid json
            }
            yield { type: 'tool_use', id: acc.id, provider_id: acc.provider_id, name: acc.name, input }
            functionCalls.delete(itemId)
          }
          break
        }

        case 'response.output_item.added': {
          // a new output item is starting — if it's a function call, record its name
          if (parsed.item?.type === 'function_call') {
            const item = parsed.item
            functionCalls.set(item.id, {
              id: item.call_id || item.id,
              provider_id: item.id,
              name: item.name || '',
              args: '',
            })
          }
          break
        }

        case 'response.completed': {
          // extract usage from completed response
          const usage = parsed.response?.usage
          if (usage) {
            inputTokens = usage.input_tokens ?? 0
            outputTokens = usage.output_tokens ?? 0
          }

          // also emit any remaining function calls that didn't get a .done event
          for (const [, acc] of functionCalls) {
            let input: unknown = {}
            try {
              if (acc.args) input = JSON.parse(acc.args)
            } catch {
              // invalid json
            }
            yield { type: 'tool_use', id: acc.id, provider_id: acc.provider_id, name: acc.name, input }
          }
          functionCalls.clear()
          break
        }

        case 'error': {
          const errMsg = formatCodexError(parsed.message ?? parsed.error ?? parsed)
          throw new Error(`ChatGPT Codex stream error: ${errMsg}`)
        }
      }
    }

    yield {
      type: 'usage',
      input: inputTokens,
      output: outputTokens,
    }
  }
}
