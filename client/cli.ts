import * as readline from 'readline'
import type { ServerMessage } from '../server/types.ts'

const SERVER_URL = process.env.TOEBEANS_SERVER ?? 'ws://localhost:3000/ws'
const HTTP_URL = SERVER_URL.replace('ws://', 'http://').replace('/ws', '')

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

      case 'tool_result':
        if (msg.is_error) {
          console.log(`\n[error: ${msg.content.slice(0, 100)}...]`)
        } else {
          const preview = msg.content.length > 100
            ? msg.content.slice(0, 100) + '...'
            : msg.content
          console.log(`\n[result: ${preview}]`)
        }
        break

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

  if (input.startsWith('/')) {
    console.log('unknown command. available: /new, /session, /quit')
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

function main() {
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
  console.log('commands: /new (new session), /session (show id), /quit')
  console.log('')

  connect()
}

main()
