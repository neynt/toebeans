import type { Tool, ToolResult } from '../../server/types'
import { openSync, read, writeSync, closeSync, mkdirSync } from 'node:fs'

// Protocol constants (match teensy firmware)
const MSG_AUDIO = 0x01
const MSG_EVENT = 0x02

const PLUGIN_NAME = 'teensy-embodiment'
const DATA_DIR = `${process.env.HOME}/.toebeans/${PLUGIN_NAME}`

interface TeensyConfig {
  serialPort?: string
}

interface Plugin {
  name: string
  description: string
  tools: Tool[]
  init: (config: unknown) => Promise<void>
  destroy: () => Promise<void>
  buildSystemPrompt: () => string
}

export default function create(): Plugin {
  let config: TeensyConfig = {}
  let audioWriter: { write(data: Uint8Array): void; end(): void } | null = null
  let recording = false
  let recordingPath = ''
  let serialFd: number | null = null
  let readerRunning = false
  let audioFrameCount = 0

  function getSerialPort(): string {
    return config.serialPort || '/dev/ttyACM0'
  }

  function audioDir(): string {
    const dir = `${DATA_DIR}/audio`
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async function startReader() {
    const portPath = getSerialPort()
    console.log(`[${PLUGIN_NAME}] opening serial port: ${portPath}`)

    Bun.spawnSync(['stty', '-F', portPath, '115200', 'raw', '-echo', '-echoe', '-echok'])

    try {
      serialFd = openSync(portPath, 'r+')
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] failed to open ${portPath}:`, err)
      return
    }

    console.log(`[${PLUGIN_NAME}] serial port opened (fd=${serialFd})`)
    readerRunning = true

    let buffer = Buffer.alloc(0)
    const readBuf = Buffer.alloc(4096)

    function readAsync(fd: number, buf: Buffer): Promise<number> {
      return new Promise((resolve, reject) => {
        read(fd, buf, 0, buf.length, null, (err, bytesRead) => {
          if (err) reject(err)
          else resolve(bytesRead)
        })
      })
    }

    while (readerRunning) {
      try {
        const bytesRead = await readAsync(serialFd, readBuf)
        if (bytesRead > 0) {
          buffer = Buffer.concat([buffer, readBuf.subarray(0, bytesRead)])

          while (buffer.length > 0) {
            const type = buffer[0]

            if (type === MSG_AUDIO) {
              if (buffer.length < 3) break
              const len = buffer[1] | (buffer[2] << 8)
              if (buffer.length < 3 + len) break
              const audioData = buffer.subarray(3, 3 + len)
              buffer = buffer.subarray(3 + len)

              audioFrameCount++
              if (audioFrameCount === 1) {
                console.log(`[${PLUGIN_NAME}] receiving audio data`)
              }

              if (recording && audioWriter) {
                audioWriter.write(new Uint8Array(audioData))
              }
            } else if (type === MSG_EVENT) {
              const nlIdx = buffer.indexOf(0x0a)
              if (nlIdx === -1) break
              const json = buffer.subarray(1, nlIdx).toString('utf-8')
              buffer = buffer.subarray(nlIdx + 1)
              console.log(`[${PLUGIN_NAME}] event: ${json}`)
            } else {
              buffer = buffer.subarray(1)
            }
          }
        }
      } catch (err: any) {
        console.error(`[${PLUGIN_NAME}] read error:`, err)
        break
      }
    }
  }

  function sendCommand(json: string) {
    if (!serialFd) return
    try {
      const data = Buffer.from(json + '\n', 'utf-8')
      writeSync(serialFd, data)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] write error:`, err)
    }
  }

  const tools: Tool[] = [
    {
      name: 'kanoko_display',
      description: 'Display text on the kanoko rect LCD screen',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to display on the LCD' },
        },
        required: ['text'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { text } = input as { text: string }
        sendCommand(JSON.stringify({ cmd: 'display', text }))
        return { content: `displayed: ${text}` }
      },
    },
    {
      name: 'kanoko_record',
      description: 'Start recording audio from the kanoko microphone. Saves PCM to a file.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Output filename (without extension)' },
        },
        required: ['filename'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { filename } = input as { filename: string }
        const dir = audioDir()
        recordingPath = `${dir}/${filename}.raw`
        const writer = Bun.file(recordingPath).writer()
        audioWriter = {
          write(data: Uint8Array) { writer.write(data) },
          end() { writer.end() },
        }
        recording = true
        return { content: `recording to ${recordingPath} (44100Hz 16-bit signed LE mono)` }
      },
    },
    {
      name: 'kanoko_stop_record',
      description: 'Stop recording audio from the kanoko microphone',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<ToolResult> {
        if (!recording) {
          return { content: 'not currently recording', is_error: true }
        }
        recording = false
        if (audioWriter) {
          audioWriter.end()
          audioWriter = null
        }
        const stat = Bun.file(recordingPath)
        const size = stat.size
        const duration = (size / 2 / 44100).toFixed(1)
        return { content: `stopped recording. saved ${recordingPath} (${duration}s, ${size} bytes)` }
      },
    },
  ]

  return {
    name: PLUGIN_NAME,
    description: 'teensy 4.1 hardware interface — LCD displays, microphone, speaker',
    tools,

    async init(cfg: unknown) {
      config = (cfg as TeensyConfig) || {}
      mkdirSync(DATA_DIR, { recursive: true })
      startReader()
    },

    async destroy() {
      readerRunning = false
      recording = false
      if (audioWriter) {
        audioWriter.end()
        audioWriter = null
      }
      if (serialFd !== null) {
        try { closeSync(serialFd) } catch {}
        serialFd = null
      }
    },

    buildSystemPrompt() {
      return `kanoko hardware is connected. you can display text on the LCD with kanoko_display and record audio with kanoko_record/kanoko_stop_record. audio is saved as raw 16-bit signed LE mono PCM at 44100Hz.`
    },
  }
}
