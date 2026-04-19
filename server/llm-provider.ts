import type { Message, StreamChunk, ToolDef, CacheHint } from './types.ts'

export interface LlmProvider {
  name: string

  stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
    cacheControl?: CacheHint[]
    abortSignal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}
