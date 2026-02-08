<p align="center"><img src="https://github.com/neynt/toebeans/raw/refs/heads/main/toebeans.png" width="400px"></p>
<p align="center">a simple extensible personal assistant</p>

## quick start

(WIP)

1. clone this repo
2. `bun run server`

## core concepts

| path | function |
|-|-|
| `server/` | the core agent loop. runs on your box |
| `client/` | a basic CLI. you probably won't need it |
| `llm-providers/` | common interface for LLM APIs |
| `plugins/` | pluggable units of functionality |

## plugins

plugins extend the assistant's functionality.

included plugins:

| plugin | function |
|-|-|
| `bash` | lets your agent run bash. go wild!! be free!! |
| `discord` | lets you chat with your agent through discord |
| `memory` | remember things |
| `timers` | schedule repeating (cron-style) or one-off (at-style) wakeups |
| `plugins` | add/remove plugins |
| `claude-code-direct` | spawn little headless claude codes and check on them |

plugins can:

- provide **tools** the llm can call
- inject a little bit of **knowledge** into the system prompt
- hook into the agent loop at a thoughtful set of lifecycle extension points

## configuration and files

`~/.toebeans/config.json` is where your config goes. plugins typically store stuff in `~/.toebeans/$plugin_name`

## security model

don't give it access to stuff you don't want it to have. maybe run it under a
different user account. surrender yourself to the machine. it *is* just running
as a user on your box. treat it like that.

## manifesto

i tried [openclaw](https://github.com/openclaw/openclaw). it has a very
polished onboarding script that gave you the invigorating rush of *creating
life* -- seeing my little bot be so happy when connecting to moltbook for the
first time was joyful -- but i quickly ran into issues. there was a focus on
scope over quality that pervaded my every interaction with it. the discord
plugin had a bug where it wouldn't send you any messages until the full agent
turn was done, and then it'd give you a firehose of everything all at once. tts
was limited to APIs and low-quality local options -- not qwen3-tts, which felt
like it ought to be trivial to set up. and somehow it chewed through hundreds
of dollars of API credits in the blink of an eye. it insisted on DIYing code
and its tools for spawning headless coding agents felt quite undercooked.
browser integration was also messy -- why do i need an extension into an
existing browser when you can just playwright everything? it had two systems
for scheduling events -- heartbeats and cron -- which felt at once
uninspectable and wholly unnecessary. before long its workspace directory was a
mess. i had no idea what was feeding into the context window at any given point
in time, or when it would decide to compact, or create a new session. and of
course the nest of bitcoin jackers on molthub was terrifying.

[nanoclaw](https://github.com/gavrielc/nanoclaw.git) seemed like a step in the
right direction. i admire its simplicity. but i think it goes a little too far
-- the extensibility story felt unsustainable. the idea that the way you extend
the agent is to tell it to modify its own code, and that is the *only way* to
extend the agent, felt like a mess of composition issues waiting to happen.

so here's my commitment to creating an assistant that's at the same time deeply
extensible and comprehensible. toebeans is an agent that:

- **has a solid, minimal core**. the main agent loop seldom needs to change and
  provides little functionality on its own.
- **is deeply extensible**. plugins can hook into a thoughtful selection of
  extension points in the agent loop and extend functionality. concepts that
  other assistants treat as part of the core, such as memory and timers, are
  interchangeable modules you can swap in and out.
- **is inspectable and auditable**. every action and message is logged in
  `~/.toebeans/`. every active timer, recurring or one-shot, is just a markdown
  file. every session is just a jsonl file.
- **is debuggable**. yeah it's nice when the agent can fix itself but sometimes
  it doesn't and you do want to peel back the layers of abstraction. you should
  always be able to ask inspectability questions like, "ok but what exactly is
  in my context window at this point in time", without going through an llm.
- **is thrifty**. maintain a thoughtfully curated context window. be respectful
  of the user's wallet.
