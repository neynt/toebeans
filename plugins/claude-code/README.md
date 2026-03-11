# claude-code

spawn headless claude code sessions and check on them later. this is how toebeans delegates real coding work.

*this README was written by an LLM.*

## tools

| tool | what it does |
|-|-|
| `spawn_claude_code` | spawn a one-shot claude code process with a task prompt. optionally in a git worktree, optionally resuming a previous session |
| `list_claude_code_sessions` | list recent sessions with status, exit code, timestamps, log size |
| `read_claude_code_output` | read a session's stream-json log. returns a clean summary by default, raw with `raw: true` |

## how it works

each spawned session runs `claude -p --dangerously-skip-permissions --output-format stream-json` as a detached child process. output streams to a log file in `~/.toebeans/claude-code/`. a `.meta.json` sidecar tracks the task, pid, timestamps, exit code, and claude code's own session id (captured from the init event on stdout).

when a session exits, a completion notification is injected into the parent toebeans conversation via the plugin's input generator.

## worktree isolation

passing `worktree: "branch-name"` creates a git worktree and runs the task there, so the main repo stays clean. on completion, the branch is automatically merged back. if the merge conflicts, a new claude code session is spawned to resolve it. the worktree base path defaults to `~/code/toebeans-wt/` and is configurable.

worktree creation requires a clean working tree (no uncommitted changes). node_modules is symlinked from the original repo.

## resume

passing `resumeSessionId` forks a previous claude code conversation (`-r <ccSessionId> --fork-session`). the new session inherits the prior conversation context. claude code scopes sessions by cwd, so the resumed session runs from the original session's working directory.

## persistence across restarts

`pending.json` tracks in-flight session ids. on server restart, the plugin checks if each pending process is still alive (kill -0) and polls every 2s until exit. completion notifications are eventually delivered even if the server crashes mid-task.

## configuration

in `~/.toebeans/config.json5` under the plugin's config key:

| key | default | what |
|-|-|-|
| `model` | `"opus"` | claude model passed to `claude --model` |
| `worktreeBase` | `"~/code/toebeans-wt/"` | where git worktrees are created |
| `notifyTarget` | — | optional output routing for completion notifications |

## data

all session data lives in `~/.toebeans/claude-code/`:

```
pending.json              # array of in-flight session ids
<sessionId>.log           # raw stream-json output
<sessionId>.meta.json     # task, pid, timestamps, exit code, ccSessionId
```
