# toebeans

AI agent harness with unified plugin system. Server/client architecture over WebSocket, built on Bun.

## Bun

Use Bun everywhere — `bun run server`, `bun test`, `bun install`, `bunx`.
Bun auto-loads `.env`; prefer `Bun.file` over `node:fs`; use `Bun.$\`cmd\`` instead of execa.
Bun API docs: `node_modules/bun-types/docs/**.mdx`.

## Commands

```bash
bun run server            # WebSocket server (default port 3000)
bun run cli               # interactive REPL client
bun run dashboard         # status dashboard
bun run debug <cmd>       # print-system, print-tools, list-sessions,
                          # print-llm-query <id>, tail-session <id>, tail-all-sessions
bun test                  # all tests
bun test path/to/file.ts  # specific file
```

Debug endpoints (while server running): `/debug/system`, `/debug/tools`, `/debug/{sessionId}`, `/sessions`, `/session/{id}/messages`.

## Architecture

```
server/
  index.ts           — entry point: config → plugins → WS server
  agent.ts           — runAgentTurn(): LLM stream → tool loop, abort, message repair
  session.ts         — JSONL session storage + compaction
  session-manager.ts — per-route session routing, compaction triggers
  plugin.ts          — PluginManager: discover, load, wire plugins
  config.ts          — Zod schema for config.json5
  context.ts         — ToolContext interface passed to tool execute()
  llm-provider.ts    — LlmProvider interface (stream-based)
  types.ts           — Message, ContentBlock, Tool, ServerMessage, etc.
  cost.ts            — per-message cost computation
  tokens.ts          — token estimation (~4 chars/token, image dimensions)
  dashboard-html.ts  — HTML status dashboard renderer
  services/          — STT/TTS integration over unix sockets
  paths.ts, pidfile.ts, time.ts, debug-log.ts — small utilities

cli/
  cli.ts             — WebSocket REPL (/new, /session, /debug, /quit)
  debug.ts           — debug subcommand dispatch

llm-providers/
  anthropic.ts       — prompt caching (system, tools, 2nd-from-last msg), effort param
  openai-compatible.ts — base class for OpenAI-compatible providers
  moonshot.ts        — Kimi etc. (extends openai-compatible)
  chatgpt-codex.ts   — ChatGPT Codex provider

plugins/             — built-in plugins (each is name/index.ts)
skills/              — skill definitions
default-config/      — config.json5, USER.md, SOUL.md templates
```

## Plugin system

Plugin interface (`server/plugin.ts`):
- `name`, `description` — identity
- `tools` — tool definitions with `execute(input, context)`
- `input` / `output` — async channel I/O (discord, CLI, etc.)
- `buildSystemPrompt()` — contribute to system prompt each turn
- `status()` — report plugin status and active tasks
- `onPreCompaction(context)` — hook before session compaction
- `init(config)` / `destroy()` — lifecycle

Loading: `~/.toebeans/plugins/{name}/` overrides `plugins/{name}/`.
Enabled by key in `config.json5 → plugins`.

**When you modify a plugin, update its README (`plugins/{name}/README.md`) too.**

### Local-only plugins

**teensy-embodiment** lives only in `~/.toebeans/plugins/teensy-embodiment/` — do NOT create `plugins/teensy-embodiment/` in this repo (plugin loader shadowing).

## Runtime data (`~/.toebeans/`)

| Path | Contents |
|------|----------|
| `config.json5` | Server port, LLM settings, per-plugin config |
| `sessions/` | JSONL: `{route}-{date}-{NNNN}.jsonl` |
| `memory/` | `USER.md`, `{YYYY-MM-DD}.md` compaction logs, custom `.md` |
| `plugins/` | User plugin overrides |
| `bash/` | `bash_spawn` background process logs |
| `browser-sessions/` | Persistent Patchright browser user data dirs |
| `claude-code/` | Claude Code session logs, `pending.json` |
| `timers/` | Timer definitions (markdown) |
| `workspace/` | Working directory for agent tasks |
| `secrets/` | API keys |
| `resume.json` | Last outputTarget for auto-resume after `restart_server` |

## Key patterns

- **Session routing**: each channel/DM/WS gets its own session via route string.
- **Compaction**: triggers at `compactAtTokens` (80k) or after `lifespanSeconds` (1h) if above `compactMinTokens` (5k). Summarizes history and starts a new session file.
- **Message repair** (`agent.ts`): merges consecutive assistant messages, inserts synthetic tool_results for interrupted calls, reorders wedged user messages. Important for understanding "impossible" message states.
- **Tool result limits**: `maxToolResultChars` (50k), `maxToolResultTokens` (10k).
- **Abort**: `/stop` → AbortController → propagates to LLM stream + `ToolContext.abortSignal`.
- **Queued messages**: messages arriving mid-turn are queued, drained before next LLM call.
- **Prompt caching** (Anthropic): system prompt, tools, 2nd-from-last message. ~90% cost savings.

## Tests

Key test files: `server/agent.test.ts` (message repair, concurrent races, abort), `server/cost.test.ts`, `server/session-entries.test.ts`, `plugins/browser/upload-file.test.ts`, `plugins/browser/download.test.ts`.
