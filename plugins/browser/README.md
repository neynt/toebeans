# browser plugin

Stateful, CDP-based browser automation for toebeans. Browsers persist between tool calls via session IDs.

## Tools

| Tool | Description |
|------|-------------|
| `browser_spawn` | Create a new browser session. Optionally navigate to a URL. Returns `session_id`. |
| `browser_screenshot` | Take a viewport screenshot, save to file, return path. |
| `browser_view` | Get markdown text of the current page (read-only). |
| `browser_interact` | Perform actions: goto, click, type, press, wait, evaluate, scroll, select, download. |
| `browser_close` | Close session and free resources. |

## User visibility

### Screenshots
Every `browser_screenshot` call saves a PNG to `~/.toebeans/workspace/images/`. The LLM or user can view these files directly.

### CDP remote debugging
When `remoteDebuggingPort` is configured (e.g. `9222`), you can connect to the live browser:
1. Open Chrome/Chromium on your machine
2. Navigate to `chrome://inspect`
3. Click "Configure..." and add `localhost:9222`
4. Your browser sessions will appear under "Remote Target" — click "inspect" to get a live DevTools view

### Non-headless mode
Set `headless: false` in config to see the actual Chrome window on your desktop.

## Config

Add to `~/.toebeans/config.json5` under `plugins`:

```json5
browser: {
  locale: "en-US",
  timezone: "America/New_York",
  sessionTimeoutMs: 300000,    // auto-close after 5 min inactivity
  navigationTimeout: 15000,    // page.goto() timeout (default 15s)
  selectorTimeout: 2000,       // click/wait_for/select timeout (default 2s)
  downloadTimeout: 30000,      // download event timeout (default 30s)
  maxContentLength: 80000,
  remoteDebuggingPort: 9223,   // CDP port for chrome://inspect
  headless: false,             // set true to hide the window
}
```

## Notes

- Sessions auto-expire after `sessionTimeoutMs` of inactivity (default 5 min)
- Cookies persist across sessions via `~/.toebeans/secrets/browser-cookies.json`
- Uses patchright (patched Chromium) with stealth measures for anti-bot bypass
- Shares the same cookie jar as the web-browse plugin
