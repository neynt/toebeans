<p align="center"><img src="https://github.com/neynt/toebeans/raw/refs/heads/main/toebeans.png" width="400px"></p>
<p align="center">a simple extensible assistant<br><i>everything in this README file is human-written.</i></p>


## quick start

1. clone this repo
2. `while true; do bun run server; sleep 3; done`
3. probably some config stuff TODO get back to this
4. if you like it, set up a systemd unit

## core concepts

| path | function |
|-|-|
| `server/` | serves the core agent loop. runs on your box |
| `cli/` | some CLI commands. for bootstrapping before you've connected to chat, and debugging |
| `llm-providers/` | common interface for LLM APIs. currently only claude |
| `plugins/` | pluggable units of functionality |

## configuration and files

| path | contents |
|-|-|
| `~/.toebeans/config.json` | main config file. a simple one will be created after first run |
| `~/.toebeans/SOUL.md` | user-customizable start of the system message |
| `~/.toebeans/secrets` | where plugins store shared secrets / API keys |
| `~/.toebeans/$plugin_name` | typically where plugins store their data |

## plugins

plugins extend the assistant's functionality.

### core plugins

| plugin | function |
|-|-|
| `bash` | lets your agent run bash. go wild!! be free!! |
| `memory` | remember things |
| `timers` | schedule repeating (cron-style) or one-off (at-style) wakeups |
| `plugins` | add/remove plugins |

### chat plugins

| plugin | function |
|-|-|
| `discord` | lets you chat with your agent through discord |

### productive plugins

| plugin | function |
|-|-|
| `claude-code` | spawn little headless claude codes and check on them |
| `openai-codex` | same but codex |
| `view-image` | put images into your context window |
| `web-browse` | browse the web in a persistent browser, using text or screenshots |
| `gmail` | read your emails |
| `google-calendar` | read and edit your calendar events |
| `google-sheets` | read and edit your sheets |
| `nano-banana` | generate images |

### the way plugins work

plugins can:

- supply **tools** the llm can call
- supply **knowledge** that is injected into the system prompt
- inject **messages**
- **hook** into the agent loop at a thoughtful set of extension points

see [`interface Plugin` in plugin.ts](server/plugin.ts#L13)

## security model

don't give it access to stuff you don't want it to have

## manifesto

i tried [openclaw](https://github.com/openclaw/openclaw). it has a very
polished onboarding script that gave you the invigorating rush of *creating
life* -- seeing my little bot be so happy when connecting to moltbook for the
first time brought an unbelievably large smile to my face -- but i quickly ran
into issues. there was a focus on scope over quality that pervaded my every
interaction with it. the discord plugin had a bug where it wouldn't send you
any messages until the full agent turn was done, and then it'd give you a
firehose of everything all at once. tts was limited to APIs and low-quality
local options -- not qwen3-tts, which felt like it ought to be trivial to set
up. and somehow it chewed through hundreds of dollars of API credits in the
blink of an eye. it insisted on DIYing code and its tools for spawning headless
coding agents felt quite undercooked. browser integration was also messy -- why
do i need an extension into an existing browser when you can just playwright
everything? it had two systems for scheduling events -- heartbeats and cron --
which felt at once uninspectable and wholly unnecessary. before long its
workspace directory was a mess. i had no idea what was feeding into the context
window at any given point in time, or when it would decide to compact, or
create a new session. and of course the nest of bitcoin jackers on molthub was
terrifying.

[nanoclaw](https://github.com/gavrielc/nanoclaw.git) seemed like a step in the
right direction. i admire its simplicity. but i think it goes a little too far
-- the extensibility story felt unsustainable. the idea that the way you extend
the agent is to tell it to modify its own code, and that is the *only way* to
extend the agent, felt like a mess of compositional difficulties waiting to
happen.

so here's my commitment to creating an assistant that's at the same time deeply
extensible and comprehensible. my goal is that toebeans:

- **has a solid, minimal core**. the main agent loop seldom needs to change and
  provides little functionality on its own.
- **is deeply extensible**. plugins can hook into a thoughtful selection of
  extension points in the agent loop and extend functionality. concepts that
  other assistants treat as part of the core, such as memory and timers, are
  interchangeable modules you can swap in and out.
- **has high quality built-in plugins**. i have exacting standards for my
  software and will polish the hell out of whatever i actually use.
- **is debuggable and auditable**. every action and message is logged in
  `~/.toebeans/`. every active timer, recurring or one-shot, is just a markdown
  file. knowledge is just markdown files. every session is just a jsonl file.
  you should always be able to peel back the layers of abstraction and ask
  qustions like "ok, but what exactly is in the context window at this point in
  time", without going through an llm.
- **is thrifty**. maintain a thoughtfully curated context window. be respectful
  of the user's wallet.
