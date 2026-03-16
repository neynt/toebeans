# toebeans

AI agent harness with unified plugin system. Server/client architecture over WebSocket.

## Bun

Use Bun everywhere — `bun run server`, `bun test`, `bun install`, `bunx`.
Bun auto-loads `.env`; prefer `Bun.file` over `node:fs`; use `Bun.$\`cmd\`` instead of execa.
Bun API docs live in `node_modules/bun-types/docs/**.mdx`.

## Running & debugging

```bash
bun run server          # WebSocket server (default port 3000)
bun run cli             # interactive REPL client
bun run debug <cmd>     # print-system, print-tools, list-sessions,
                        # print-llm-query <id>, tail-session <id>, tail-all-sessions
bun test                # run all tests
```

HTTP debug endpoints (while server is running):
- `GET /debug/system` — current system prompt
- `GET /debug/tools` — all tools grouped by plugin
- `GET /debug/{sessionId}` — full session debug payload (messages, tools, token estimate)
- `GET /sessions`, `GET /session/{id}/messages`

## Architecture

```
server/
  index.ts        — entry point: loads config, inits plugins, starts WS server
  agent.ts        — runAgentTurn(): LLM stream → tool execution loop, abort handling,
                    message repair (concurrent races, interrupted tool calls),
                    queued-message drain, cost tracking
  session.ts      — JSONL session storage, compaction (summarise + new session)
  session-manager.ts — per-route session routing, lifespan/token-based compaction triggers
  plugin.ts       — PluginManager: discovers, loads, and wires plugins
  config.ts       — Zod schema for ~/.toebeans/config.json5
  llm-provider.ts — LlmProvider interface (stream-based)
  types.ts        — Message, ContentBlock, Tool, ServerMessage, etc.
  tokens.ts       — token estimation (~4 chars/token, image dimension parsing)

cli/
  cli.ts          — WebSocket REPL (/new, /session, /debug, /quit)
  debug.ts        — CLI debug subcommands (see above)

llm-providers/
  anthropic.ts    — prompt caching (system, tools, 2nd-from-last msg), effort param
  moonshot.ts     — OpenAI-compatible providers (Kimi, etc.)
  chatgpt-codex.ts

plugins/          — built-in plugins (each is name/index.ts exporting Plugin or factory)
skills/           — skill templates (agentskills.io)
default-config/   — default config.json5 template
```

## Plugin system

Plugin interface (`server/plugin.ts`):
- `tools` — tool definitions with `execute(input, context)`
- `input` / `output` — async channel I/O (discord, CLI, etc.)
- `buildSystemPrompt()` — contribute to system prompt each turn
- `onPreCompaction(context)` — hook before session compaction
- `init(config)` / `destroy()` — lifecycle

Loading order: `~/.toebeans/plugins/{name}/` overrides `plugins/{name}/`.
Plugins are enabled by having a key in `config.json5 → plugins`.

**When you modify a plugin, update its README (`plugins/{name}/README.md`) too.**

### Local-only plugins

Some plugins are hardware-specific and live only in `~/.toebeans/plugins/`, not in this repo:

- **teensy-embodiment** — Teensy 4.1 hardware interface (LCD, mic, speaker). Lives in `~/.toebeans/plugins/teensy-embodiment/` with its own firmware, `index.ts`, and docs. Do NOT add a `plugins/teensy-embodiment/` to this repo — the plugin loader would shadow the local copy or vice versa.

## Runtime data (`~/.toebeans/`)

| Path | Contents |
|------|----------|
| `config.json5` | All config: server port, LLM settings, per-plugin config |
| `sessions/` | JSONL files: `{route}-{date}-{NNNN}.jsonl` (system_prompt + message entries with cost) |
| `memory/` | `USER.md` (user profile), `{YYYY-MM-DD}.md` (daily logs from compaction), custom `.md` |
| `plugins/` | User-installed plugin overrides |
| `bash/` | `bash_spawn` background process logs |
| `browser-sessions/` | Persistent Patchright browser sessions (user data dirs) |
| `claude-code/` | Claude Code session logs, `pending.json` for cross-restart tracking |
| `timers/` | Timer definitions (markdown) |
| `workspace/` | Working directory for agent tasks |
| `secrets/` | Shared secrets/API keys |
| `resume.json` | Last outputTarget for auto-resume after `restart_server` |

## Key patterns

- **Session routing**: each channel/DM/WS connection gets its own session via route string. Compaction triggers at `compactAtTokens` (default 80k) or `lifespanSeconds` (default 1h) + `compactMinTokens` (5k).
- **Message repair** (`agent.ts`): merges consecutive assistant messages, inserts synthetic tool_results for interrupted calls, reorders wedged user messages. Important for understanding "impossible" message history states.
- **Tool results** are truncated at `maxToolResultChars` (50k) and `maxToolResultTokens` (10k).
- **Abort**: `/stop` → AbortController → propagates to LLM stream and `ToolContext.abortSignal`.
- **Queued messages**: messages arriving while session is busy are queued, drained before next LLM call.
- **Prompt caching** (Anthropic): auto-applied to system prompt, tools block, and 2nd-from-last message. ~90% cost reduction on cached content.

## Tests

```bash
bun test                    # all tests
bun test server/agent.test.ts  # specific file
```

Key test files: `server/agent.test.ts` (message repair, concurrent races, abort), `server/cost.test.ts`, `server/session-entries.test.ts`, `plugins/browser/upload-file.test.ts`.
