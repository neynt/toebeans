// shared TTS (text-to-speech) service client for toebeans
// manages the persistent qwen3-tts server and provides speech generation

import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { unixRequest, isProcessAlive } from './unix-socket.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const TTS_SOCKET_PATH = join(TOEBEANS_DIR, 'tts.sock')
const TTS_PIDFILE_PATH = join(TOEBEANS_DIR, 'tts.pid')
const TTS_PLUGIN_DIR = join(TOEBEANS_DIR, 'plugins', 'tts')

let ttsProcess: ChildProcess | null = null
let ttsReady = false

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
}

/**
 * ensure the TTS server is running and ready.
 * checks for existing server via pidfile, spawns if needed.
 */
export async function ensureTtsServer(opts?: TtsOptions): Promise<void> {
  if (ttsReady && await isTtsReady()) return

  // check if an existing server is alive (may have been started by another plugin)
  try {
    const pidContent = await Bun.file(TTS_PIDFILE_PATH).text()
    const pid = parseInt(pidContent.trim(), 10)
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      if (await isTtsReady()) {
        ttsReady = true
        return
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

  const requestBody: { text: string; language: string; instruct?: string } = {
    text,
    language: opts?.language || 'english',
  }
  if (opts?.instruct) {
    requestBody.instruct = opts.instruct
  }

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
 * stop the TTS server if we spawned it.
 */
export function stopTtsServer(): void {
  if (ttsProcess) {
    ttsProcess.kill()
    ttsProcess = null
    ttsReady = false
  }
}
