import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider } from '../server/llm-provider.ts'
import type { Message, StreamChunk, ToolDef, CacheHint, ContentBlock } from '../server/types.ts'

type AnthropicContentBlock = Anthropic.Messages.ContentBlockParam
type AnthropicTool = Anthropic.Messages.Tool

export class AnthropicProvider implements LlmProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string

  constructor(options: { apiKey?: string; model: string }) {
    this.client = new Anthropic({ apiKey: options.apiKey })
    this.model = options.model
  }

  async *stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
    cacheControl?: CacheHint[]
  }): AsyncIterable<StreamChunk> {
    const messages = params.messages.map((msg, idx) => {
      const content = msg.content.map((block): AnthropicContentBlock => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text }
          case 'tool_use':
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          case 'tool_result':
            return {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            }
        }
      })

      // add cache control to last block of messages that have cache hints
      const cacheHint = params.cacheControl?.find(h => h.index === idx)
      if (cacheHint && content.length > 0) {
        const lastBlock = content[content.length - 1]!
        ;(lastBlock as { cache_control?: { type: string } }).cache_control = { type: cacheHint.type }
      }

      return { role: msg.role, content }
    })

    const tools: AnthropicTool[] = params.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }))

    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
    ]

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemBlocks,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    })

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
          break

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.inputJson += event.delta.partial_json
          }
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

    const finalMessage = await stream.finalMessage()
    yield {
      type: 'usage',
      input: finalMessage.usage.input_tokens,
      output: finalMessage.usage.output_tokens,
      cacheRead: (finalMessage.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
      cacheWrite: (finalMessage.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
    }
  }
}
