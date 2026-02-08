import * as readline from 'readline'
import type { ServerMessage } from '../server/types.ts'
import { loadConfig } from '../server/config.ts'

async function getServerUrl(): Promise<string> {
  if (process.env.TOEBEANS_SERVER) {
    return process.env.TOEBEANS_SERVER
  }
  const config = await loadConfig()
  return `ws://localhost:${config.server.port}/ws`
}

let SERVER_URL: string
let HTTP_URL: string

interface State {
  sessionId: string | null
  ws: WebSocket | null
  rl: readline.Interface | null
  pendingResponse: boolean
}

const state: State = {
  sessionId: null,
  ws: null,
  rl: null,
  pendingResponse: false,
}

async function getNewSession(): Promise<string> {
  const resp = await fetch(`${HTTP_URL}/session/new`)
  const data = await resp.json() as { sessionId: string }
  return data.sessionId
}

function connect() {
  console.log(`connecting to ${SERVER_URL}...`)

  const ws = new WebSocket(SERVER_URL)

  ws.onopen = async () => {
    console.log('connected!')

    if (!state.sessionId) {
      state.sessionId = await getNewSession()
      console.log(`session: ${state.sessionId}`)
    }

    ws.send(JSON.stringify({ type: 'subscribe', sessionId: state.sessionId }))
    showPrompt()
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage

    switch (msg.type) {
      case 'text':
        process.stdout.write(msg.text)
        break

      case 'tool_use':
        console.log(`\n[tool: ${msg.name}]`)
        break

      case 'tool_result': {
        const contentStr = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('\n')
        if (msg.is_error) {
          console.log(`\n[error: ${contentStr.slice(0, 100)}...]`)
        } else {
          const hasImages = Array.isArray(msg.content) && msg.content.some(b => b.type === 'image')
          const preview = contentStr.length > 100
            ? contentStr.slice(0, 100) + '...'
            : contentStr
          console.log(`\n[result: ${preview}]${hasImages ? ' (+ image)' : ''}`)
        }
        break
      }

      case 'done':
        console.log(`\n[tokens: ${msg.usage.input}↓ ${msg.usage.output}↑` +
          (msg.usage.cacheRead ? ` ${msg.usage.cacheRead}⚡` : '') +
          (msg.usage.cacheWrite ? ` ${msg.usage.cacheWrite}💾` : '') +
          ']')
        state.pendingResponse = false
        showPrompt()
        break

      case 'error':
        console.error(`\n[error: ${msg.message}]`)
        state.pendingResponse = false
        showPrompt()
        break
    }
  }

  ws.onclose = () => {
    console.log('\ndisconnected from server')
    state.ws = null
    // try to reconnect after a delay
    setTimeout(connect, 2000)
  }

  ws.onerror = (err) => {
    console.error('websocket error:', err)
  }

  state.ws = ws
}

function showPrompt() {
  if (state.rl && !state.pendingResponse) {
    state.rl.prompt()
  }
}

function handleInput(line: string) {
  const input = line.trim()

  if (!input) {
    showPrompt()
    return
  }

  if (input === '/quit' || input === '/exit') {
    console.log('bye!')
    process.exit(0)
  }

  if (input === '/new') {
    getNewSession().then(id => {
      state.sessionId = id
      console.log(`new session: ${id}`)
      if (state.ws) {
        state.ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }))
      }
      showPrompt()
    })
    return
  }

  if (input === '/session') {
    console.log(`current session: ${state.sessionId}`)
    showPrompt()
    return
  }

  if (input === '/debug') {
    if (!state.sessionId) {
      console.log('no session')
      showPrompt()
      return
    }
    fetch(`${HTTP_URL}/debug/${state.sessionId}`)
      .then(r => r.json())
      .then((data: { system: string; messages: unknown[]; tools: { name: string }[]; stats: { messageCount: number; systemLength: number; toolCount: number; estimatedTokens: number } }) => {
        console.log('\n=== SYSTEM PROMPT ===')
        console.log(data.system)
        console.log('\n=== MESSAGES ===')
        console.log(JSON.stringify(data.messages, null, 2))
        console.log('\n=== TOOLS ===')
        for (const t of data.tools) {
          console.log(`- ${t.name}`)
        }
        console.log('\n=== STATS ===')
        console.log(`messages: ${data.stats.messageCount}`)
        console.log(`system length: ${data.stats.systemLength} chars`)
        console.log(`tools: ${data.stats.toolCount}`)
        console.log(`estimated tokens: ~${data.stats.estimatedTokens}`)
        showPrompt()
      })
      .catch(err => {
        console.error('debug error:', err)
        showPrompt()
      })
    return
  }

  if (input.startsWith('/')) {
    console.log('unknown command. available: /new, /session, /debug, /quit')
    showPrompt()
    return
  }

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.log('not connected to server')
    showPrompt()
    return
  }

  state.pendingResponse = true
  state.ws.send(JSON.stringify({
    type: 'message',
    sessionId: state.sessionId,
    content: input,
  }))
}

async function main() {
  SERVER_URL = await getServerUrl()
  HTTP_URL = SERVER_URL.replace('ws://', 'http://').replace('/ws', '')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  state.rl = rl

  rl.on('line', handleInput)

  rl.on('close', () => {
    console.log('\nbye!')
    process.exit(0)
  })

  console.log('toebeans cli')
  console.log('commands: /new, /session, /debug, /quit')
  console.log('')

  connect()
}

main()
