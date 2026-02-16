import OpenAI from 'openai'
import type { LlmProvider } from '../server/llm-provider.ts'
import type { Message, StreamChunk, ToolDef } from '../server/types.ts'

// sanitize tool call IDs for cross-provider compatibility
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export interface OpenAICompatibleOptions {
  apiKey?: string
  baseUrl?: string
  model: string
  maxOutputTokens?: number
  thinking?: boolean      // enable reasoning/thinking mode
  temperature?: number
  topP?: number
}

export class OpenAICompatibleProvider implements LlmProvider {
  name = 'openai-compatible'
  private client: OpenAI
  private model: string
  private maxOutputTokens: number
  private thinking: boolean
  private temperature: number
  private topP: number

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    })
    this.model = options.model
    this.maxOutputTokens = options.maxOutputTokens ?? 16384
    this.thinking = options.thinking ?? true
    this.temperature = options.temperature ?? (options.thinking !== false ? 1.0 : 0.6)
    this.topP = options.topP ?? 0.95
  }

  async *stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
    abortSignal?: AbortSignal
  }): AsyncIterable<StreamChunk> {
    // convert internal messages to OpenAI format
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.system },
    ]

    for (const msg of params.messages) {
      if (msg.role === 'assistant') {
        // collect text and tool_use blocks
        const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text)
        const toolCalls = msg.content.filter(b => b.type === 'tool_use') as
          { type: 'tool_use'; id: string; name: string; input: unknown }[]

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.join('') || null,
        }

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: sanitizeToolId(tc.id),
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }))
        }

        // Kimi requires reasoning_content on ALL assistant messages when
        // thinking mode is enabled, not just ones with tool_calls
        if (this.thinking) {
          ;(assistantMsg as any).reasoning_content = (assistantMsg as any).reasoning_content || '.'
        }

        messages.push(assistantMsg)
      } else {
        // user message — may contain text, images, tool_results
        const toolResults = msg.content.filter(b => b.type === 'tool_result') as
          { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>; is_error?: boolean }[]

        // push tool results as individual tool messages
        for (const tr of toolResults) {
          let content: string
          if (typeof tr.content === 'string') {
            content = tr.content
          } else {
            content = tr.content
              .filter(b => b.type === 'text')
              .map(b => (b as { type: 'text'; text: string }).text)
              .join('\n')
          }
          if (tr.is_error) {
            content = `[Error] ${content}`
          }
          messages.push({
            role: 'tool',
            tool_call_id: sanitizeToolId(tr.tool_use_id),
            content,
          })
        }

        // push remaining content (text + images) as a user message
        const nonToolBlocks = msg.content.filter(b => b.type !== 'tool_result')
        if (nonToolBlocks.length > 0) {
          const parts: OpenAI.ChatCompletionContentPart[] = []
          for (const block of nonToolBlocks) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text })
            } else if (block.type === 'image') {
              if (block.source.type === 'base64') {
                parts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                  },
                })
              } else if (block.source.type === 'url') {
                parts.push({
                  type: 'image_url',
                  image_url: { url: block.source.url },
                })
              }
            }
          }
          if (parts.length > 0) {
            messages.push({ role: 'user', content: parts })
          }
        }
      }
    }

    // build tools
    const tools: OpenAI.ChatCompletionTool[] | undefined =
      params.tools.length > 0
        ? params.tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          }))
        : undefined

    // thinking mode: disabled via extra_body if not wanted
    const extraBody: Record<string, unknown> = {}
    if (!this.thinking) {
      extraBody.thinking = { type: 'disabled' }
    }

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: this.maxOutputTokens,
        messages,
        tools,
        temperature: this.temperature,
        top_p: this.topP,
        stream: true,
        stream_options: { include_usage: true },
        ...extraBody,
      },
      params.abortSignal ? { signal: params.abortSignal } : undefined,
    )

    // track in-progress tool calls by index
    const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]

      if (choice) {
        const delta = choice.delta

        // text content
        if (delta?.content) {
          yield { type: 'text', text: delta.content }
        }

        // reasoning_content (thinking mode) — skip, like Anthropic's thinking blocks
        // (some OpenAI-compatible APIs like Kimi send this)

        // tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (tc.id) {
              // new tool call starting
              toolCallAccumulators.set(idx, {
                id: tc.id,
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              })
            } else {
              // continuation of existing tool call
              const acc = toolCallAccumulators.get(idx)
              if (acc) {
                if (tc.function?.name) acc.name += tc.function.name
                if (tc.function?.arguments) acc.args += tc.function.arguments
              }
            }
          }
        }

        // when a tool call finishes (finish_reason: 'tool_calls' or stop)
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
          // emit all accumulated tool calls
          for (const [, acc] of toolCallAccumulators) {
            let input: unknown = {}
            try {
              if (acc.args) input = JSON.parse(acc.args)
            } catch {
              // invalid JSON
            }
            yield { type: 'tool_use', id: acc.id, name: acc.name, input }
          }
          toolCallAccumulators.clear()
        }
      }

      // usage info (comes in the final chunk with stream_options.include_usage)
      if (chunk.usage) {
        // Kimi returns cached token count in prompt_tokens_details.cached_tokens
        // (automatic prefix caching — no special request params needed)
        const details = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details
        const cachedTokens = details?.cached_tokens ?? 0
        yield {
          type: 'usage',
          input: chunk.usage.prompt_tokens - cachedTokens,
          output: chunk.usage.completion_tokens,
          cacheRead: cachedTokens || undefined,
        }
      }
    }
  }
}
