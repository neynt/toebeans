import { describe, test, expect, afterEach } from 'bun:test'
import { ensureTtsServer, stopTtsServer, isTtsAvailable, TtsUnavailableError } from './tts.ts'

// TTS model loading can take a while on GPU machines
const SLOW_TIMEOUT = 130_000

afterEach(async () => {
  await stopTtsServer()
})

describe('TtsUnavailableError', () => {
  test('is an instance of Error', () => {
    const err = new TtsUnavailableError('test reason')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TtsUnavailableError')
    expect(err.message).toBe('TTS server is unavailable: test reason')
  })

  test('works without a reason', () => {
    const err = new TtsUnavailableError()
    expect(err.message).toBe('TTS server is unavailable')
  })
})

describe('TTS service API contract', () => {
  test('ensureTtsServer returns a boolean, never throws', async () => {
    const result = await ensureTtsServer()
    expect(typeof result).toBe('boolean')
  }, SLOW_TIMEOUT)

  test('isTtsAvailable reflects state after ensureTtsServer', async () => {
    const result = await ensureTtsServer()
    expect(isTtsAvailable()).toBe(result)
  }, SLOW_TIMEOUT)

  test('concurrent ensureTtsServer calls all resolve without crashing', async () => {
    const results = await Promise.all([
      ensureTtsServer(),
      ensureTtsServer(),
      ensureTtsServer(),
    ])
    // all should return the same boolean
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
  }, SLOW_TIMEOUT)

  test('stopTtsServer is safe to call when nothing is running', async () => {
    await stopTtsServer()
    await stopTtsServer()
    expect(isTtsAvailable()).toBe(false)
  })

  test('stopTtsServer resets availability', async () => {
    await ensureTtsServer()
    await stopTtsServer()
    expect(isTtsAvailable()).toBe(false)
  }, SLOW_TIMEOUT)
})
