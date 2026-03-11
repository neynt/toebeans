# bash plugin

execute bash commands synchronously or in the background. background processes are tracked, logged, and produce completion notifications back to the agent.

## tools

| tool | description |
|------|-------------|
| `bash` | execute a command and wait for output. |
| `bash_spawn` | start a command in the background. returns a pid. |
| `bash_check` | read output from a spawned process. |
| `bash_kill` | send SIGTERM to a spawned process. |

## how it works

`bash` runs `bash -c <command>` via `Bun.spawn`, races the process against a timeout, and returns combined stdout+stderr. the command string is passed verbatim — all shell features (pipes, redirects, command substitution, variable expansion, process substitution, heredocs, etc.) work as expected. supports the `/stop` abort signal.

`bash_spawn` does the same but returns immediately with a pid. stdout and stderr stream to a log file at `~/.toebeans/bash/<timestamp>.log`. when the process exits, a completion notification (with exit code and last 10 lines of output) is injected back into the session via the plugin's input generator. notifications route to the originating session/output target.

`bash_check` tails the log file for a given pid (default 20 lines) and reports whether the process is still running.

`bash_kill` sends SIGTERM and removes the process from tracking.

## config

add to `~/.toebeans/config.json5` under `plugins`:

```json5
bash: {
  defaultTimeout: 60,        // bash tool default (seconds)
  maxTimeout: 600,            // bash tool max
  spawnDefaultTimeout: 600,   // bash_spawn default
  spawnMaxTimeout: 3600,      // bash_spawn max
}
```

## notes

- all tools accept an optional `workingDir` (tilde-expanded) and `timeout` (clamped to configured max)
- timeouts kill the process; `bash` returns an error, `bash_spawn` sends a timeout notification
- spawned process tracking is in-memory and does not survive server restarts
- the `command` field is validated at execution time — missing or non-string values return an error instead of passing `undefined` to the shell
- the tool description and plugin description explicitly mention shell features like `$(...)` to encourage the LLM to use them rather than avoiding them
