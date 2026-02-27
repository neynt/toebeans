// shared STT (speech-to-text) service client for toebeans
// manages the persistent whisper server and provides transcription

import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { unixRequest, isProcessAlive } from './unix-socket.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const WHISPER_SOCKET_PATH = join(TOEBEANS_DIR, 'whisper.sock')
const WHISPER_PIDFILE_PATH = join(TOEBEANS_DIR, 'whisper.pid')
const WHISPER_SERVER_SCRIPT = join(import.meta.dir, 'whisper-server.py')
const WHISPER_VENV_PYTHON = join(TOEBEANS_DIR, 'venvs', 'whisper', 'bin', 'python3')

let whisperProcess: ChildProcess | null = null
let whisperReady = false

async function isWhisperReady(): Promise<boolean> {
  try {
    const { status } = await unixRequest(WHISPER_SOCKET_PATH, 'GET', '/health')
    return status === 200
  } catch {
    return false
  }
}

/**
 * ensure the whisper server is running and ready.
 * checks for existing server via pidfile, spawns if needed.
 */
export async function ensureWhisperServer(): Promise<void> {
  if (whisperReady && await isWhisperReady()) return

  // check if an existing server is alive (may have been started by another plugin)
  try {
    const pidContent = await Bun.file(WHISPER_PIDFILE_PATH).text()
    const pid = parseInt(pidContent.trim(), 10)
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      if (await isWhisperReady()) {
        whisperReady = true
        return
      }
    }
  } catch {}

  // clean up stale files and spawn fresh
  for (const path of [WHISPER_SOCKET_PATH, WHISPER_PIDFILE_PATH]) {
    try { await unlink(path) } catch {}
  }

  console.log('stt: spawning whisper server...')
  whisperProcess = spawn(WHISPER_VENV_PYTHON, [
    WHISPER_SERVER_SCRIPT,
    '--socket', WHISPER_SOCKET_PATH,
    '--pidfile', WHISPER_PIDFILE_PATH,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  whisperProcess.unref()

  whisperProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`whisper-server: ${data.toString().trim()}`)
  })
  whisperProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`whisper-server: ${data.toString().trim()}`)
  })
  whisperProcess.on('exit', (code: number | null) => {
    console.log(`whisper-server exited with code ${code}`)
    whisperReady = false
    whisperProcess = null
  })

  // wait for server to respond (model loading can take a while)
  const timeout = 120_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await isWhisperReady()) {
      whisperReady = true
      console.log('stt: whisper server is ready!')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  throw new Error('stt: whisper server did not start within 120s')
}

/**
 * transcribe audio using the persistent whisper server.
 * accepts a WAV buffer and returns the transcribed text.
 */
export async function transcribe(wavBuffer: Buffer): Promise<string> {
  await ensureWhisperServer()

  const { status, data } = await unixRequest(
    WHISPER_SOCKET_PATH,
    'POST',
    '/transcribe',
    wavBuffer,
    'audio/wav',
  )

  if (status !== 200) {
    throw new Error(`whisper server error: ${status} ${data.toString()}`)
  }

  const result = JSON.parse(data.toString()) as { text: string; language: string; duration: number }
  return result.text.trim()
}

/**
 * stop the whisper server if we spawned it.
 */
export function stopWhisperServer(): void {
  if (whisperProcess) {
    whisperProcess.kill()
    whisperProcess = null
    whisperReady = false
  }
}
