# sessions

Inter-session communication plugin. Allows sessions to discover each other, send messages, and spawn subagent sessions.

## Tools

### `list_sessions`

Lists sessions sorted by recent activity. Returns session ID, route, JSONL file path, timestamps, and whether each session is the caller's own.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 10 | Max sessions to return |

### `send_message`

Sends a message to another session by route.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `route` | string | required | Target session route (e.g., `"discord:general"`, `"ws"`) |
| `message` | string | required | Message text to send |
| `silent` | boolean | false | If true, append to JSONL without triggering an agent turn |

- **Default (silent=false)**: Queues the message through the plugin input system. The target session wakes up and processes it as a new agent turn.
- **Silent mode**: Appends directly to the session's JSONL file. The message will be visible next time that session runs, but doesn't trigger processing now.

### `spawn_session`

Spawns a new session with an initial prompt. Returns immediately with a spawn ID. When the spawned session's agent turn completes, a notification (including the response summary) is sent back to the caller's session.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | required | Initial prompt for the spawned session |
| `route_prefix` | string | `"subagent"` | Prefix for the spawn route |

## Architecture

- Uses the standard plugin `input` async generator to inject messages into the server's routing system (same pattern as bash/timers plugins).
- Uses the plugin `output` handler to detect when spawned sessions complete their turns (server routes `done` events back via `outputTarget`).
- `list_sessions` combines `listSessions()` file listing with `getActiveRoutes()` in-memory route map for route resolution. Falls back to inferring routes from session ID filenames.
- Spawned session completion notifications include a truncated summary of the spawned session's last assistant response.

## Config

No configuration required. Enable in `config.json5`:

```json5
{
  plugins: {
    sessions: {}
  }
}
```
