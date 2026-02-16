// Internal message types (provider-agnostic)

export type ImageSource = { type: 'url'; url: string } | { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }

// rich content for tool results — array of text/image blocks
export type ToolResultContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; source: ImageSource }>

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

// Streaming chunks from LLM
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }

// Cache hints for context optimization
export interface CacheHint {
  index: number // message index
  type: 'ephemeral'
}

// Tool definition for LLM
export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// Tool execution context
export interface ToolContext {
  abortSignal?: AbortSignal
  sessionId: string
  workingDir: string
  outputTarget?: string
}

// Tool result
export interface ToolResult {
  content: ToolResultContent
  is_error?: boolean
}

// Tool interface
export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: unknown, context: ToolContext) => Promise<ToolResult>
}

// WebSocket API messages
export type ClientMessage =
  | { type: 'message'; sessionId: string; content: string }
  | { type: 'subscribe'; sessionId: string }

export type ServerMessage =
  | { type: 'text'; text: string }
  | { type: 'text_block_end' }  // signals end of a text content block (flush buffer)
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean }
  | { type: 'done'; usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; cost?: { session: number; turn: number } }
  | { type: 'error'; message: string }

// Session entry types — the JSONL format
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface MessageCost {
  inputCost: number
  outputCost: number
  usage: TokenUsage
}

export type SessionEntry =
  | { type: 'system_prompt'; timestamp: string; content: string }
  | { type: 'message'; timestamp: string; message: Message; cost?: MessageCost }

// Session info
export interface SessionInfo {
  id: string
  createdAt: Date
  lastActiveAt: Date
}

// Agent result
export interface AgentResult {
  messages: Message[]
  usage: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
  aborted?: boolean
}
