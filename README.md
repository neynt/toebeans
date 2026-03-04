<p align="center"><img src="https://github.com/neynt/toebeans/raw/refs/heads/main/toebeans.png" width="400px"></p>
<p align="center">a simple extensible assistant<br><i>everything in this README file is human-written.</i></p>

## quick start

1. clone this repo
2. `cp -r default-config ~/.toebeans`
3. `while true; do bun run server; sleep 1; done`
4. if you like it, set up a systemd unit

## why toebeans?

why not {[open](https://github.com/openclaw/openclaw/tree/main), [nano](https://github.com/qwibitai/nanoclaw), [null](https://github.com/nullclaw/nullclaw), [zero](https://github.com/zeroclaw-labs/zeroclaw)}claw?

as i develop toebeans, top of my mind are:

- **a solid, minimal core**. the main agent loop seldom needs to change and
  provides little functionality on its own.
- **deep extensibility**. plugins can hook into a thoughtful selection of
  extension points in the agent loop and extend functionality. concepts that
  other assistants treat as rigid parts of the core, such as memory and timers,
  are interchangeable plugins you can swap in and out or create your own
  versions of.
- **high quality built-in plugins**. i have exacting standards for my software
  and will polish the hell out of whatever i actually use.
- **deep inspectability**. every action and message is logged in
  `~/.toebeans/`. every active timer, recurring or one-shot, is just a markdown
  file. knowledge is just markdown files. every session is just a jsonl file.
  you should always be able to peel back the layers of abstraction and ask
  qustions like "ok, but what exactly is in the context window at this point in
  time", without going through an llm. i provide tools like `bun run debug
  print-system`, `bun run debug print-tools`, and `bun run debug
  tail-all-sessions` so you always know what's going on. this also provides
  extremely useful material for the agent to debug itself.
- **careful context window management**. maintain a thoughtfully curated
  context window. this is good for capabilities and for the user's wallet.

see [MANIFESTO.md](MANIFESTO.md) for a longer rant

## core concepts

| path | function |
|-|-|
| `server/` | serves the core agent loop. runs on your box |
| `cli/` | some CLI commands for inspectability |
| `llm-providers/` | common interface for LLM APIs. currently supports claude and kimi k2.5 |
| `plugins/` | pluggable units of functionality |

## configuration and files

| path | contents |
|-|-|
| `~/.toebeans/config.json5` | main config file |
| `~/.toebeans/SOUL.md` | user-customizable start of the system message |
| `~/.toebeans/secrets/` | where plugins store shared secrets / API keys |
| `~/.toebeans/$plugin_name/` | typically where plugins store their data |

## plugins

plugins extend the assistant's functionality.

### core plugins

| plugin | function |
|-|-|
| `bash` | lets your agent run bash |
| `memory` | remember things about you and what you talked about |
| `timers` | schedule repeating or one-off wakeups |
| `plugins` | add/remove plugins |
| `skills` | stick [skills](https://agentskills.io/) in context |

### chat plugins

| plugin | function |
|-|-|
| `discord` | chat with your agent through discord |

### productive plugins

| plugin | function |
|-|-|
| `claude-code` | spawn little headless claude codes and check on them |
| `openai-codex` | same but codex |
| `view-image` | put images into your context window |
| `web-browse` | browse the web in a persistent browser, using text or screenshots |
| `gmail` | read your emails. write drafts. send them if you're brave |
| `google-calendar` | read and edit your calendar events |
| `google-sheets` | read and edit your sheets |
| `nano-banana` | generate images |

### the way plugins work

plugins can:

- supply **tools** the llm can call
- supply **knowledge** that is injected into the system prompt
- inject **messages** into the session
- **hook** into the agent loop at a thoughtful set of extension points

see [`interface Plugin` in plugin.ts](server/plugin.ts#L13)

## security model

don't give it access to stuff you don't want it to have
