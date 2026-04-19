# Sub-Agents Plugin Design

## Goal

Let the main toebeans session spawn lightweight parallel sub-sessions that run the full agent loop (LLM + tools) asynchronously and notify the originating session on completion. Should feel like `spawn_claude_code` but without shelling out to a separate process — sub-agents are native toebeans sessions sharing the same server, plugins, and LLM provider.

## Why not just use Claude Code?

The `claude-code` plugin spawns an external process with its own context, tools, and billing. That's great for heavy isolated tasks but terrible for lightweight parallelism:

- **Cold start**: each CC session bootstraps a full Node process, re-reads the codebase, etc.
- **No shared state**: CC sessions can't see toebeans plugins, memory, or session history.
- **Cost**: each CC session builds its own system prompt and tool definitions from scratch.
- **Tool surface**: CC has its own tool set; sub-agents should use *toebeans* tools.

Sub-agents solve the "I need 3 quick things done in parallel" case without the overhead.

## Data Model

### Sub-Agent Session

A sub-agent is a regular toebeans session (`{route}-{date}-{NNNN}.jsonl`) with extra metadata. The route is derived from the parent:

```
sub-{parentSessionId}-{name}
```

This gives sub-agents their own session files, compaction lifecycle, and message history — all the existing session infrastructure works unchanged.

### Metadata File

Stored at `~/.toebeans/sub-agents/{subAgentId}.meta.json`:

```typescript
interface SubAgentMeta {
  subAgentId: string          // unique ID (nanoid or similar)
  name: string                // human-readable name from spawn call
  parentSessionId: string     // who spawned this
  parentOutputTarget?: string // where to send notifications
  sessionId: string           // the sub-agent's own session ID
  task: string                // initial prompt
  supplementarySystem?: string // extra system prompt content
  status: 'running' | 'completed' | 'failed' | 'aborted'
  startedAt: string           // ISO timestamp
  endedAt?: string
  error?: string
  toolsAllowed?: string[]     // optional allowlist (security)
  toolsDenied?: string[]      // optional denylist
  costTotal?: number          // accumulated cost
}
```

### Pending Tracking

`~/.toebeans/sub-agents/pending.json` — array of in-flight `subAgentId`s, same pattern as `claude-code/pending.json`. Used for crash recovery on server restart.

## Tool Surface

### `spawn_sub_agent`

```typescript
{
  name: 'spawn_sub_agent',
  description: 'Spawn a lightweight sub-agent that runs in parallel using toebeans tools.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short name for this sub-agent (used in notifications and listing).',
      },
      task: {
        type: 'string',
        description: 'The initial prompt/task for the sub-agent.',
      },
      supplementary_system: {
        type: 'string',
        description: 'Optional extra system prompt content prepended to the sub-agent\'s context.',
      },
      tools_allowed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional allowlist of tool names. If set, only these tools are available.',
      },
      tools_denied: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional denylist of tool names. These tools are excluded.',
      },
    },
    required: ['name', 'task'],
  },
}
```

Returns immediately with `{ subAgentId, sessionId, status: 'started' }`.

### `list_sub_agents`

List active and recent sub-agents with status, cost, and timing.

### `read_sub_agent_output`

Read the sub-agent's session messages (full or summary). Reuses `loadSession()` since it's a normal session.

### `abort_sub_agent`

Set the abort flag on a running sub-agent. Propagates through the same `AbortController` mechanism used by `/stop`.

## Execution Flow

### Spawning

```
1. Tool execute(): generate subAgentId, compute route & sessionId
2. Write meta file, add to pending.json
3. Build sub-agent system prompt:
   - Base system prompt (from buildSystemPrompt())
   - + supplementary_system if provided
   - + context block: "You are a sub-agent named '{name}', spawned by session {parentSessionId}.
     Complete the task and stop. Do not ask clarifying questions."
4. Filter tools (apply allowlist/denylist)
5. Fire-and-forget: run the agent loop (see below)
6. Return { subAgentId, sessionId, status: 'started' } to parent
```

### Agent Loop

The sub-agent runs `runAgentTurn()` directly — it's the same function the main session uses. Key difference: **no queued message drain** and **no interactive input**. The sub-agent gets one prompt and runs until the LLM stops calling tools.

```typescript
async function runSubAgent(meta: SubAgentMeta, tools: Tool[], system: string) {
  const abortController = new AbortController()
  activeSubAgents.set(meta.subAgentId, { meta, abortController })

  try {
    const result = await runAgentTurn(
      [{ type: 'text', text: meta.task }],
      {
        provider,
        system: () => system,
        tools: () => tools,
        sessionId: meta.sessionId,
        workingDir,
        model,
        onChunk: (chunk) => { /* optional: log streaming progress */ },
        abortSignal: abortController.signal,
        // no checkQueuedMessages — sub-agents don't accept follow-up input
        // no checkAbort callback — abort is via the AbortController
      },
    )

    meta.status = result.aborted ? 'aborted' : 'completed'
  } catch (err) {
    meta.status = 'failed'
    meta.error = String(err)
  } finally {
    meta.endedAt = new Date().toISOString()
    await writeMeta(meta)
    await removePending(meta.subAgentId)
    activeSubAgents.delete(meta.subAgentId)
    queueNotification(buildCompletionMessage(meta), meta.parentOutputTarget)
  }
}
```

### Notification

On completion, the plugin queues a message back to the parent session via the standard `input` async generator pattern (same as bash_spawn and claude-code):

```
[Sub-agent '{name}' {completed successfully | failed | was aborted}]
Task: {task preview}
Session: {sessionId}

Use read_sub_agent_output to review the full conversation.
```

The `parentOutputTarget` ensures the notification routes to the correct channel (Discord, CLI, etc.) even if the parent session has been compacted to a new ID in the meantime.

### Why This Works

The notification doesn't need to target the parent *session* — it targets the parent *route*. The server's `processSession()` resolves the route to whatever the current session ID is for that route. So even if the parent session compacted from `2026-03-20-0001` to `2026-03-20-0002`, the notification still lands in the right place.

## Lifecycle & Persistence

### Server Restart Recovery

On `init()`:
1. Read `pending.json` to get in-flight sub-agent IDs
2. For each, read meta file
3. If `status === 'running'` but the server restarted, mark as `failed` with error "server restarted during execution"
4. Queue notification to parent

Sub-agents can't be resumed after restart because the in-memory LLM conversation state is lost. This is a key difference from `claude-code` (which is a separate process that might survive the restart). The meta file and session JSONL persist, so the parent can still read the partial output.

### Compaction

Sub-agent sessions are short-lived and typically well under the compaction threshold. But if a sub-agent somehow runs long enough to trigger compaction, it works — `checkCompaction` is called on the session ID and the sub-agent continues on the new session. This requires wiring up `checkCompaction` after `runAgentTurn` returns, same as `processSession` does.

Actually, the simpler approach for v1: **skip compaction entirely for sub-agents**. They should be short tasks. If they hit 80k tokens, something is wrong and they should be aborted. Add a `maxTokens` config for sub-agents (default: 40k).

### Cleanup

Sub-agent meta files accumulate in `~/.toebeans/sub-agents/`. Prune strategy: delete meta files older than 7 days on `init()`. Session JSONL files are already managed by the session system.

## System Prompt Contribution

The plugin's `buildSystemPrompt()` adds an active sub-agents status block to the parent's context:

```
## Active Sub-Agents
- "research-api" (sub_abc123) — running since 2m ago
- "write-tests" (sub_def456) — completed 30s ago (use read_sub_agent_output to see results)
```

This gives the parent LLM awareness of in-flight work without polling.

## Tool Filtering & Security

Sub-agents share the parent's tool set by default. This is intentional — the whole point is that they can use toebeans tools. But some tools are dangerous for unsupervised execution:

### Default Denylist

```typescript
const DEFAULT_DENIED = [
  'spawn_sub_agent',   // no recursive spawning (v1)
  'spawn_claude_code', // don't shell out from a sub-agent
  'restart_server',    // obviously not
]
```

### Optional Allowlist

If `tools_allowed` is set, only those tools (minus denylist) are available. This is useful for scoping a sub-agent to e.g. only read-only tools.

### Recursive Spawning

Blocked in v1 via the default denylist. Recursive sub-agents are a real use case (fan-out/fan-in) but add complexity around:
- Depth limits
- Cascading abort
- Cost tracking across a tree
- Notification routing (does a grandchild notify the child or the root?)

Better to get the single-level case right first.

## Cost Tracking

Each sub-agent runs `runAgentTurn()` which writes cost entries to its session JSONL. On completion, the notification includes total cost. The parent can also query cost via `read_sub_agent_output`.

Sub-agent costs are **not** rolled into the parent session's cost — they're separate sessions. This is correct: the parent session's `done` event reports its own cost, and sub-agent costs are reported in their own `done` events (or in the notification message).

## Config

```json5
{
  "plugins": {
    "sub-agents": {
      "maxConcurrent": 5,        // max simultaneous sub-agents per parent session
      "maxTokens": 40000,        // token budget per sub-agent (abort if exceeded)
      "toolsDenied": [],         // additional global denylist
      "metaRetentionDays": 7,    // auto-prune old meta files
    }
  }
}
```

## Tricky Bits & Constraints

### 1. LLM Provider Concurrency

Multiple sub-agents hit the LLM API in parallel. Anthropic rate limits apply. The provider is shared (same `LlmProvider` instance), so if the provider has internal queuing or connection pooling, it just works. If not, sub-agents may get 429s — the agent loop doesn't currently retry on rate limits. This is a pre-existing issue that affects any concurrent sessions (e.g., Discord + CLI + timers all firing at once).

**Mitigation for v1**: `maxConcurrent` config. Could add a semaphore later.

### 2. Tool Contention

Some tools have side effects (bash commands, file writes). Two sub-agents and the parent could stomp on each other's files. This is the same problem as running multiple Claude Code sessions — it's the user's responsibility to scope tasks appropriately.

**Mitigation**: clear documentation. Optional: sub-agents get their own `workingDir` subdirectory (`~/.toebeans/workspace/sub-{id}/`).

### 3. System Prompt Freshness

Sub-agents call `buildSystemPrompt()` at spawn time and bake it into the session. If a plugin's system prompt contribution changes mid-flight, the sub-agent won't see it. This is fine — sub-agents are short-lived.

### 4. Session Routing Collision

The route `sub-{parentSessionId}-{name}` could collide if the same name is reused. Use `subAgentId` (random) in the route instead of `name`:

```
sub-{subAgentId}
```

Keep `name` purely for display.

### 5. AbortSignal Propagation

The parent's `/stop` should only abort the parent, not its sub-agents. Sub-agents have their own `AbortController`. To abort a sub-agent, use `abort_sub_agent` explicitly. A "stop everything" command could be added later.

### 6. Output Target Lifecycle

If the parent's `outputTarget` is a Discord channel, it persists. If it's a WebSocket connection that disconnects, the notification has nowhere to go. This is the same as bash_spawn — the notification gets queued as a message on the session and picked up when the session is next active. Not a new problem.

## Thin-Slice Implementation Path

### Phase 1: Minimum Viable Sub-Agent

1. **Plugin skeleton**: `plugins/sub-agents/index.ts` with the async generator input pattern (copy from bash_spawn)
2. **`spawn_sub_agent` tool**: Takes `name` and `task`, generates ID, writes meta, calls `runAgentTurn()` in a fire-and-forget async block
3. **Completion notification**: `queueNotification()` on the async generator
4. **`list_sub_agents` tool**: Read meta files, report status
5. **`read_sub_agent_output` tool**: `loadSession(sessionId)` and format

Skip for phase 1: tool filtering, config, compaction, crash recovery, abort, cost tracking in notifications, system prompt status block.

This is probably ~200 lines of code. The hard part is already done — `runAgentTurn` is the entire agent loop and it's a single function call.

### Phase 2: Polish

- Tool denylist (especially `spawn_sub_agent` to prevent recursion)
- `abort_sub_agent` tool
- `pending.json` crash recovery
- `buildSystemPrompt()` status block
- Config schema
- Meta file pruning

### Phase 3: Advanced

- Recursive spawning with depth limits
- Per-sub-agent working directories
- Rate limit / concurrency semaphore
- Fan-in patterns (wait for N sub-agents, then continue)
- Streaming progress to parent (periodic status updates)

## Comparison with Existing Async Patterns

| Feature | bash_spawn | claude-code | timers | **sub-agents** |
|---------|-----------|-------------|--------|---------------|
| Execution | OS process | External CC process | setTimeout | In-process agent loop |
| Tools | None (raw shell) | CC's own tools | None (fires prompt) | Toebeans tools |
| Shared context | No | No | Partial (session) | Yes (plugins, memory) |
| Crash recovery | Log files persist | pending.json + reattach | .lastFired.json | pending.json + mark failed |
| Notification | queueNotification | queueNotification | queueTimerMessage | queueNotification |
| Cost tracking | N/A | Separate billing | N/A | Separate session cost |
| Abort | bash_kill (SIGTERM) | N/A | timer_delete | abort_sub_agent (AbortController) |

## Open Questions

1. **Should sub-agents see the parent's conversation history?** Leaning no — they get their own fresh session with just the task prompt. The parent can include relevant context in the task string. Sharing history would couple sessions and complicate compaction.

2. **Should sub-agents be able to send messages *to* the parent mid-flight?** (Not just on completion.) This would enable streaming progress but adds complexity. v1: no, completion-only notification.

3. **Model override per sub-agent?** Could be useful — spawn cheap Haiku sub-agents for simple tasks. Easy to add: just pass `model` through to `runAgentTurn`.

4. **Should the parent be able to send follow-up messages to a running sub-agent?** This turns sub-agents into full interactive sessions, which is a much bigger feature. v1: no.
