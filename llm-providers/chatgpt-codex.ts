import type { LlmProvider } from '../server/llm-provider.ts'
import type { Message, StreamChunk, ToolDef } from '../server/types.ts'
import { getAccessToken } from './chatgpt-codex-auth.ts'
import { DebugLog } from '../server/debug-log.ts'

const debug = new DebugLog('codex-debug')

const API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const MAX_RETRY_ATTEMPTS = 3
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504])

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

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
      // prefer raw response output items (preserves ordering, metadata, reasoning).
      // an empty array means the response.completed event arrived without any
      // output items - fall through to the reconstruction fallback so the
      // assistant's tool_uses still make it into the request.
      if (msg.rawResponseOutput && Array.isArray(msg.rawResponseOutput) && msg.rawResponseOutput.length > 0) {
        for (const item of msg.rawResponseOutput) {
          const outputItem = item as { type?: string; call_id?: string; id?: string }
          input.push(item)
          // track function_call IDs so we can match tool_results
          if (outputItem.type === 'function_call' && outputItem.call_id) {
            replayableToolUseIds.add(outputItem.call_id)
          }
        }
      } else {
        // fallback: reconstruct from internal content blocks
        const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text)
        if (textParts.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: textParts.join('') }],
          })
        }

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
              contentParts.push({ type: 'input_image', image_url: block.source.url })
            } else if (block.source.type === 'base64') {
              contentParts.push({
                type: 'input_image',
                image_url: `data:${block.source.media_type};base64,${block.source.data}`,
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

    // log input structure for debugging
    const inputSummary = input.map((item: any) => {
      const type = item.type || '?'
      if (type === 'message') {
        const role = item.role || '?'
        const contentTypes = Array.isArray(item.content)
          ? item.content.map((c: any) => c.type).join(', ')
          : typeof item.content
        return `message(${role}, [${contentTypes}])`
      }
      if (type === 'function_call') return `function_call(${item.name}, call_id=${item.call_id})`
      if (type === 'function_call_output') {
        const outputPreview = typeof item.output === 'string' ? item.output.slice(0, 80) : '?'
        return `function_call_output(call_id=${item.call_id}, ${outputPreview})`
      }
      // raw items from response.output (reasoning, etc.)
      return `${type}(${item.id || ''})`
    })
    debug.log(`input (${input.length} items): ${inputSummary.join(' → ')}`)

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
      parallel_tool_calls: true,
      tools,
      // enable reasoning and request encrypted content so it can be replayed
      // (without this, the model loses its chain of thought between agent loop iterations)
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    }

    // dump full request body to file for debugging
    const debugTs = Date.now()
    try {
      debug.writeFile(`${debugTs}-request.json`, JSON.stringify(body, null, 2))
    } catch {}

    let res: Response | null = null
    let lastErrBody = ''

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: params.abortSignal,
      })

      if (res.ok) {
        break
      }

      lastErrBody = await res.text()
      const retryable = RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRY_ATTEMPTS && !params.abortSignal?.aborted
      if (!retryable) {
        throw new Error(`ChatGPT Codex API error (${res.status}): ${lastErrBody}`)
      }

      const delayMs = 1000 * (2 ** (attempt - 1))
      debug.warn(`retrying ChatGPT Codex API after ${res.status} on attempt ${attempt}/${MAX_RETRY_ATTEMPTS} in ${delayMs}ms`)
      await sleep(delayMs)
    }

    if (!res?.ok) {
      throw new Error(`ChatGPT Codex API error: exhausted retries${lastErrBody ? `: ${lastErrBody}` : ''}`)
    }

    if (!res.body) {
      throw new Error('no response body from ChatGPT Codex API')
    }

    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>

    // accumulate function call arguments across streamed deltas
    const functionCalls = new Map<string, { id: string; provider_id: string; name: string; args: string }>()
    // track which tool_use IDs we've already yielded (to detect missed events)
    const yieldedToolUseIds = new Set<string>()

    let inputTokens = 0
    let outputTokens = 0

    // track all SSE event types we receive for debugging
    const eventCounts = new Map<string, number>()
    // collect raw SSE events for debug dump
    const rawEvents: { event: string; data: string }[] = []
    // track how the stream ended
    let streamEndReason: string | null = null
    let streamEndDetails: Record<string, unknown> = {}

    for await (const { event, data } of parseSSE(reader)) {
      eventCounts.set(event, (eventCounts.get(event) || 0) + 1)
      rawEvents.push({ event, data })

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
            yieldedToolUseIds.add(acc.provider_id)
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
          const responseStatus = parsed.response?.status
          streamEndReason = `response.completed:${responseStatus ?? 'unknown'}`
          streamEndDetails = { provider: 'chatgpt-codex', response_status: responseStatus }

          // flush any remaining function calls tracked via streaming events
          for (const [, acc] of functionCalls) {
            let input: unknown = {}
            try {
              if (acc.args) input = JSON.parse(acc.args)
            } catch {
              // invalid json
            }
            yield { type: 'tool_use', id: acc.id, provider_id: acc.provider_id, name: acc.name, input }
            yieldedToolUseIds.add(acc.provider_id)
          }
          functionCalls.clear()

          // reconcile: check response.output for function_call items we missed
          // (streaming events may not always fire for every output item)
          const outputItems = parsed.response?.output as unknown[]
          if (Array.isArray(outputItems)) {
            for (const item of outputItems) {
              const outputItem = item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string }
              if (outputItem.type === 'function_call' && outputItem.id && !yieldedToolUseIds.has(outputItem.id)) {
                debug.warn(`recovered missed function_call from response.completed: ${outputItem.name} (${outputItem.id})`)
                let input: unknown = {}
                try {
                  if (outputItem.arguments) input = JSON.parse(outputItem.arguments)
                } catch {
                  // invalid json
                }
                yield {
                  type: 'tool_use',
                  id: outputItem.call_id || outputItem.id,
                  provider_id: outputItem.id,
                  name: outputItem.name || '',
                  input,
                }
                yieldedToolUseIds.add(outputItem.id)
              }
            }

            // log full response output for debugging
            const responseStatus = parsed.response?.status
            const outputDetails = outputItems.map((i: any) => {
              if (i.type === 'function_call') return `function_call(${i.name}, id=${i.id}, call_id=${i.call_id})`
              if (i.type === 'message') {
                const text = i.content?.[0]?.text || ''
                return `message(${i.role}, ${text.length} chars: "${text.slice(0, 100)}")`
              }
              return `${i.type}(${i.id || ''})`
            })
            const fcCount = outputItems.filter((i: any) => i.type === 'function_call').length
            debug.log(`response status=${responseStatus}, ${yieldedToolUseIds.size} yielded, ${fcCount} fc in response`)
            debug.log(`output items: ${outputDetails.join(' | ')}`)

            // yield raw output items so agent can preserve them for exact replay
            yield { type: 'raw_output', items: outputItems }
          }
          break
        }

        case 'error': {
          const errMsg = formatCodexError(parsed.message ?? parsed.error ?? parsed)
          throw new Error(`ChatGPT Codex stream error: ${errMsg}`)
        }
      }
    }

    // log all SSE event types received
    const eventSummary = [...eventCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', ')
    debug.log(`SSE events: ${eventSummary}`)

    // dump raw SSE events to file for debugging
    try {
      const sseData = rawEvents.map(e => `event: ${e.event}\ndata: ${e.data}`).join('\n\n')
      debug.writeFile(`${debugTs}-response.sse`, sseData)
    } catch {}

    // detect transport EOF without response.completed
    if (!streamEndReason) {
      streamEndReason = 'transport_eof'
      streamEndDetails = { provider: 'chatgpt-codex', sse_event_count: rawEvents.length }
      debug.warn(`stream ended via transport EOF without response.completed event`)
    }

    yield {
      type: 'usage',
      input: inputTokens,
      output: outputTokens,
    }

    yield {
      type: 'stream_end',
      reason: streamEndReason,
      details: streamEndDetails,
    }
  }
}
