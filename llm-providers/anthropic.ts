import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider } from '../server/llm-provider.ts'
import type { Message, StreamChunk, ToolDef, CacheHint } from '../server/types.ts'

type AnthropicContentBlock = Anthropic.Messages.ContentBlockParam
type AnthropicTool = Anthropic.Messages.Tool

// sanitize tool call IDs for cross-provider compatibility
// Anthropic requires IDs matching /^[a-zA-Z0-9_-]+$/
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export class AnthropicProvider implements LlmProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string
  private effort?: 'low' | 'medium' | 'high' | 'max'
  private maxOutputTokens: number

  constructor(options: { apiKey?: string; model: string; effort?: 'low' | 'medium' | 'high' | 'max'; maxOutputTokens?: number }) {
    this.client = new Anthropic({ apiKey: options.apiKey })
    this.model = options.model
    this.effort = options.effort
    this.maxOutputTokens = options.maxOutputTokens ?? 16384
  }

  async *stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
    cacheControl?: CacheHint[]
    abortSignal?: AbortSignal
  }): AsyncIterable<StreamChunk> {
    const messages = params.messages.map((msg, idx) => {
      const content = msg.content.map((block): AnthropicContentBlock => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text }
          case 'image': {
            // skip images over 5MB (Anthropic limit)
            if (block.source?.type === 'base64' && block.source.data.length > 5_000_000) {
              return { type: 'text', text: '(image too large, removed)' }
            }
            return { type: 'image', source: block.source }
          }
          case 'tool_use':
            return { type: 'tool_use', id: sanitizeToolId(block.id), name: block.name, input: block.input }
          case 'tool_result': {
            let content = block.content
            // filter oversized images in rich content
            if (Array.isArray(content)) {
              content = content.map(b => {
                if (b.type === 'image' && b.source?.type === 'base64' && b.source.data.length > 5_000_000) {
                  return { type: 'text' as const, text: '(image too large, removed)' }
                }
                return b
              })
            }
            return {
              type: 'tool_result',
              tool_use_id: sanitizeToolId(block.tool_use_id),
              content,
              is_error: block.is_error,
            }
          }
          default:
            return { type: 'text', text: `(unsupported block type: ${(block as { type: string }).type})` }
        }
      })

      // add cache control to last block of messages that have cache hints
      const cacheHint = params.cacheControl?.find(h => h.index === idx)
      if (cacheHint && content.length > 0) {
        const lastBlock = content[content.length - 1]!
        ;(lastBlock as { cache_control?: { type: string } }).cache_control = { type: cacheHint.type }
      }

      // auto-cache: put a breakpoint near the end of the conversation
      // so the prefix stays cached across turns within the agent loop
      const fromEnd = params.messages.length - idx
      if (fromEnd === 2 && content.length > 0) {
        const lastBlock = content[content.length - 1]!
        if (!(lastBlock as { cache_control?: unknown }).cache_control) {
          ;(lastBlock as { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' }
        }
      }

      return { role: msg.role, content }
    })

    const tools: AnthropicTool[] = params.tools.map((t, i) => {
      const tool: AnthropicTool = {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      }
      // cache breakpoint on last tool — caches system + tools together
      if (i === params.tools.length - 1) {
        ;(tool as { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' }
      }
      return tool
    })

    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
    ]

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system: systemBlocks,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      thinking: { type: 'adaptive' } as unknown as Anthropic.Messages.ThinkingConfigParam,
      ...(this.effort
        ? { output_config: { effort: this.effort } } as Record<string, unknown>
        : {}),
    }, params.abortSignal ? { signal: params.abortSignal } : undefined)

    let currentToolUse: { id: string; name: string; inputJson: string } | null = null

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            }
          }
          // skip 'thinking' content blocks — internal reasoning, not shown
          break

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.inputJson += event.delta.partial_json
          }
          // skip 'thinking_delta' — internal reasoning
          break

        case 'content_block_stop':
          if (currentToolUse) {
            let input: unknown = {}
            try {
              if (currentToolUse.inputJson) {
                input = JSON.parse(currentToolUse.inputJson)
              }
            } catch {
              // empty or invalid JSON, use empty object
            }
            yield {
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input,
            }
            currentToolUse = null
          }
          break

        case 'message_delta':
          // message complete, usage comes in final message
          break

        case 'message_stop':
          break
      }
    }

    // get final usage (may fail if stream was aborted)
    try {
      const finalMessage = await stream.finalMessage()
      yield {
        type: 'usage',
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
        cacheRead: (finalMessage.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
        cacheWrite: (finalMessage.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      }
    } catch {
      // aborted stream won't have final usage — that's fine
    }
  }
}
