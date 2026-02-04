import { useState, useEffect, useCallback } from 'react'
import { render, Box, Text, useInput, useApp, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { ServerMessage } from '../server/types.ts'

const SERVER_URL = process.env.TOEBEANS_SERVER ?? 'ws://localhost:3000/ws'
const HTTP_URL = SERVER_URL.replace('ws://', 'http://').replace('/ws', '')

const MAX_CONTEXT_TOKENS = 200000 // claude's context window

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  isStreaming?: boolean
}

interface ToolStatus {
  name: string
  status: 'running' | 'done' | 'error'
}

interface SessionInfo {
  id: string
  createdAt: string
  lastActiveAt: string
}

interface DebugInfo {
  sessionId: string
  system: string
  messages: unknown[]
  tools: { name: string; description: string }[]
  stats: {
    messageCount: number
    systemLength: number
    toolCount: number
    estimatedTokens: number
  }
}

async function getNewSession(): Promise<string> {
  const resp = await fetch(`${HTTP_URL}/session/new`)
  const data = (await resp.json()) as { sessionId: string }
  return data.sessionId
}

async function getSessions(): Promise<SessionInfo[]> {
  const resp = await fetch(`${HTTP_URL}/sessions`)
  return (await resp.json()) as SessionInfo[]
}

interface ServerContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  content?: string
}

interface ServerSessionMessage {
  role: 'user' | 'assistant'
  content: ServerContentBlock[]
}

async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const resp = await fetch(`${HTTP_URL}/session/${sessionId}/messages`)
  const serverMessages = (await resp.json()) as ServerSessionMessage[]

  const messages: Message[] = []
  for (const msg of serverMessages) {
    // extract text content
    const textParts = msg.content
      .filter((b): b is ServerContentBlock & { text: string } => b.type === 'text' && !!b.text)
      .map(b => b.text)

    if (textParts.length > 0) {
      messages.push({
        id: nextMsgId(),
        role: msg.role,
        content: textParts.join('\n'),
      })
    }
  }
  return messages
}

function StatusBar({
  connected,
  sessionId,
  usage,
  contextPercent,
}: {
  connected: boolean
  sessionId: string | null
  usage: { input: number; output: number; cacheRead?: number } | null
  contextPercent: number
}) {
  const contextColor = contextPercent > 80 ? 'red' : contextPercent > 50 ? 'yellow' : 'green'

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={connected ? 'green' : 'red'}>
          {connected ? '●' : '○'}
        </Text>
        <Text color="gray"> </Text>
        {sessionId && (
          <Text color="gray" dimColor>
            {sessionId}
          </Text>
        )}
      </Box>
      <Box>
        {usage && (
          <Text color="gray" dimColor>
            {usage.input}↓ {usage.output}↑
            {usage.cacheRead ? ` ${usage.cacheRead}⚡` : ''}
            {'  '}
          </Text>
        )}
        <Text color={contextColor}>{contextPercent}%</Text>
        <Text color="gray" dimColor> ctx</Text>
      </Box>
    </Box>
  )
}

function MessageView({ message }: { message: Message }) {
  const color = message.role === 'user' ? 'blue' : message.role === 'system' ? 'yellow' : undefined
  const prefix = message.role === 'user' ? '› ' : message.role === 'system' ? '! ' : '  '

  return (
    <Box>
      <Text color={color}>{prefix}</Text>
      <Text wrap="wrap">
        {message.content}
        {message.isStreaming && <Text color="gray">▋</Text>}
      </Text>
    </Box>
  )
}

function ToolIndicator({ tool }: { tool: ToolStatus }) {
  const icon = tool.status === 'running' ? '◐' : tool.status === 'done' ? '✓' : '✗'
  const color = tool.status === 'running' ? 'yellow' : tool.status === 'done' ? 'green' : 'red'

  return (
    <Text color={color}>
      {'  '}{icon} {tool.name}
    </Text>
  )
}

function SessionPicker({
  sessions,
  selectedIndex,
  onSelect,
  onCancel,
}: {
  sessions: SessionInfo[]
  selectedIndex: number
  onSelect: (session: SessionInfo) => void
  onCancel: () => void
}) {
  useInput((char, key) => {
    if (key.upArrow) {
      // handled in parent
    } else if (key.downArrow) {
      // handled in parent
    } else if (key.return) {
      if (sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex])
      }
    } else if (key.escape || (key.ctrl && char === 'p')) {
      onCancel()
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Text color="cyan" bold>Sessions (↑↓ enter esc)</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.slice(0, 10).map((session, i) => {
          const isSelected = i === selectedIndex
          const date = new Date(session.lastActiveAt)
          const timeAgo = getTimeAgo(date)

          return (
            <Box key={session.id}>
              <Text color={isSelected ? 'cyan' : undefined} inverse={isSelected}>
                {isSelected ? '› ' : '  '}
                {session.id}
              </Text>
              <Text color="gray" dimColor>
                {'  '}{timeAgo}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            [n] new session
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

function getTimeAgo(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

let msgIdCounter = 0
function nextMsgId() {
  return `msg-${++msgIdCounter}`
}

function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [usage, setUsage] = useState<{ input: number; output: number; cacheRead?: number } | null>(null)
  const [totalTokens, setTotalTokens] = useState(0)
  const [currentTool, setCurrentTool] = useState<ToolStatus | null>(null)
  const [isWaiting, setIsWaiting] = useState(false)
  const [scrollOffset, setScrollOffset] = useState(0)

  // session picker state
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0)
  const [suppressNextInput, setSuppressNextInput] = useState(false)

  const height = stdout?.rows ?? 24
  const messageAreaHeight = height - 4 // input + status

  const contextPercent = Math.min(100, Math.round((totalTokens / MAX_CONTEXT_TOKENS) * 100))

  // connect to server
  useEffect(() => {
    const connect = async () => {
      const socket = new WebSocket(SERVER_URL)

      socket.onopen = async () => {
        setConnected(true)
        const sid = await getNewSession()
        setSessionId(sid)
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: sid }))
      }

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerMessage

        switch (msg.type) {
          case 'text':
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + msg.text },
                ]
              }
              return [
                ...prev,
                { id: nextMsgId(), role: 'assistant', content: msg.text, isStreaming: true },
              ]
            })
            break

          case 'tool_use':
            setCurrentTool({ name: msg.name, status: 'running' })
            break

          case 'tool_result':
            setCurrentTool((t) => (t ? { ...t, status: msg.is_error ? 'error' : 'done' } : null))
            setTimeout(() => setCurrentTool(null), 1000)
            break

          case 'done':
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last?.isStreaming) {
                return [...prev.slice(0, -1), { ...last, isStreaming: false }]
              }
              return prev
            })
            setUsage({ input: msg.usage.input, output: msg.usage.output, cacheRead: msg.usage.cacheRead })
            setTotalTokens((t) => t + msg.usage.input + msg.usage.output)
            setIsWaiting(false)
            setCurrentTool(null)
            break

          case 'error':
            setMessages((prev) => [
              ...prev,
              { id: nextMsgId(), role: 'system', content: `error: ${msg.message}` },
            ])
            setIsWaiting(false)
            setCurrentTool(null)
            break
        }
      }

      socket.onclose = () => {
        setConnected(false)
        setTimeout(connect, 2000)
      }

      setWs(socket)
    }

    connect()

    return () => {
      ws?.close()
    }
  }, [])

  const switchToSession = useCallback(async (sid: string, loadHistory = true) => {
    if (!ws) return
    setSessionId(sid)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }))
    setShowSessionPicker(false)

    if (loadHistory) {
      const history = await getSessionMessages(sid)
      setMessages(history)
      // estimate tokens from history
      const estimatedTokens = history.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
      setTotalTokens(estimatedTokens)
    } else {
      setMessages([])
      setTotalTokens(0)
    }
    setUsage(null)
  }, [ws])

  const openSessionPicker = useCallback(async () => {
    const sessionList = await getSessions()
    setSessions(sessionList)
    setSelectedSessionIndex(0)
    setShowSessionPicker(true)
  }, [])

  const sendMessage = useCallback(() => {
    if (!input.trim() || !ws || !sessionId || isWaiting) return

    const trimmed = input.trim()

    // handle commands
    if (trimmed === '/quit' || trimmed === '/exit') {
      exit()
      return
    }

    if (trimmed === '/new') {
      getNewSession().then((sid) => switchToSession(sid, false))
      setInput('')
      return
    }

    if (trimmed === '/clear') {
      setMessages([])
      setInput('')
      return
    }

    if (trimmed === '/sessions') {
      getSessions().then((sessionList) => {
        const lines = sessionList.slice(0, 20).map((s) => {
          const timeAgo = getTimeAgo(new Date(s.lastActiveAt))
          const current = s.id === sessionId ? ' (current)' : ''
          return `  ${s.id}  ${timeAgo}${current}`
        })
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId(), role: 'system', content: `sessions:\n${lines.join('\n')}` },
        ])
      })
      setInput('')
      return
    }

    if (trimmed === '/debug') {
      if (!sessionId) {
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId(), role: 'system', content: 'no session' },
        ])
        setInput('')
        return
      }
      fetch(`${HTTP_URL}/debug/${sessionId}`)
        .then((r) => r.json() as Promise<DebugInfo>)
        .then((data) => {
          const toolList = data.tools.map((t) => `  - ${t.name}`).join('\n')
          const content = [
            `=== session: ${data.sessionId} ===`,
            '',
            `messages: ${data.stats.messageCount}`,
            `system prompt: ${data.stats.systemLength} chars`,
            `tools: ${data.stats.toolCount}`,
            `estimated tokens: ~${data.stats.estimatedTokens}`,
            '',
            '=== tools ===',
            toolList,
            '',
            '=== system prompt ===',
            data.system.slice(0, 500) + (data.system.length > 500 ? '...' : ''),
          ].join('\n')
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId(), role: 'system', content },
          ])
        })
        .catch((err) => {
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId(), role: 'system', content: `debug error: ${err}` },
          ])
        })
      setInput('')
      return
    }

    if (trimmed.startsWith('/')) {
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: 'system', content: 'commands: /new /clear /sessions /debug /quit' },
      ])
      setInput('')
      return
    }

    // send to server
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'user', content: trimmed }])
    ws.send(JSON.stringify({ type: 'message', sessionId, content: trimmed }))
    setIsWaiting(true)
    setInput('')
    setScrollOffset(0)
  }, [input, ws, sessionId, isWaiting, exit, switchToSession])

  // global key handlers
  useInput((char, key) => {
    if (showSessionPicker) {
      if (key.upArrow) {
        setSelectedSessionIndex((i) => Math.max(0, i - 1))
      } else if (key.downArrow) {
        setSelectedSessionIndex((i) => Math.min(sessions.length - 1, i + 1))
      } else if (key.return) {
        if (sessions[selectedSessionIndex]) {
          switchToSession(sessions[selectedSessionIndex].id)
        }
      } else if (char === 'n') {
        getNewSession().then((sid) => switchToSession(sid, false))
      } else if (key.escape || (key.ctrl && char === 'p')) {
        setShowSessionPicker(false)
      }
      return
    }

    if (key.ctrl && char === 'p') {
      setSuppressNextInput(true)
      openSessionPicker()
      return
    }

    if (key.pageUp || (key.ctrl && char === 'u')) {
      setScrollOffset((o) => Math.min(o + 5, Math.max(0, messages.length - 3)))
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - 5))
    }
    if ((key.escape || (key.ctrl && char === 'd')) && !showSessionPicker) {
      exit()
    }
  })

  // calculate visible messages
  const visibleMessages = messages.slice(
    Math.max(0, messages.length - messageAreaHeight - scrollOffset),
    messages.length - scrollOffset || undefined
  )

  return (
    <Box flexDirection="column" height={height}>
      {/* message area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden" justifyContent="flex-end">
        {visibleMessages.map((msg) => (
          <MessageView key={msg.id} message={msg} />
        ))}
        {currentTool && <ToolIndicator tool={currentTool} />}
        {isWaiting && !currentTool && messages[messages.length - 1]?.role !== 'assistant' && (
          <Text color="gray">{'  '}thinking...</Text>
        )}
      </Box>

      {scrollOffset > 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            ↑ {scrollOffset} more
          </Text>
        </Box>
      )}

      {/* session picker overlay */}
      {showSessionPicker && (
        <Box position="absolute" marginTop={2} marginLeft={2}>
          <SessionPicker
            sessions={sessions}
            selectedIndex={selectedSessionIndex}
            onSelect={(s) => switchToSession(s.id)}
            onCancel={() => setShowSessionPicker(false)}
          />
        </Box>
      )}

      {/* status bar */}
      <StatusBar
        connected={connected}
        sessionId={sessionId}
        usage={usage}
        contextPercent={contextPercent}
      />

      {/* input */}
      <Box borderStyle="round" borderColor={isWaiting ? 'gray' : 'cyan'} paddingX={1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={input}
          onChange={(val) => {
            if (suppressNextInput) {
              setSuppressNextInput(false)
              return
            }
            setInput(val)
          }}
          onSubmit={sendMessage}
          placeholder={isWaiting ? 'waiting...' : showSessionPicker ? '' : 'ctrl+p sessions'}
          focus={!showSessionPicker}
        />
      </Box>
    </Box>
  )
}

render(<App />)
