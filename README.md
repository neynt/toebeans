# toebeans

<img src="toebeans.heif">

a minimal, extensible personal assistant.

## core concepts

| | |
|-|-|
| `server/` | runs on your box |
| `client/` | basic CLI to connect to the server |
| `providers/` | LLM providers |
| `plugins/` | separable units that extend functionality |

## plugins

plugins:
- supply the agent with tools
- inject a bit of context
- hook into the agent loop at various extension points

included plugins:

| | |
|-|-|
| `bash` | lets your agent run bash. really every other plugin is just a simplified interface to this one |
| `discord` | lets you talk to your agent through discord |
| `memory` | remember things |
| `timers` | schedule repeating (cron-style) or one-off (at-style) wakeups |
| `plugins` | load plugins dynamically |
| `claude-code-direct` | spawn off little claude codes and check on them |

## security model

don't give it access to stuff you don't want it to have
