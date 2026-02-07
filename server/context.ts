import { countTokens } from '@anthropic-ai/tokenizer'
import type { Message, CacheHint } from './types.ts'
import { loadSession, appendMessage, generateSessionId } from './session.ts'

const CACHE_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes (Anthropic cache lifetime)
const CACHE_REFRESH_BUFFER_MS = 30 * 1000 // refresh 30s before expiry
const MIN_TOKENS_FOR_CACHE = 1024 // minimum tokens to bother caching

export class ContextManager {
  private sessionId: string
  private messages: Message[] = []
  private cacheTimestamp: number | null = null
  private estimatedTokens = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  async load(): Promise<void> {
    this.messages = await loadSession(this.sessionId)
    this.estimatedTokens = this.estimateTokens()
  }

  getMessages(): Message[] {
    return this.messages
  }

  async append(message: Message): Promise<void> {
    this.messages.push(message)
    await appendMessage(this.sessionId, message)
    this.estimatedTokens = this.estimateTokens()
  }

  getCacheHints(): CacheHint[] {
    // cache the last message if we have enough content
    if (this.messages.length > 0 && this.estimatedTokens >= MIN_TOKENS_FOR_CACHE) {
      this.cacheTimestamp = Date.now()
      return [{ index: this.messages.length - 1, type: 'ephemeral' }]
    }
    return []
  }

  /**
   * Returns true if we should trigger summarization to preserve cache.
   * This happens ~30s before cache expires if we have significant content.
   */
  shouldSummarize(): boolean {
    if (!this.cacheTimestamp) return false
    if (this.estimatedTokens < MIN_TOKENS_FOR_CACHE * 2) return false

    const elapsed = Date.now() - this.cacheTimestamp
    const timeUntilExpiry = CACHE_EXPIRY_MS - elapsed

    return timeUntilExpiry <= CACHE_REFRESH_BUFFER_MS && timeUntilExpiry > 0
  }

  /**
   * Get time remaining until cache expires (for display/debugging)
   */
  getCacheTimeRemaining(): number | null {
    if (!this.cacheTimestamp) return null
    const elapsed = Date.now() - this.cacheTimestamp
    return Math.max(0, CACHE_EXPIRY_MS - elapsed)
  }

  /**
   * Compact the session: summarize content and start new session
   * Returns the new session ID
   */
  async compact(summary: string): Promise<string> {
    const newSessionId = await generateSessionId()

    // create initial message with summary context
    const summaryMessage: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Session context from previous conversation]\n\n${summary}\n\n[End of context]`,
      }],
    }

    await appendMessage(newSessionId, summaryMessage)

    return newSessionId
  }

  /**
   * Token estimation using official Anthropic tokenizer
   */
  private estimateTokens(): number {
    const json = JSON.stringify(this.messages)
    return countTokens(json)
  }

  getSessionId(): string {
    return this.sessionId
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens
  }
}
