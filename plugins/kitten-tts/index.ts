// kitten-tts plugin for toebeans
// generates speech using KittenTTS (CPU-only, 8 built-in voices) and sends voice messages to discord

import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult } from '../../server/types.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { mkdir, readFile, unlink, access } from 'node:fs/promises'
import { join } from 'path'
import { homedir } from 'os'

interface KittenTtsConfig {
  discordBotToken?: string
  defaultVoice?: string  // one of: expr-voice-{2,3,4,5}-{m,f}
}

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const AUDIO_DIR = join(TOEBEANS_DIR, 'workspace', 'audio')
const SOCKET_PATH = join(TOEBEANS_DIR, 'kitten-tts.sock')
const PIDFILE_PATH = join(TOEBEANS_DIR, 'kitten-tts.pid')

async function ensureAudioDir(): Promise<void> {
  await mkdir(AUDIO_DIR, { recursive: true })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PIDFILE_PATH, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function unixRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath,
      method,
      path,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : undefined,
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function isServerReady(): Promise<boolean> {
  try {
    const { status } = await unixRequest(SOCKET_PATH, 'GET', '/health')
    return status === 200
  } catch {
    return false
  }
}

async function cleanupStale(): Promise<void> {
  for (const path of [SOCKET_PATH, PIDFILE_PATH]) {
    try { await unlink(path) } catch { /* noop */ }
  }
}

export default function create(): Plugin {
  let config: KittenTtsConfig | null = null
  let serverProcess: ChildProcess | null = null
  let serverAvailable = false
  let serverStarting: Promise<boolean> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0

  const RETRY_BACKOFF_BASE = 5_000
  const RETRY_BACKOFF_MAX = 60_000

  function scheduleRetry(): void {
    cancelRetry()
    const delay = Math.min(RETRY_BACKOFF_BASE * (2 ** retryCount), RETRY_BACKOFF_MAX)
    retryCount++
    console.log(`kitten-tts: scheduling retry #${retryCount} in ${(delay / 1000).toFixed(0)}s`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      ensureServer().then(ok => {
        if (ok) console.log('kitten-tts: background retry succeeded')
      })
    }, delay)
    retryTimer.unref()
  }

  function cancelRetry(): void {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  async function ensureServer(): Promise<boolean> {
    if (serverAvailable && await isServerReady()) return true

    if (serverStarting) return serverStarting

    let resolve!: (ok: boolean) => void
    serverStarting = new Promise<boolean>((res) => { resolve = res })

    try {
      const ok = await doEnsureServer()
      resolve(ok)
      return ok
    } catch (err) {
      console.error('kitten-tts: unexpected error during startup:', err)
      resolve(false)
      return false
    } finally {
      serverStarting = null
    }
  }

  async function doEnsureServer(): Promise<boolean> {
    if (serverAvailable && await isServerReady()) return true

    const pid = await readPid()
    if (pid && isProcessAlive(pid) && await fileExists(SOCKET_PATH)) {
      if (await isServerReady()) {
        serverAvailable = true
        retryCount = 0
        cancelRetry()
        return true
      }
    }

    await cleanupStale()

    console.log('kitten-tts: spawning server...')
    const scriptDir = import.meta.dir
    const startScript = join(scriptDir, 'start.sh')

    try {
      serverProcess = spawn(startScript, ['--socket', SOCKET_PATH, '--pidfile', PIDFILE_PATH], {
        cwd: scriptDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      console.error('kitten-tts: failed to spawn server process:', err)
      scheduleRetry()
      return false
    }
    serverProcess.unref()

    serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`kitten-tts-server: ${data.toString().trim()}`)
    })
    serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`kitten-tts-server: ${data.toString().trim()}`)
    })
    serverProcess.on('exit', (code: number | null) => {
      console.log(`kitten-tts-server exited with code ${code}`)
      serverAvailable = false
      serverProcess = null
      if (code !== 0 && code !== null) {
        scheduleRetry()
      }
    })

    // KittenTTS is CPU-only and loads fast — 30s should be plenty
    const timeout = 30_000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await isServerReady()) {
        serverAvailable = true
        retryCount = 0
        cancelRetry()
        console.log('kitten-tts: server is ready!')
        return true
      }
      if (!serverProcess) {
        console.error('kitten-tts: server process exited before becoming ready')
        scheduleRetry()
        return false
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    console.error('kitten-tts: server did not start within 30s — will retry in background')
    scheduleRetry()
    return false
  }

  const VOICES = [
    'expr-voice-2-m', 'expr-voice-2-f',
    'expr-voice-3-m', 'expr-voice-3-f',
    'expr-voice-4-m', 'expr-voice-4-f',
    'expr-voice-5-m', 'expr-voice-5-f',
  ]

  const tools: Tool[] = [
    {
      name: 'kitten_tts_speak',
      description: `Generate speech from text using KittenTTS (CPU-only, fast). Returns the file path of the saved audio. Available voices: ${VOICES.join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert to speech' },
          voice: {
            type: 'string',
            description: `Voice to use (default: ${VOICES[0]}). Options: ${VOICES.join(', ')}`,
            enum: VOICES,
          },
          speed: {
            type: 'number',
            description: 'Speech speed multiplier (default: 1.0, >1.0 = faster, <1.0 = slower)',
          },
        },
        required: ['text'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { text, voice, speed } = input as {
          text: string
          voice?: string
          speed?: number
        }

        try {
          const ok = await ensureServer()
          if (!ok) return { content: 'kitten-tts server is unavailable (startup failed, retrying in background)', is_error: true }
          await ensureAudioDir()

          const requestBody: Record<string, unknown> = {
            text,
            voice: voice || config?.defaultVoice || 'expr-voice-2-f',
          }
          if (speed != null) requestBody.speed = speed

          const { status, data } = await unixRequest(
            SOCKET_PATH, 'POST', '/tts', JSON.stringify(requestBody),
          )

          if (status !== 200) {
            return { content: `kitten-tts server error: ${status} - ${data.toString()}`, is_error: true }
          }

          const timestamp = Date.now()
          const filename = `kitten-tts-${timestamp}.wav`
          const filepath = join(AUDIO_DIR, filename)

          await Bun.write(filepath, data)

          return { content: `audio saved to: ${filepath}` }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to generate speech: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'kitten_tts_send_voice',
      description: 'Send an audio file to a Discord channel as a voice message using the REST API.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID to send to' },
          audio_path: { type: 'string', description: 'Path to the audio file to send' },
          message: { type: 'string', description: 'Optional message text to include with the audio' },
        },
        required: ['channel_id', 'audio_path'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!config?.discordBotToken) {
          return { content: 'discord bot token not configured', is_error: true }
        }

        const { channel_id, audio_path, message = '' } = input as {
          channel_id: string
          audio_path: string
          message?: string
        }

        try {
          const file = Bun.file(audio_path)
          if (!(await file.exists())) {
            return { content: `audio file not found: ${audio_path}`, is_error: true }
          }

          const fileBuffer = await file.arrayBuffer()
          const filename = audio_path.split('/').pop() || 'voice.wav'

          const formData = new FormData()
          formData.append('files[0]', new Blob([fileBuffer], { type: 'audio/wav' }), filename)
          if (message) {
            formData.append('payload_json', JSON.stringify({ content: message }))
          }

          const response = await fetch(
            `https://discord.com/api/v10/channels/${channel_id}/messages`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bot ${config.discordBotToken}`,
              },
              body: formData,
            }
          )

          if (!response.ok) {
            const errorText = await response.text()
            return { content: `discord api error: ${response.status} - ${errorText}`, is_error: true }
          }

          return { content: `voice message sent to channel ${channel_id}` }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to send voice message: ${error.message}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'kitten-tts',
    configSchema: [
      { key: 'discordBotToken', type: 'string', description: 'Discord bot token for voice', secret: true },
      { key: 'defaultVoice', type: 'string', description: 'default voice (e.g. expr-voice-3-f)' },
    ],
    description: `Text-to-speech using KittenTTS (CPU-only, fast, 8 voices). Available voices: ${VOICES.join(', ')}.`,

    tools,

    async init(cfg: unknown) {
      config = cfg as KittenTtsConfig

      if (!config?.discordBotToken) {
        console.warn('kitten-tts: no discord bot token provided (kitten_tts_send_voice will fail)')
      }

      await ensureAudioDir()
      // server is spawned lazily on first kitten_tts_speak() call
    },

    async destroy() {
      cancelRetry()
      if (serverProcess) {
        console.log('kitten-tts: shutting down server...')
        serverProcess.kill('SIGTERM')
        serverProcess = null
      }
      const pid = await readPid()
      if (pid && isProcessAlive(pid)) {
        console.log(`kitten-tts: killing server pid ${pid}...`)
        try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
      }
      serverAvailable = false
    },
  }
}
