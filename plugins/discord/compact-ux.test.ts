import { describe, test, expect } from 'bun:test'

/**
 * Tests for the /compact slash command's visible UX flow.
 *
 * The handler lives inline in index.ts's InteractionCreate listener,
 * so we replicate the control flow here to verify the editReply sequence.
 */

type EditReplyCall = { content: string; timestamp: number }

/** Simulate the /compact handler's editReply sequence. */
async function simulateCompactHandler(opts: {
  sessionId: string
  requestCompact?: (route: string) => Promise<string | null>
}) {
  const calls: EditReplyCall[] = []
  let time = 0
  const editReply = (content: string) => {
    calls.push({ content, timestamp: time++ })
  }

  const route = 'discord:test-channel-123'
  const sessionId = opts.sessionId

  if (opts.requestCompact) {
    editReply(`⏳ running learn/finalize compaction for \`${sessionId}\`...`)
    const newId = await opts.requestCompact(route)
    if (newId) {
      editReply(`✅ compacted session \`${sessionId}\` → \`${newId}\``)
    } else {
      editReply(`⚠️ learn turn did not finalize session \`${sessionId}\``)
    }
  } else {
    editReply(`❌ compact not available (server context missing)`)
  }

  return calls
}

describe('/compact slash command UX', () => {
  test('shows progress message before final success', async () => {
    const calls = await simulateCompactHandler({
      sessionId: 'sess-old',
      requestCompact: async () => 'sess-new',
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].content).toContain('⏳')
    expect(calls[0].content).toContain('sess-old')
    expect(calls[1].content).toContain('✅')
    expect(calls[1].content).toContain('sess-new')
    // progress message comes before final result
    expect(calls[0].timestamp).toBeLessThan(calls[1].timestamp)
  })

  test('shows progress message before finalize-failure warning', async () => {
    const calls = await simulateCompactHandler({
      sessionId: 'sess-stuck',
      requestCompact: async () => null,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].content).toContain('⏳')
    expect(calls[0].content).toContain('learn/finalize')
    expect(calls[1].content).toContain('⚠️')
    expect(calls[1].content).toContain('did not finalize')
  })

  test('shows error when serverContext.requestCompact is missing', async () => {
    const calls = await simulateCompactHandler({
      sessionId: 'sess-any',
      requestCompact: undefined,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].content).toContain('❌')
    expect(calls[0].content).toContain('server context missing')
  })
})
