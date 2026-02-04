# toebeans

AI agent harness with a unified plugin system. server/client architecture over WebSocket.

## quickstart

```bash
bun install

# terminal 1 - server
bun run server

# terminal 2 - client
bun run client
```

custom port:
```bash
PORT=3001 bun run server
TOEBEANS_SERVER=ws://localhost:3001/ws bun run client
```

## architecture

```
┌─────────────────────────────────────────────────┐
│                   server                        │
│  ┌───────────┐  ┌───────────┐  ┌─────────────┐ │
│  │  plugins  │◄─│   agent   │◄─│  llm        │ │
│  │           │  │   loop    │  │  provider   │ │
│  └───────────┘  └───────────┘  └─────────────┘ │
│         ▲              │                       │
│         │         websocket                    │
└─────────┼──────────────┼───────────────────────┘
          │              │
   channel inputs      ┌─┴─┐
   (discord, etc)      │ws │
                       └─┬─┘
                         │
              ┌──────────┴──────────┐
              │       clients       │
              │  (cli, web, etc)    │
              └─────────────────────┘
```

### core components

- **server** (`server/`) - websocket server, agent loop, plugin manager
- **client** (`client/`) - CLI that connects over websocket
- **providers** (`providers/`) - LLM provider implementations (currently anthropic)
- **plugins** (`plugins/`) - tools and capabilities

## plugins

plugins provide tools, system prompt injections, and lifecycle hooks. they have three states:

| state | tools available | system prompt contribution |
|-------|-----------------|---------------------------|
| `dormant` | no | nothing |
| `visible` | no | one-line summary |
| `loaded` | yes | full description |

the agent can call `load_plugin("name")` to promote a visible plugin to loaded.

### built-in plugins

| plugin | purpose |
|--------|---------|
| `tools` | bash, read, write, glob, grep |
| `memory` | persistent knowledge storage (remember/recall) |
| `core` | `load_plugin` tool for plugin management |
| `write-plugin` | runtime plugin creation |
| `discord` | discord bot integration |

### plugin interface

```typescript
interface Plugin {
  name: string
  summary?: string        // shown when visible
  description?: string    // shown when loaded
  tools?: Tool[]

  // lifecycle hooks
  on?: {
    'message:in'?: (msg: Message) => Message
    'message:out'?: (msg: Message) => Message
    'agent:start'?: (session: Session) => void
    'agent:end'?: (session: Session, result: AgentResult) => void
  }

  // for channel plugins (discord, etc) - yields incoming messages
  input?: AsyncIterable<{ sessionId: string; message: Message }>

  init?: (config: unknown) => void | Promise<void>
  destroy?: () => void | Promise<void>
}
```

## data storage

all user data lives in `~/.local/share/toebeans/`:

```
~/.local/share/toebeans/
├── config.json      # plugin config
├── sessions/        # message history (JSONL)
├── knowledge/       # memory plugin storage
└── plugins/         # user-installed plugins
```

## configuration

`config.json` specifies which plugins to load and their states:

```json
{
  "plugins": {
    "tools": { "state": "loaded" },
    "memory": { "state": "visible" },
    "discord": {
      "state": "loaded",
      "config": {
        "token": "...",
        "channels": ["123456789"],
        "respondToMentions": true
      }
    }
  }
}
```

## llm providers

providers implement the streaming interface for different LLM backends:

```typescript
interface LlmProvider {
  name: string
  stream(params: {
    messages: Message[]
    system: string
    tools: ToolDef[]
  }): AsyncIterable<StreamChunk>
}
```

currently only anthropic is implemented (`claude-sonnet-4-20250514` by default).

## environment variables

| var | purpose |
|-----|---------|
| `ANTHROPIC_API_KEY` | anthropic API key |
| `PORT` | server port (default: 3000) |
| `TOEBEANS_SERVER` | client websocket URL |
