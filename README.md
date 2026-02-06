# toebeans

<img src="https://github.com/neynt/toebeans/raw/refs/heads/main/toebeans.png" style="max-width:400px">

a simple extensible personal assistant, inspired by [openclaw](https://github.com/openclaw/openclaw).

## core concepts

| path | function |
|-|-|
| `server/` | runs on your box |
| `client/` | a basic CLI |
| `llm-providers/` | common interface for LLM APIs |
| `plugins/` | pluggable units of functionality |

## plugins

plugins extend the assistant's functionality. they can supply tools, inject context, and hook into the agent loop at a thoughtful set of extension points.

included plugins:

| plugin | function |
|-|-|
| `bash` | lets your agent run bash. go wild!! be free!! |
| `discord` | lets you chat with your agent through discord |
| `memory` | remember things |
| `timers` | schedule repeating (cron-style) or one-off (at-style) wakeups |
| `plugins` | add/remove plugins |
| `claude-code-direct` | spawn little headless claude codes and check on them |

## configuration and files

`~/.toebeans/config.json` is where your config goes. plugins typically store stuff in `~/.toebeans/$plugin_name`

## security model

don't give it access to stuff you don't want it to have. maybe run it under a different user account. surrender yourself to the machine.
