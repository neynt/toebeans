# browser plugin

stateful browser automation for toebeans. powered by patchright (patched playwright/chromium) with anti-bot stealth measures.

## tools

| tool | what it does |
|-|-|
| `browser_spawn` | create a session (ephemeral or persistent). optionally navigate to a URL |
| `browser_sessions` | list all sessions (in-memory and persisted on disk) |
| `browser_screenshot` | viewport screenshot, saved as PNG to `~/.toebeans/workspace/images/` |
| `browser_view` | extract current page as markdown. annotates interactive elements with CSS selectors so the LLM can target them in subsequent actions |
| `browser_interact` | run a sequence of actions on the page (see below) |
| `browser_close` | close session, free resources. persistent sessions preserve state unless `delete: true` |

## interact actions

each action type has its own sub-schema (discriminated union via `anyOf`) so the LLM only sees the relevant fields. this prevents models from filling every property with empty defaults.

LLMs (especially via OpenAI-compatible APIs) sometimes hallucinate action names. common aliases are auto-normalized before dispatch — e.g. `fill_credentials` → `bitwarden_fill`, `click_by_text` → `click_text`, `navigate` → `goto`. see `ACTION_ALIASES` in `index.ts`.

| action | required fields | optional fields |
|-|-|-|
| `goto` | `url` | |
| `click` | `selector` | |
| `click_text` | `text` | |
| `type` | `selector`, `text` | |
| `press` | `key` | |
| `wait` | | `ms` |
| `wait_for` | `selector` | `ms` |
| `evaluate` | `js` | |
| `screenshot` | | |
| `scroll` | | `direction`, `amount` |
| `select` | `selector`, `value` | |
| `upload_file` | `selector`, `file_paths` | |
| `download` | `download_path` | `selector`, `url` |
| `bitwarden_fill` | `session_token`, `search`, `username_selector`, `password_selector` | `submit_selector` |

## sessions

two kinds:

- **ephemeral** — share a single chromium instance and a common cookie jar (`~/.toebeans/secrets/browser-cookies.json`). auto-close after 5 min inactivity (configurable).
- **persistent** — each gets its own chromium instance with a full user data dir under `~/.toebeans/browser-sessions/{name}/`. survives server restarts. cookies, localStorage, service workers all preserved natively by chromium. auto-close after 24h inactivity; stale sessions cleaned after 7 days.

spawning a persistent session that already exists resumes it with all prior state intact.

## design notes

- uses [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (not vanilla playwright) with `AutomationControlled` disabled and WebGL spoofing for bot detection evasion
- headless by default. set `headless: false` to see the actual chrome window
- `browser_view` clones the DOM, strips scripts/styles/svg/canvas, annotates inputs/buttons/selects/links with CSS selector hints, then converts to markdown via turndown. truncates at 80KB
- 60s hard timeout on all operations as a hang safety net. if chromium hangs on close, it gets SIGKILL'd
- navigation timeouts fail silently (log a warning, session continues). selector timeouts fail fast (2s default)

## user visibility

### CDP remote debugging

when `remoteDebuggingPort` is set, connect via `chrome://inspect` to get live DevTools on any session.

### screenshots

every `browser_screenshot` saves a PNG to `~/.toebeans/workspace/images/browser-{timestamp}.png`.

## config

in `~/.toebeans/config.json5` under `plugins`:

```json5
browser: {
  locale: "en-US",
  timezone: "America/New_York",
  sessionTimeoutMs: 300000,       // ephemeral inactivity timeout (5 min)
  persistentTimeoutMs: 86400000,  // persistent inactivity timeout (24h)
  persistentMaxAgeDays: 7,        // auto-clean stale persistent sessions
  navigationTimeout: 15000,
  selectorTimeout: 2000,
  downloadTimeout: 30000,
  maxContentLength: 80000,
  remoteDebuggingPort: 9223,
  headless: false,
}
```
