# toebeans

AI agent harness with unified plugin system. Server/client architecture over WebSocket.

## Running

```bash
# start server (default port 3000)
bun run server

# start CLI client
bun run cli

# debug tools
bun run debug <command>

# or with custom port
PORT=3001 bun run server
TOEBEANS_SERVER=ws://localhost:3001/ws bun run cli
```

## Data location

All user data is stored in `~/.toebeans/`:
- `config.json` - plugin config, session settings
- `sessions/` - session message history (JSONL)
- `knowledge/` - markdown memory files
- `plugins/` - user-installed plugins

## Architecture

- `server/` - WebSocket server, agent loop, plugin system
- `cli/` - CLI client and debug tools
- `llm-providers/` - LLM provider implementations (anthropic)
- `plugins/` - built-in plugins

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads .env, so don't use dotenv.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`command` instead of execa.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
