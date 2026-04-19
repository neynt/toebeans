# browser plugin

stateful browser automation for toebeans. powered by patchright (patched playwright/chromium) with anti-bot stealth measures.

## tools

| tool | what it does |
|-|-|
| `browser_spawn` | create a session (ephemeral or persistent). optionally navigate to a URL. supports `headful: true` for sites with aggressive bot detection |
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
| `hover` | `selector` | |
| `mouse_move` | | `selector`, `x`, `y`, `steps`, `jitter` |
| `mouse_down` | | `button` |
| `mouse_up` | | `button` |
| `drag` | | `selector`/`x`,`y`, `to_selector`/`to_x`,`to_y`, `steps`, `hold_ms` |
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
| `press_and_hold` | | `selector`, `x`, `y`, `hold_ms`, `steps`, `jitter`, `button` |
| `get_bounds` | `selector` | |
| `switch_frame` | | `selector`, `url` |
| `list_tabs` | | |
| `switch_tab` | | `index`, `url` |
| `new_tab` | | `url` |
| `close_tab` | | |

### mouse choreography

low-level pointer primitives for realistic mouse behavior. compose `mouse_move`, `mouse_down`, `mouse_up` for custom interaction patterns, or use `hover` and `drag` as higher-level shortcuts.

- **hover** — triggers `:hover` CSS, tooltips, dropdown menus. maps to Playwright's `page.hover()`.
- **mouse_move** — move to a CSS `selector` (auto-centers) or absolute viewport `x`/`y` coordinates. `steps` controls interpolation smoothness (Playwright emits `steps` intermediate `mousemove` events along the path). `jitter` adds random pixel offsets to intermediate waypoints for more human-like movement.
- **mouse_down / mouse_up** — separate press/release. use for context menus (`button: "right"`), custom drag patterns, or press-and-hold sequences (pair with a `wait` action between them).
- **drag** — complete click-and-drag sequence. source and destination can each be a CSS `selector` or `x`/`y` coordinates. `hold_ms` adds a delay between mousedown and the drag movement (useful for drag handles that need activation time). `steps` controls movement smoothness (default: 10).
- **press_and_hold** — one-shot action for "press and hold to verify" anti-bot challenges. moves mouse to `selector` or `x`/`y` with human-like interpolation (`steps` default: 20, `jitter` default: 2px), presses down, holds for `hold_ms` (default: 3000ms) with micro-drift movements during the hold, then releases. adds random offset from element center for realism.
- **get_bounds** — returns `{x, y, width, height, centerX, centerY}` for a CSS selector. useful for planning coordinate-based interactions or debugging element positions.

### iframe / frame switching

anti-bot challenges (Cloudflare Turnstile, DataDome, PerimeterX, etc.) typically render inside iframes. use `switch_frame` to enter the iframe, then interact with elements inside it.

- **switch_frame** — switch to an iframe by CSS `selector` (e.g. `iframe[src*="challenges"]`) or `url` substring match. pass neither to return to the main frame. subsequent actions in the same `browser_interact` call will target the switched frame. the frame switch persists across `browser_interact` calls until you switch back.

example workflow for a "press and hold" anti-bot challenge:
```
[
  { "type": "switch_frame", "selector": "iframe[src*='challenge']" },
  { "type": "press_and_hold", "selector": "#hold-button", "hold_ms": 4000 },
  { "type": "switch_frame" },
  { "type": "wait", "ms": 2000 },
  { "type": "screenshot" }
]
```

### tab / window management

sites that open popups or new tabs (OAuth flows, `window.open()`, `target="_blank"` links) spawn additional pages in the same browser context. these are automatically tracked and discoverable.

- **list_tabs** — returns all open tabs with index, URL, title, which is active, and opener relationship (if the tab was opened as a popup, `opened_by` shows the opener tab's index)
- **switch_tab** — switch to a tab by `index` (from `list_tabs`) or `url` substring match. resets frame context to the main frame of the target tab
- **new_tab** — open a new empty tab, optionally navigating to a `url`. the new tab becomes active
- **close_tab** — close the current tab and switch to the next available one. cannot close the last remaining tab

when multiple tabs are open, `browser_interact` results include a `tab_count` field. `browser_spawn` also reports `tab_count` when resuming a session with multiple tabs.

example: follow an OAuth popup
```
[
  { "type": "click", "selector": "a.oauth-login" },
  { "type": "wait", "ms": 2000 },
  { "type": "list_tabs" },
  { "type": "switch_tab", "index": 1 },
  { "type": "click", "selector": "#authorize-btn" },
  { "type": "switch_tab", "index": 0 }
]
```

## sessions

two kinds:

- **ephemeral** — share a single chromium instance and a common cookie jar (`~/.toebeans/secrets/browser-cookies.json`). auto-close after 5 min inactivity (configurable).
- **persistent** — each gets its own chromium instance with a full user data dir under `~/.toebeans/browser-sessions/{name}/`. survives server restarts. cookies, localStorage, service workers all preserved natively by chromium. auto-close after 24h inactivity; stale sessions cleaned after 7 days.

spawning a persistent session that already exists resumes it with all prior state intact.

## design notes

- uses [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (not vanilla playwright) with `AutomationControlled` disabled and WebGL spoofing for bot detection evasion
- chromium launches with `--disable-dev-shm-usage` (prevents `/dev/shm` exhaustion crashes) and `--disable-gpu` (prevents GPU process crashes on JS-heavy pages)
- headless by default. two ways to go headful:
  1. per-session: pass `headful: true` to `browser_spawn` (launches a dedicated browser instance)
  2. globally: set `headless: false` in config (all sessions use visible chrome)
- headful sessions use `--ozone-platform=x11` (XWayland) because Chrome's native Wayland backend hangs when launched from background processes outside the compositor's logind session
- persistent contexts strip `browser.window_placement` from `Default/Preferences` before each launch. Chrome 146 crashes with `SIGTRAP` ("Failed global descriptor lookup: 7") when restoring saved window placement under Patchright's pipe-based launch — the compositor child process expects a shared-memory FD that isn't in the descriptor table
- `browser_view` clones the DOM, strips scripts/styles/svg/canvas, annotates inputs/buttons/selects/links with CSS selector hints, then converts to markdown via turndown. truncates at 80KB. **sensitive input values are redacted** — password fields, inputs with credential-related names (password, secret, token, api_key, ssn, credit_card, cvv, pin), and autocomplete hints (current-password, new-password, cc-number, cc-csc) show `••••••` instead of actual values. **boilerplate/noise stripping** — `<nav>`, `<footer>`, map containers (Leaflet, Mapbox, Google Maps), decorative/tracking images (1x1 pixels, data/blob URIs, map tiles), and long inline data-URI/URL-encoded SVG sludge are all removed to reduce token waste
- 15s launch timeout on chromium startup (passed directly to patchright). 60s hard timeout on all operations as a hang safety net. if chromium hangs on close, it gets SIGKILL'd. `page.evaluate()` has a 30s timeout that does NOT kill the browser — the page remains usable
- navigation timeouts fail silently (log a warning, session continues). selector timeouts fail fast (2s default)
- `click` uses `noWaitAfter` to avoid hanging on patchright's init-script injection navigation

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
