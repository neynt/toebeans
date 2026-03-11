# gemini-cli

spawn one-shot [Gemini CLI](https://github.com/google-gemini/gemini-cli) tasks and monitor their output. mirrors the claude-code plugin's architecture, adapted for Gemini's CLI conventions.

## tools

| tool | what it does |
|-|-|
| `spawn_gemini_cli` | spawn a gemini cli process with a prompt. optionally in a git worktree |
| `list_gemini_cli_sessions` | list recent sessions and their status |
| `read_gemini_cli_output` | read and summarize a session's stream-json log |

## how it works

each spawn runs `gemini -p <task> -y -o stream-json -m <model>` as a child process. stdout is captured to `~/.toebeans/gemini-cli/{sessionId}.log` alongside a `.meta.json` file. the agent is automatically notified (via injected user message) when the process exits. pending sessions survive server restarts — on init, the plugin reattaches to still-running processes or sends missed notifications.

## session resume

gemini cli sessions are **per-project** (per working directory), not globally unique. resume uses an index number or `"latest"`, not a UUID. there's no fork-session equivalent — resume continues in-place.

## worktree isolation

when `worktree` is provided, the plugin:

1. validates the repo has no uncommitted changes
2. creates a git worktree at `{worktreeBase}/{branchName}` (default base: `~/code/toebeans-wt/`)
3. symlinks `node_modules` from the original repo if applicable
4. runs gemini cli in the isolated worktree
5. on completion, attempts `git merge` back into the original repo
6. on merge conflict, spawns another gemini session to resolve it

## model selection

default model is `"auto"` (gemini's smart routing between flash-lite and pro). configurable to `"pro"`, `"flash"`, `"flash-lite"`, or a specific model name via `plugins.gemini-cli.model` in config.

## auth

requires `GEMINI_API_KEY` env var or Google OAuth configured in `~/.gemini/`. the plugin does not handle auth itself.

## config

in `~/.toebeans/config.json5` under `plugins.gemini-cli`:

```json5
{
  model: "auto",          // gemini model (default: "auto")
  worktreeBase: "~/code/toebeans-wt",  // where worktrees go
  notifyTarget: "discord:channelId",   // route completion notifications
}
```

## notifications

task completion notifications are injected as user messages into the agent loop. `notifyTarget` can route them to a specific output channel (e.g. a discord channel).
