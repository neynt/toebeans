// shared TTS (text-to-speech) service client for toebeans
// manages the persistent qwen3-tts server and provides speech generation

import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { unixRequest, unixRequestStream, isProcessAlive, killPidfile } from './unix-socket.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const TTS_SOCKET_PATH = join(TOEBEANS_DIR, 'tts.sock')
const TTS_PIDFILE_PATH = join(TOEBEANS_DIR, 'tts.pid')
const TTS_PLUGIN_DIR = join(TOEBEANS_DIR, 'plugins', 'tts')

let ttsProcess: ChildProcess | null = null
let ttsReady = false
let ttsStarting: Promise<void> | null = null

async function isTtsReady(): Promise<boolean> {
  try {
    const { status } = await unixRequest(TTS_SOCKET_PATH, 'GET', '/health')
    return status === 200
  } catch {
    return false
  }
}

export interface TtsOptions {
  language?: string
  instruct?: string
  voiceInstruct?: string  // env-level default voice instruct
  seed?: number           // torch random seed for consistent voice across calls
  temperature?: number    // sampling temperature (lower = more consistent voice)
  subtalkerTemperature?: number  // sub-talker sampling temperature
}

/**
 * ensure the TTS server is running and ready.
 * uses a mutex to prevent concurrent callers from spawning duplicate processes.
 */
export async function ensureTtsServer(opts?: TtsOptions): Promise<void> {
  // fast path: already running and healthy
  if (ttsReady && await isTtsReady()) return

  // if another call is already starting the server, wait for it
  if (ttsStarting) {
    await ttsStarting
    return
  }

  // take the lock and do the actual startup
  let resolve!: () => void
  let reject!: (err: Error) => void
  ttsStarting = new Promise<void>((res, rej) => { resolve = res; reject = rej })

  try {
    await doEnsureTtsServer(opts)
    resolve()
  } catch (err) {
    reject(err as Error)
    throw err
  } finally {
    ttsStarting = null
  }
}

async function doEnsureTtsServer(opts?: TtsOptions): Promise<void> {
  // re-check after acquiring lock (another caller may have started it)
  if (ttsReady && await isTtsReady()) return

  // check if an existing server is alive (may have been started by another plugin or previous run)
  try {
    const pidContent = await Bun.file(TTS_PIDFILE_PATH).text()
    const pid = parseInt(pidContent.trim(), 10)
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      if (await isTtsReady()) {
        ttsReady = true
        return
      }
      // process alive but not healthy — kill it before spawning a new one
      console.log(`tts: killing unhealthy existing server (pid ${pid})`)
      process.kill(pid, 'SIGTERM')
      // give it a moment to exit
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {}

  // clean up stale files and spawn fresh
  for (const path of [TTS_SOCKET_PATH, TTS_PIDFILE_PATH]) {
    try { await unlink(path) } catch {}
  }

  console.log('tts: spawning TTS server...')
  const startScript = join(TTS_PLUGIN_DIR, 'start.sh')

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (opts?.voiceInstruct) {
    env.VOICE_INSTRUCT = opts.voiceInstruct
  }

  ttsProcess = spawn(startScript, ['--socket', TTS_SOCKET_PATH, '--pidfile', TTS_PIDFILE_PATH], {
    cwd: TTS_PLUGIN_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env,
  })
  ttsProcess.unref()

  ttsProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`tts-server: ${data.toString().trim()}`)
  })
  ttsProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`tts-server: ${data.toString().trim()}`)
  })
  ttsProcess.on('exit', (code: number | null) => {
    console.log(`tts-server exited with code ${code}`)
    ttsReady = false
    ttsProcess = null
  })

  // wait for server to respond (model loading can take a while)
  const timeout = 120_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await isTtsReady()) {
      ttsReady = true
      console.log('tts: TTS server is ready!')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  throw new Error('tts: TTS server did not start within 120s')
}

/**
 * generate speech from text using the persistent TTS server.
 * returns the raw WAV buffer.
 */
export async function speak(text: string, opts?: TtsOptions): Promise<Buffer> {
  await ensureTtsServer(opts)

  const requestBody: Record<string, unknown> = {
    text,
    language: opts?.language || 'english',
  }
  if (opts?.instruct) requestBody.instruct = opts.instruct
  if (opts?.seed != null) requestBody.seed = opts.seed
  if (opts?.temperature != null) requestBody.temperature = opts.temperature
  if (opts?.subtalkerTemperature != null) requestBody.subtalker_temperature = opts.subtalkerTemperature

  const { status, data } = await unixRequest(
    TTS_SOCKET_PATH,
    'POST',
    '/tts',
    JSON.stringify(requestBody),
  )

  if (status !== 200) {
    throw new Error(`TTS server error: ${status} ${data.toString()}`)
  }

  return data
}

/**
 * stream speech generation from text. yields raw PCM int16 LE chunks at 24kHz
 * as they're produced by the model (first chunk in ~400ms for fast time-to-first-audio).
 */
export async function* speakStreaming(text: string, opts?: TtsOptions): AsyncGenerator<Buffer> {
  await ensureTtsServer(opts)

  const requestBody: Record<string, unknown> = {
    text,
    language: opts?.language || 'english',
  }
  if (opts?.instruct) requestBody.instruct = opts.instruct
  if (opts?.seed != null) requestBody.seed = opts.seed
  if (opts?.temperature != null) requestBody.temperature = opts.temperature
  if (opts?.subtalkerTemperature != null) requestBody.subtalker_temperature = opts.subtalkerTemperature

  const { status, stream } = await unixRequestStream(
    TTS_SOCKET_PATH,
    'POST',
    '/tts/stream',
    JSON.stringify(requestBody),
  )

  if (status !== 200) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    throw new Error(`TTS stream error: ${status} ${Buffer.concat(chunks).toString()}`)
  }

  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  }
}

/**
 * stop the TTS server — kills tracked process AND any process from pidfile.
 */
export async function stopTtsServer(): Promise<void> {
  ttsReady = false

  if (ttsProcess) {
    ttsProcess.kill()
    ttsProcess = null
  }

  // also kill by pidfile in case we lost the reference (server restart, etc.)
  await killPidfile(TTS_PIDFILE_PATH)
}
