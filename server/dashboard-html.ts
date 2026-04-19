/**
 * Dashboard HTML template. Used by both the integrated route in index.ts
 * and the standalone status-dashboard.ts.
 *
 * @param statusUrl — the URL the browser JS will poll (e.g. "/status" or "/api/status")
 * @param apiBase — prefix for session API calls (e.g. "" or "/api")
 */
export function dashboardHtml(statusUrl = '/status', apiBase = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toebeans dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace;
    background: #0d1117; color: #c9d1d9;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }

  /* top bar */
  .topbar {
    display: flex; align-items: center; gap: 1rem;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid #21262d; background: #161b22;
    flex-shrink: 0;
  }
  .topbar h1 { color: #58a6ff; font-size: 1.1rem; white-space: nowrap; }
  .topbar .meta { color: #8b949e; font-size: 0.75rem; flex: 1; }
  #pulse {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #238636; margin-right: 6px;
  }
  #pulse.err { background: #f85149; }

  /* tabs */
  .tabs {
    display: flex; gap: 0; border-bottom: 1px solid #21262d;
    background: #161b22; flex-shrink: 0; overflow-x: auto;
    scrollbar-width: thin; scrollbar-color: #30363d transparent;
  }
  .tab {
    padding: 0.5rem 1rem; font-size: 0.75rem; cursor: pointer;
    color: #8b949e; border-bottom: 2px solid transparent;
    white-space: nowrap; transition: color 0.15s, border-color 0.15s;
    font-family: inherit; background: none; border-top: none;
    border-left: none; border-right: none;
  }
  .tab:hover { color: #c9d1d9; }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab .badge-count {
    display: inline-block; font-size: 0.6rem; padding: 1px 5px;
    border-radius: 8px; background: #30363d; color: #8b949e;
    margin-left: 4px; font-weight: 600;
  }
  .tab.active .badge-count { background: #1f3a5f; color: #58a6ff; }

  /* main content area */
  .main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .panel { display: none; flex: 1; overflow-y: auto; padding: 1.5rem; }
  .panel.active { display: flex; flex-direction: column; }

  /* overview panel */
  .section-title {
    color: #8b949e; font-size: 0.75rem; text-transform: uppercase;
    letter-spacing: 0.1em; margin-bottom: 0.6rem;
  }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem; margin-bottom: 1.5rem;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 1rem; position: relative; overflow: hidden;
  }
  .card.busy { border-color: #f0883e; }
  .card.busy::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, #f0883e, #f7c948, #f0883e);
    background-size: 200% 100%; animation: shimmer 1.5s infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  .card h3 { font-size: 0.85rem; color: #58a6ff; margin-bottom: 0.5rem; word-break: break-all; }
  .badge {
    display: inline-block; font-size: 0.65rem; padding: 2px 6px;
    border-radius: 10px; font-weight: 600; text-transform: uppercase;
  }
  .badge.idle { background: #238636; color: #fff; }
  .badge.busy { background: #f0883e; color: #fff; }
  .badge.done { background: #238636; color: #fff; }
  .badge.failed { background: #f85149; color: #fff; }
  .badge.running { background: #f0883e; color: #fff; }
  .agent-label {
    display: inline-block; font-size: 0.6rem; padding: 1px 5px;
    border-radius: 3px; font-weight: 600; text-transform: uppercase;
    margin-right: 4px;
  }
  .agent-label.claude-code { background: #da8b45; color: #0d1117; }
  .agent-label.gemini-cli { background: #7ee787; color: #0d1117; }
  .agent-label.openai-codex { background: #79c0ff; color: #0d1117; }
  .task-desc {
    font-size: 0.75rem; color: #c9d1d9; margin-top: 0.3rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
  }
  .card.coding-card { cursor: pointer; transition: border-color 0.15s; }
  .card.coding-card:hover { border-color: #484f58; }
  .card.coding-card.expanded { grid-column: 1 / -1; }
  .card.coding-card.expanded .task-desc {
    white-space: pre-wrap; overflow: visible; text-overflow: unset;
  }
  .coding-output {
    margin-top: 0.6rem; border-top: 1px solid #21262d; padding-top: 0.5rem;
    max-height: 400px; overflow-y: auto;
  }
  .coding-output-line {
    font-size: 0.7rem; line-height: 1.5; padding: 0.15rem 0;
    border-bottom: 1px solid #161b22;
  }
  .coding-output-line.assistant { color: #c9d1d9; }
  .coding-output-line.user { color: #8b949e; font-style: italic; }
  .coding-output-line.status { color: #58a6ff; }
  .coding-output-line.result { color: #7ee787; }
  .coding-output-line .line-type {
    display: inline-block; font-size: 0.6rem; padding: 1px 4px;
    border-radius: 3px; margin-right: 4px; font-weight: 600;
  }
  .coding-output-line.assistant .line-type { background: #1f3a5f; color: #58a6ff; }
  .coding-output-line.status .line-type { background: #0d2847; color: #58a6ff; }
  .coding-output-line.result .line-type { background: #0d3117; color: #7ee787; }
  .coding-output-loading { color: #484f58; font-size: 0.7rem; padding: 0.5rem 0; }
  .card-meta { font-size: 0.75rem; color: #8b949e; margin-top: 0.4rem; line-height: 1.6; }
  .card-meta span { color: #c9d1d9; }
  .kv { display: flex; gap: 0.5rem; font-size: 0.8rem; margin-bottom: 0.3rem; }
  .kv .k { color: #8b949e; min-width: 100px; }
  .kv .v { color: #c9d1d9; }
  .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .pill {
    font-size: 0.65rem; padding: 2px 8px; border-radius: 10px;
    background: #21262d; border: 1px solid #30363d; color: #8b949e;
  }
  .timestamp-text { color: #8b949e; font-size: 0.7rem; }

  /* sessions browser panel */
  .sessions-layout {
    display: flex; flex: 1; overflow: hidden; gap: 0;
  }
  .session-list {
    width: 360px; min-width: 280px; max-width: 500px;
    border-right: 1px solid #21262d; overflow-y: auto;
    flex-shrink: 0; background: #0d1117;
  }
  .session-list-header {
    padding: 0.75rem 1rem; border-bottom: 1px solid #21262d;
    display: flex; flex-direction: column; gap: 0.5rem;
    position: sticky; top: 0; background: #0d1117; z-index: 1;
  }
  .session-list-header .title {
    font-size: 0.75rem; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .recency-control {
    display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem;
  }
  .recency-control label { color: #8b949e; }
  .recency-control select {
    background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
    border-radius: 4px; padding: 2px 4px; font-size: 0.7rem;
    font-family: inherit;
  }
  .session-item {
    padding: 0.6rem 1rem; cursor: pointer; border-bottom: 1px solid #21262d10;
    transition: background 0.1s;
  }
  .session-item:hover { background: #161b22; }
  .session-item.active { background: #1f3a5f; border-left: 3px solid #58a6ff; }
  .session-item .route {
    font-size: 0.8rem; color: #c9d1d9; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .session-item .session-meta {
    font-size: 0.65rem; color: #8b949e; margin-top: 0.2rem;
  }
  .session-item .session-id-text {
    font-size: 0.6rem; color: #484f58; margin-top: 0.15rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* transcript viewer */
  .transcript-area {
    flex: 1; overflow-y: auto; padding: 1rem 1.5rem;
    display: flex; flex-direction: column; gap: 0;
  }
  .transcript-placeholder {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #484f58; font-size: 0.9rem;
  }
  .transcript-loading {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #8b949e; font-size: 0.85rem;
  }

  /* chat input */
  .transcript-wrapper {
    display: flex; flex-direction: column; flex: 1; overflow: hidden;
    min-width: 0;
  }
  .chat-input-bar {
    display: flex; gap: 0.5rem; padding: 0.75rem 1rem;
    border-top: 1px solid #21262d; background: #161b22;
    flex-shrink: 0;
  }
  .chat-input-bar textarea {
    flex: 1; background: #0d1117; border: 1px solid #30363d;
    color: #c9d1d9; border-radius: 6px; padding: 0.5rem 0.75rem;
    font-family: inherit; font-size: 0.8rem; resize: none;
    min-height: 2.2rem; max-height: 8rem; line-height: 1.4;
  }
  .chat-input-bar textarea:focus { outline: none; border-color: #58a6ff; }
  .chat-input-bar textarea::placeholder { color: #484f58; }
  .chat-input-bar button {
    background: #238636; color: #fff; border: none; border-radius: 6px;
    padding: 0.5rem 1rem; font-family: inherit; font-size: 0.8rem;
    cursor: pointer; white-space: nowrap; align-self: flex-end;
  }
  .chat-input-bar button:hover { background: #2ea043; }
  .chat-input-bar button:disabled { background: #21262d; color: #484f58; cursor: default; }
  .chat-input-bar .chat-status {
    align-self: center; font-size: 0.7rem; color: #8b949e;
  }

  /* message entries */
  .entry { margin-bottom: 0.5rem; }
  .entry-header {
    display: flex; align-items: center; gap: 0.5rem;
    margin-bottom: 0.3rem; font-size: 0.7rem;
  }
  .role-badge {
    display: inline-block; font-size: 0.65rem; padding: 2px 8px;
    border-radius: 4px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .role-badge.user { background: #1f6feb; color: #fff; }
  .role-badge.assistant { background: #8b5cf6; color: #fff; }
  .role-badge.system { background: #30363d; color: #8b949e; }
  .entry-timestamp { color: #484f58; font-size: 0.65rem; }
  .entry-cost {
    color: #484f58; font-size: 0.65rem; margin-left: auto;
  }

  .entry-body {
    padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.8rem;
    line-height: 1.5; overflow-x: auto;
  }
  .entry-body.user-body { background: #0d2137; border: 1px solid #1f3a5f; }
  .entry-body.assistant-body { background: #1a1333; border: 1px solid #2d2254; }
  .entry-body.system-body {
    background: #161b22; border: 1px solid #30363d;
    color: #8b949e; font-size: 0.75rem;
  }

  /* content blocks within messages */
  .content-block { margin-bottom: 0.4rem; }
  .content-block:last-child { margin-bottom: 0; }

  .text-content {
    white-space: pre-wrap; word-break: break-word;
  }

  .tool-use-block {
    background: #1c2128; border: 1px solid #30363d; border-radius: 6px;
    overflow: hidden;
  }
  .tool-use-header {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.7rem; background: #21262d;
    cursor: pointer; font-size: 0.75rem;
  }
  .tool-use-header .tool-name {
    color: #ffa657; font-weight: 600;
  }
  .tool-use-header .tool-id {
    color: #484f58; font-size: 0.6rem; margin-left: auto;
  }
  .tool-use-header .toggle-arrow {
    color: #484f58; font-size: 0.7rem; transition: transform 0.15s;
  }
  .tool-use-header .toggle-arrow.open { transform: rotate(90deg); }
  .tool-use-input {
    padding: 0.5rem 0.7rem; font-size: 0.7rem; color: #8b949e;
    white-space: pre-wrap; word-break: break-word;
    max-height: 400px; overflow-y: auto;
    display: none;
  }
  .tool-use-input.open { display: block; }

  .tool-result-block {
    border-radius: 6px; overflow: hidden;
    border: 1px solid #30363d;
  }
  .tool-result-block.error { border-color: #f8514950; }
  .tool-result-header {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.7rem; background: #1c2128;
    cursor: pointer; font-size: 0.75rem;
  }
  .tool-result-header .result-label { color: #7ee787; font-weight: 600; }
  .tool-result-block.error .tool-result-header .result-label { color: #f85149; }
  .tool-result-header .result-id {
    color: #484f58; font-size: 0.6rem; margin-left: auto;
  }
  .tool-result-header .toggle-arrow {
    color: #484f58; font-size: 0.7rem; transition: transform 0.15s;
  }
  .tool-result-header .toggle-arrow.open { transform: rotate(90deg); }
  .tool-result-content {
    padding: 0.5rem 0.7rem; font-size: 0.7rem; color: #8b949e;
    white-space: pre-wrap; word-break: break-word;
    max-height: 400px; overflow-y: auto;
    display: none;
  }
  .tool-result-content.open { display: block; }

  .image-block {
    max-width: 400px; border-radius: 4px; border: 1px solid #30363d;
    margin: 0.3rem 0;
  }
  .image-block img { max-width: 100%; border-radius: 4px; display: block; }
  .image-placeholder {
    padding: 0.5rem; color: #8b949e; font-size: 0.7rem;
    background: #161b22; border-radius: 4px;
  }

  /* system prompt entry */
  .system-prompt-entry {
    margin-bottom: 0.5rem;
  }
  .system-prompt-toggle {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.7rem; background: #161b22;
    border: 1px solid #30363d; border-radius: 6px;
    cursor: pointer; font-size: 0.75rem; color: #8b949e;
  }
  .system-prompt-toggle .toggle-arrow {
    color: #484f58; font-size: 0.7rem; transition: transform 0.15s;
  }
  .system-prompt-toggle .toggle-arrow.open { transform: rotate(90deg); }
  .system-prompt-body {
    display: none; padding: 0.6rem 0.8rem; font-size: 0.7rem;
    background: #161b22; border: 1px solid #30363d;
    border-top: none; border-radius: 0 0 6px 6px;
    color: #8b949e; white-space: pre-wrap; word-break: break-word;
    max-height: 500px; overflow-y: auto;
  }
  .system-prompt-body.open { display: block; }

  /* system prompt viewer panel */
  .prompt-viewer {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
  }
  .prompt-toolbar {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 1rem; border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  .prompt-toolbar .prompt-meta {
    font-size: 0.7rem; color: #8b949e;
  }
  .prompt-toolbar button {
    font-family: inherit; font-size: 0.7rem; padding: 4px 10px;
    border-radius: 4px; border: 1px solid #30363d; background: #21262d;
    color: #c9d1d9; cursor: pointer; transition: background 0.15s;
  }
  .prompt-toolbar button:hover { background: #30363d; }
  .prompt-toolbar button.copied { background: #238636; border-color: #238636; }
  .prompt-content {
    flex: 1; overflow-y: auto; padding: 1rem 1.5rem;
    white-space: pre-wrap; word-break: break-word;
    font-size: 0.8rem; line-height: 1.6; color: #c9d1d9;
    tab-size: 2;
  }
  .prompt-content .prompt-placeholder {
    color: #484f58; font-size: 0.9rem;
    display: flex; align-items: center; justify-content: center;
    height: 100%;
  }

  /* tool call group: groups tool_use + its tool_result together */
  .tool-group {
    margin-bottom: 0.4rem;
  }
  .tool-group .content-block { margin-bottom: 0; }
  .tool-group .tool-use-block {
    border-radius: 6px 6px 0 0;
  }
  .tool-group .tool-result-block {
    border-radius: 0 0 6px 6px; border-top: none;
  }
  .tool-group .tool-use-block:only-child {
    border-radius: 6px;
  }
  /* when there are multiple tool calls grouped, separate them slightly */
  .tool-calls-group {
    margin-bottom: 0.4rem;
  }
  .tool-calls-group .tool-group + .tool-group {
    margin-top: 0.3rem;
  }

  /* collapsed tool run (multiple consecutive assistant turns) */
  .tool-run-header {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.7rem; background: #161b22;
    border: 1px solid #30363d; border-radius: 6px;
    cursor: pointer; font-size: 0.75rem;
  }
  .tool-run-header .toggle-arrow {
    color: #484f58; font-size: 0.7rem; transition: transform 0.15s;
  }
  .tool-run-header .toggle-arrow.open { transform: rotate(90deg); }
  .tool-run-summary { color: #8b949e; }
  .tool-run-body {
    display: none;
    padding-top: 0.3rem;
  }
  .tool-run-body.open { display: block; }

  /* tool-result-only messages (user messages that are purely tool results) get hidden role badge */
  .entry.tool-results-only .entry-header { display: none; }
  .entry.tool-results-only .entry-body {
    background: none; border: none; padding: 0;
  }

  /* separator between turns */
  .turn-separator {
    border: none; border-top: 1px solid #21262d;
    margin: 0.3rem 0;
  }

  /* plugin detail */
  .plugin-section {
    margin-bottom: 1.2rem;
  }
  .plugin-section-title {
    color: #8b949e; font-size: 0.7rem; text-transform: uppercase;
    letter-spacing: 0.1em; margin-bottom: 0.4rem;
  }
  .plugin-context-block {
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 0.7rem 0.9rem; font-size: 0.75rem; color: #c9d1d9;
    white-space: pre-wrap; word-break: break-word;
    max-height: 500px; overflow-y: auto; line-height: 1.5;
  }
  .plugin-context-block.empty { color: #484f58; font-style: italic; }
  .plugin-tool-list {
    list-style: none; padding: 0;
  }
  .plugin-tool-list li {
    padding: 0.4rem 0; border-bottom: 1px solid #21262d;
    font-size: 0.75rem;
  }
  .plugin-tool-list li:last-child { border-bottom: none; }
  .plugin-tool-name { color: #ffa657; font-weight: 600; }
  .plugin-tool-desc { color: #8b949e; margin-left: 0.5rem; }

  /* skills groups */
  .skill-item {
    padding: 0.3rem 0; border-bottom: 1px solid #21262d;
    font-size: 0.75rem;
  }
  .skill-item:last-child { border-bottom: none; }
  .skill-name { color: #7ee787; font-weight: 600; }
  .skill-source { color: #484f58; font-size: 0.65rem; margin-left: 0.3rem; }
  .skill-desc { color: #8b949e; margin-left: 0.5rem; }
  .skill-group-header {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.5rem 0.6rem; margin: 0.3rem 0;
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    cursor: pointer; user-select: none; font-size: 0.75rem;
  }
  .skill-group-header:hover { border-color: #484f58; }
  .skill-group-name { color: #d2a8ff; font-weight: 600; }
  .skill-group-count { color: #484f58; }
  .skill-group-arrow {
    color: #484f58; font-size: 0.7rem; transition: transform 0.15s;
  }
  .skill-group-arrow.open { transform: rotate(90deg); }
  .skill-group-body {
    display: none; padding: 0 0.6rem;
  }
  .skill-group-body.open { display: block; }

  /* config editor */
  .config-field { margin-bottom: 0.6rem; }
  .config-field label {
    display: block; font-size: 0.7rem; color: #8b949e;
    margin-bottom: 0.2rem;
  }
  .config-field label .field-desc {
    color: #484f58; font-style: italic; margin-left: 0.3rem;
  }
  .config-field input[type="text"],
  .config-field input[type="number"] {
    width: 100%; padding: 0.35rem 0.5rem; font-size: 0.8rem;
    font-family: inherit; background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 4px;
  }
  .config-field input:focus {
    border-color: #58a6ff; outline: none;
  }
  .config-field input.modified {
    border-color: #f0883e;
  }
  .config-field .checkbox-row {
    display: flex; align-items: center; gap: 0.5rem;
  }
  .config-field .unset-tag {
    font-size: 0.6rem; color: #484f58; font-style: italic;
  }
  .config-save-bar {
    display: flex; align-items: center; gap: 0.8rem;
    padding: 0.6rem 0; margin-top: 0.5rem;
    border-top: 1px solid #21262d;
  }
  .config-save-bar button {
    padding: 0.35rem 1rem; font-size: 0.75rem; font-family: inherit;
    border: 1px solid #238636; background: #238636; color: #fff;
    border-radius: 4px; cursor: pointer;
  }
  .config-save-bar button:hover { background: #2ea043; }
  .config-save-bar button:disabled {
    opacity: 0.5; cursor: default;
  }
  .config-save-bar .save-status {
    font-size: 0.7rem; color: #8b949e;
  }
  .config-section-label {
    font-size: 0.65rem; color: #484f58; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 0.3rem 0.8rem 0.1rem;
  }

  /* scrollbar styling */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #484f58; }
</style>
</head>
<body>

<div class="topbar">
  <h1><span id="pulse"></span>toebeans</h1>
  <span class="meta" id="meta">connecting...</span>
</div>

<div class="tabs" id="tab-bar">
  <button class="tab active" data-tab="overview">overview</button>
  <button class="tab" data-tab="sessions">
    sessions <span class="badge-count" id="session-count">0</span>
  </button>
  <button class="tab" data-tab="system-prompt">system prompt</button>
  <button class="tab" data-tab="plugins">
    plugins <span class="badge-count" id="plugin-count">0</span>
  </button>
  <button class="tab" data-tab="config">config</button>
</div>

<div class="main">
  <div class="panel active" id="panel-overview"></div>
  <div class="panel" id="panel-sessions">
    <div class="sessions-layout">
      <div class="session-list" id="session-list">
        <div class="session-list-header">
          <span class="title">active sessions</span>
          <div class="recency-control">
            <label>show last</label>
            <select id="recency-select">
              <option value="6">6 hours</option>
              <option value="24">24 hours</option>
              <option value="48" selected>2 days</option>
              <option value="168">1 week</option>
              <option value="720">30 days</option>
              <option value="0">all time</option>
            </select>
          </div>
        </div>
        <div id="session-items"></div>
      </div>
      <div class="transcript-wrapper">
        <div class="transcript-area" id="transcript-area">
          <div class="transcript-placeholder">select a session to view its transcript</div>
        </div>
        <div class="chat-input-bar" id="chat-input-bar" style="display:none">
          <textarea id="chat-input" placeholder="send a message..." rows="1"></textarea>
          <button id="chat-send-btn" onclick="sendChatMessage()">send</button>
        </div>
      </div>
    </div>
  </div>
  <div class="panel" id="panel-system-prompt">
    <div class="prompt-viewer">
      <div class="prompt-toolbar">
        <span class="prompt-meta" id="prompt-meta">loading...</span>
        <button id="copy-prompt-btn" onclick="copySystemPrompt()">copy</button>
      </div>
      <div class="prompt-content" id="prompt-content">
        <div class="prompt-placeholder">loading system prompt...</div>
      </div>
    </div>
  </div>
  <div class="panel" id="panel-plugins">
    <div class="sessions-layout">
      <div class="session-list" id="plugin-list">
        <div class="session-list-header">
          <span class="title">loaded plugins</span>
        </div>
        <div id="plugin-items"></div>
      </div>
      <div class="transcript-area" id="plugin-detail-area">
        <div class="transcript-placeholder">select a plugin to view its context</div>
      </div>
    </div>
  </div>
  <div class="panel" id="panel-config">
    <div class="sessions-layout">
      <div class="session-list" id="config-section-list">
        <div class="session-list-header">
          <span class="title">sections</span>
        </div>
        <div id="config-section-items"></div>
      </div>
      <div class="transcript-area" id="config-detail-area">
        <div class="transcript-placeholder">select a section to view its config</div>
      </div>
    </div>
  </div>
</div>

<script>
const POLL_MS = 2000;
const SESSION_LIST_POLL_MS = 10000;
const statusUrl = '${statusUrl}';
const apiBase = '${apiBase}';

// ── state ──────────────────────────────────────────────
let currentTab = 'overview';
let allSessions = [];
let selectedSessionId = null;
let loadedTranscript = null; // { sessionId, entries }
let transcriptLoading = false;
let systemPromptText = null; // cached system prompt string
let expandedCodingSessions = new Set(); // Set of 'agent/id' keys
let codingOutputPollers = {}; // { 'agent/id': intervalId }
let pluginContexts = [];
let openSkillGroups = new Set();
let selectedPluginName = null;
const openCollapseIds = new Set(); // persists across rerenders
let configData = null; // { config, pluginSchemas }
let selectedConfigSection = null; // 'server' | 'session' | 'llm' | plugin name
let configDirty = {}; // section -> { key -> newValue }

// ── helpers ────────────────────────────────────────────
function ago(iso) {
  if (!iso) return 'n/a';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}

function fmt(n) { return n.toLocaleString(); }

function shortDir(p) {
  const home = '/home/';
  const i = p.indexOf(home);
  if (i >= 0) return '~/' + p.slice(p.indexOf('/', i + home.length) + 1);
  return p;
}

function elapsed(start, end) {
  const s = Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + '...';
}

// ── tab switching ──────────────────────────────────────
document.getElementById('tab-bar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const tabName = tab.dataset.tab;
  if (tabName === currentTab) return;

  currentTab = tabName;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tabName));

  // close SSE when leaving sessions tab
  if (tabName !== 'sessions' && transcriptEventSource) {
    transcriptEventSource.close();
    transcriptEventSource = null;
  }

  if (tabName === 'sessions') {
    fetchSessionList();
    // reconnect SSE if we had a selected session
    if (selectedSessionId && !transcriptEventSource) {
      loadTranscript(selectedSessionId);
    }
    // scroll transcript to bottom immediately when opening the tab
    // (SSE reconnect scrolls too, but has latency)
    const area = document.getElementById('transcript-area');
    if (area) requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
  }
  if (tabName === 'system-prompt') {
    fetchSystemPrompt();
  }
  if (tabName === 'plugins') {
    fetchPluginContexts();
  }
  if (tabName === 'config') {
    fetchConfig();
  }
});

// ── overview rendering ─────────────────────────────────
function renderOverview(d) {
  let html = '';

  html += '<div class="section-title">server</div>';
  html += '<div style="margin-bottom:1.2rem">';
  html += '<div class="kv"><span class="k">uptime</span><span class="v">' + fmtUptime(d.uptime) + '</span></div>';
  html += '<div class="kv"><span class="k">provider</span><span class="v">' + d.llm.provider + '</span></div>';
  html += '<div class="kv"><span class="k">model</span><span class="v">' + d.llm.model + '</span></div>';
  if (d.llm.effort) html += '<div class="kv"><span class="k">effort</span><span class="v">' + d.llm.effort + '</span></div>';
  html += '<div class="kv"><span class="k">warn at</span><span class="v">' + fmt(d.session.warnAtTokens) + ' tokens</span></div>';
  html += '<div class="kv"><span class="k">compact at</span><span class="v">' + fmt(d.session.compactAtTokens) + ' tokens</span></div>';
  html += '<div class="kv"><span class="k">lifespan</span><span class="v">' + Math.floor(d.session.lifespanSeconds / 60) + ' min</span></div>';
  html += '<div class="kv"><span class="k">tools</span><span class="v">' + d.toolCount + '</span></div>';
  html += '<div class="kv"><span class="k">plugins</span><span class="v"></span></div>';
  html += '<div class="pills">' + d.plugins.map(p => '<span class="pill">' + p + '</span>').join('') + '</div>';
  html += '</div>';

  html += '<div class="section-title">active routes (' + d.sessions.length + ')</div>';
  if (d.sessions.length === 0) {
    html += '<div style="color:#8b949e;font-size:0.8rem">no active sessions</div>';
  } else {
    html += '<div class="grid">';
    for (const s of d.sessions) {
      const busyCls = s.busy ? ' busy' : '';
      html += '<div class="card' + busyCls + '">';
      html += '<h3>' + esc(s.route) + '</h3>';
      html += '<span class="badge ' + (s.busy ? 'busy' : 'idle') + '">' + (s.busy ? 'busy' : 'idle') + '</span>';
      if (s.queuedMessages > 0) html += ' <span class="badge busy">' + s.queuedMessages + ' queued</span>';
      html += '<div class="card-meta">';
      html += '<span>' + fmt(s.tokens) + '</span> tokens &middot; ';
      html += '<span>' + s.messageCount + '</span> messages &middot; ';
      html += '<span>$' + s.cost.toFixed(4) + '</span><br>';
      html += '<span>' + s.wsConnections + '</span> ws connections<br>';
      html += '<span class="timestamp-text">active ' + ago(s.lastActivity) + '</span>';
      if (s.createdAt) html += ' &middot; <span class="timestamp-text">created ' + ago(s.createdAt) + '</span>';
      html += '</div>';
      html += '<div style="margin-top:0.3rem;font-size:0.65rem;color:#484f58;word-break:break-all">' + esc(s.sessionId) + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // coding agent sessions
  const codingPlugins = ['claude-code', 'gemini-cli', 'openai-codex'];
  const ps = d.pluginStatuses || {};
  let activeTasks = [];
  let recentTasks = [];
  for (const name of codingPlugins) {
    const s = ps[name];
    if (!s) continue;
    if (s.tasks) for (const t of s.tasks) activeTasks.push({ ...t, agent: name });
    if (s.recentTasks) for (const t of s.recentTasks) recentTasks.push({ ...t, agent: name });
  }

  if (activeTasks.length > 0 || recentTasks.length > 0) {
    html += '<div class="section-title">coding sessions</div>';
    if (activeTasks.length > 0) {
      html += '<div class="grid" id="coding-active-grid">';
      for (const t of activeTasks) {
        const isExpanded = expandedCodingSessions.has(t.agent + '/' + t.id);
        html += '<div class="card busy coding-card' + (isExpanded ? ' expanded' : '') + '" data-agent="' + esc(t.agent) + '" data-task-id="' + esc(t.id) + '">';
        html += '<h3><span class="agent-label ' + t.agent + '">' + esc(t.agent) + '</span> ';
        html += '<span class="badge running">running</span></h3>';
        html += '<div class="task-desc" title="' + esc(t.description) + '">' + esc(t.description) + '</div>';
        html += '<div class="card-meta">';
        html += 'started ' + ago(t.startedAt);
        if (t.workingDir) html += ' &middot; ' + esc(shortDir(t.workingDir));
        if (t.worktree) html += ' &middot; wt: ' + esc(t.worktree);
        html += '</div>';
        html += '<div style="margin-top:0.3rem;font-size:0.65rem;color:#484f58;word-break:break-all">' + esc(t.id) + '</div>';
        if (isExpanded) html += '<div class="coding-output" id="coding-output-' + esc(t.agent) + '-' + esc(t.id) + '"><div class="coding-output-loading">loading output...</div></div>';
        html += '</div>';
      }
      html += '</div>';
    }
    if (recentTasks.length > 0) {
      html += '<div style="margin-top:0.5rem;margin-bottom:0.6rem;font-size:0.7rem;color:#8b949e">recent</div>';
      html += '<div class="grid" id="coding-recent-grid">';
      for (const t of recentTasks) {
        const ok = t.exitCode === 0;
        const isExpanded = expandedCodingSessions.has(t.agent + '/' + t.id);
        html += '<div class="card coding-card' + (isExpanded ? ' expanded' : '') + '" data-agent="' + esc(t.agent) + '" data-task-id="' + esc(t.id) + '">';
        html += '<h3><span class="agent-label ' + t.agent + '">' + esc(t.agent) + '</span> ';
        html += '<span class="badge ' + (ok ? 'done' : 'failed') + '">' + (ok ? 'done' : 'exit ' + t.exitCode) + '</span></h3>';
        html += '<div class="task-desc" title="' + esc(t.description) + '">' + esc(t.description) + '</div>';
        html += '<div class="card-meta">';
        html += 'ended ' + ago(t.endedAt);
        html += ' &middot; ran ' + elapsed(t.startedAt, t.endedAt);
        if (t.workingDir) html += ' &middot; ' + esc(shortDir(t.workingDir));
        if (t.worktree) html += ' &middot; wt: ' + esc(t.worktree);
        html += '</div>';
        html += '<div style="margin-top:0.3rem;font-size:0.65rem;color:#484f58;word-break:break-all">' + esc(t.id) + '</div>';
        if (isExpanded) html += '<div class="coding-output" id="coding-output-' + esc(t.agent) + '-' + esc(t.id) + '"><div class="coding-output-loading">loading output...</div></div>';
        html += '</div>';
      }
      html += '</div>';
    }
  }

  document.getElementById('panel-overview').innerHTML = html;

  // after rendering, fetch output for any expanded coding sessions
  for (const key of expandedCodingSessions) {
    const [agent, id] = key.split('/');
    fetchCodingOutput(agent, id);
  }
}

// ── coding session expansion ──────────────────────────
document.getElementById('panel-overview').addEventListener('click', (e) => {
  const card = e.target.closest('.coding-card');
  if (!card) return;
  const agent = card.dataset.agent;
  const taskId = card.dataset.taskId;
  const key = agent + '/' + taskId;

  if (expandedCodingSessions.has(key)) {
    // collapse
    expandedCodingSessions.delete(key);
    if (codingOutputPollers[key]) { clearInterval(codingOutputPollers[key]); delete codingOutputPollers[key]; }
    card.classList.remove('expanded');
    const output = card.querySelector('.coding-output');
    if (output) output.remove();
  } else {
    // expand
    expandedCodingSessions.add(key);
    card.classList.add('expanded');
    const outputDiv = document.createElement('div');
    outputDiv.className = 'coding-output';
    outputDiv.id = 'coding-output-' + agent + '-' + taskId;
    outputDiv.innerHTML = '<div class="coding-output-loading">loading output...</div>';
    card.appendChild(outputDiv);
    fetchCodingOutput(agent, taskId);
    // start polling for live updates (active sessions)
    if (card.classList.contains('busy')) {
      codingOutputPollers[key] = setInterval(() => fetchCodingOutput(agent, taskId), 2000);
    }
  }
});

async function fetchCodingOutput(agent, taskId) {
  const key = agent + '/' + taskId;
  const el = document.getElementById('coding-output-' + agent + '-' + taskId);
  if (!el) { if (codingOutputPollers[key]) { clearInterval(codingOutputPollers[key]); delete codingOutputPollers[key]; } return; }

  try {
    const r = await fetch(apiBase + '/coding-session/' + encodeURIComponent(agent) + '/' + encodeURIComponent(taskId) + '/output?tail=80');
    if (!r.ok) { el.innerHTML = '<div class="coding-output-loading" style="color:#f85149">failed to load output</div>'; return; }
    const data = await r.json();

    let html = '';
    if (data.meta && data.meta.task) {
      html += '<div style="margin-bottom:0.5rem;font-size:0.7rem;color:#8b949e"><strong>full prompt:</strong></div>';
      html += '<div style="font-size:0.7rem;color:#c9d1d9;white-space:pre-wrap;margin-bottom:0.6rem;padding:0.4rem;background:#161b22;border-radius:4px;max-height:150px;overflow-y:auto">' + esc(data.meta.task) + '</div>';
    }

    if (data.output && data.output.length > 0) {
      html += '<div style="margin-bottom:0.3rem;font-size:0.7rem;color:#8b949e"><strong>output</strong> <span style="color:#484f58">(' + data.lineCount + ' lines, showing last ' + data.output.length + ')</span></div>';
      for (const line of data.output) {
        if (line.type === 'assistant') {
          html += '<div class="coding-output-line assistant"><span class="line-type">assistant</span>' + esc(truncate(line.text, 500)) + '</div>';
        } else if (line.type === 'user') {
          html += '<div class="coding-output-line user">' + esc(line.text) + '</div>';
        } else if (line.type === 'status') {
          html += '<div class="coding-output-line status"><span class="line-type">status</span>' + esc(line.status) + '</div>';
        } else if (line.type === 'result') {
          let resultText = line.result || '';
          if (line.duration_ms != null) resultText += ' (' + Math.round(line.duration_ms / 1000) + 's)';
          if (line.cost != null) resultText += ' $' + line.cost.toFixed(4);
          html += '<div class="coding-output-line result"><span class="line-type">result</span>' + esc(resultText) + '</div>';
        }
      }
    } else {
      html += '<div class="coding-output-loading">no output yet</div>';
    }

    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = html;
    if (wasNearBottom) el.scrollTop = el.scrollHeight;
  } catch (err) {
    el.innerHTML = '<div class="coding-output-loading" style="color:#f85149">error: ' + esc(err.message) + '</div>';
  }
}

// ── session list ───────────────────────────────────────
async function fetchSessionList() {
  try {
    const r = await fetch(apiBase + '/sessions');
    if (!r.ok) return;
    allSessions = await r.json();
    renderSessionList();
    // auto-select the most recent session if none is selected
    if (!selectedSessionId && !transcriptLoading) {
      const filtered = getFilteredSessions();
      if (filtered.length > 0) {
        selectedSessionId = filtered[0].id;
        renderSessionList();
        loadTranscript(selectedSessionId);
      }
    }
  } catch {}
}

function getRecencyHours() {
  return parseInt(document.getElementById('recency-select').value, 10);
}

function getFilteredSessions() {
  const hours = getRecencyHours();
  if (hours === 0) return allSessions;
  const cutoff = Date.now() - hours * 3600 * 1000;
  return allSessions.filter(s => {
    const t = new Date(s.lastActiveAt).getTime();
    return t >= cutoff;
  });
}

function renderSessionList() {
  const filtered = getFilteredSessions();
  document.getElementById('session-count').textContent = filtered.length;

  const container = document.getElementById('session-items');
  let html = '';
  for (const s of filtered) {
    const active = s.id === selectedSessionId ? ' active' : '';
    // extract route from session id: everything before the date portion
    const routeMatch = s.id.match(/^(.*?)(\\d{4}-\\d{2}-\\d{2}-\\d{4})$/);
    const route = routeMatch ? (routeMatch[1].replace(/-$/, '') || '(default)') : s.id;
    html += '<div class="session-item' + active + '" data-session-id="' + esc(s.id) + '">';
    html += '<div class="route">' + esc(route) + '</div>';
    html += '<div class="session-meta">active ' + ago(s.lastActiveAt) + '</div>';
    html += '<div class="session-id-text">' + esc(s.id) + '</div>';
    html += '</div>';
  }
  if (filtered.length === 0) {
    html = '<div style="padding:1rem;color:#484f58;font-size:0.8rem">no sessions in this time range</div>';
  }
  container.innerHTML = html;
}

document.getElementById('session-items').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const sessionId = item.dataset.sessionId;
  if (sessionId === selectedSessionId) return;
  selectedSessionId = sessionId;
  renderSessionList();
  loadTranscript(sessionId);
});

document.getElementById('recency-select').addEventListener('change', () => {
  renderSessionList();
});

// ── transcript loading & rendering ─────────────────────
let transcriptEventSource = null;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function loadTranscript(sessionId) {
  const area = document.getElementById('transcript-area');
  area.innerHTML = '<div class="transcript-loading">loading transcript...</div>';
  transcriptLoading = true;
  showChatInput(true);

  // close any previous SSE connection
  if (transcriptEventSource) { transcriptEventSource.close(); transcriptEventSource = null; }

  const es = new EventSource(apiBase + '/session/' + encodeURIComponent(sessionId) + '/stream');
  transcriptEventSource = es;

  es.addEventListener('init', (e) => {
    if (selectedSessionId !== sessionId) { es.close(); return; }
    try {
      const entries = JSON.parse(e.data);
      loadedTranscript = { sessionId, entries };
      renderTranscript(entries);
      // scroll to bottom on initial load
      area.scrollTop = area.scrollHeight;
    } catch (err) {
      area.innerHTML = '<div class="transcript-placeholder" style="color:#f85149">error parsing init: ' + esc(err.message) + '</div>';
    }
    transcriptLoading = false;
  });

  es.addEventListener('entry', (e) => {
    if (selectedSessionId !== sessionId) { es.close(); return; }
    if (!loadedTranscript || loadedTranscript.sessionId !== sessionId) return;
    try {
      const entry = JSON.parse(e.data);
      const wasNearBottom = isNearBottom(area);
      const savedScrollTop = area.scrollTop;
      loadedTranscript.entries.push(entry);
      renderTranscript(loadedTranscript.entries);
      if (wasNearBottom) area.scrollTop = area.scrollHeight;
      else area.scrollTop = savedScrollTop;
    } catch {}
  });

  es.onerror = () => {
    if (selectedSessionId !== sessionId) { es.close(); return; }
    // EventSource auto-reconnects; just mark loading done if still loading
    transcriptLoading = false;
  };
}

function renderTranscript(entries) {
  const area = document.getElementById('transcript-area');
  if (entries.length === 0) {
    area.innerHTML = '<div class="transcript-placeholder">empty session</div>';
    return;
  }

  // build a map from tool_use_id -> tool_result block for grouping
  const toolResultMap = {};
  const toolResultOnlyEntryIndices = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const blocks = entry.message.content;
    const hasOnlyToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
    if (hasOnlyToolResults) {
      toolResultOnlyEntryIndices.add(i);
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultMap[block.tool_use_id] = block;
        }
      }
    }
  }

  // group consecutive assistant messages into runs
  const groups = [];
  let currentRun = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'system_prompt') {
      if (currentRun) { groups.push(currentRun); currentRun = null; }
      groups.push({ type: 'system_prompt', entry, index: i });
    } else if (entry.type === 'message') {
      if (toolResultOnlyEntryIndices.has(i)) continue;
      if (entry.message.role === 'assistant') {
        if (!currentRun) currentRun = { type: 'assistant-run', entries: [], indices: [] };
        currentRun.entries.push(entry);
        currentRun.indices.push(i);
      } else {
        if (currentRun) { groups.push(currentRun); currentRun = null; }
        groups.push({ type: 'message', entry, index: i });
      }
    }
  }
  if (currentRun) groups.push(currentRun);

  let html = '';
  let prevRole = null;

  for (const group of groups) {
    if (group.type === 'system_prompt') {
      if (prevRole && prevRole !== 'system') html += '<hr class="turn-separator">';
      html += renderSystemPrompt(group.entry, group.index);
      prevRole = 'system';
    } else if (group.type === 'message') {
      const role = group.entry.message.role;
      if (prevRole && prevRole !== role) html += '<hr class="turn-separator">';
      html += renderMessage(group.entry, toolResultMap);
      prevRole = role;
    } else if (group.type === 'assistant-run') {
      if (prevRole && prevRole !== 'assistant') html += '<hr class="turn-separator">';
      if (group.entries.length === 1) {
        html += renderMessage(group.entries[0], toolResultMap);
      } else {
        html += renderToolRun(group, toolResultMap);
      }
      prevRole = 'assistant';
    }
  }

  area.innerHTML = html;
}

function renderSystemPrompt(entry, entryIndex) {
  const id = 'sp-' + entryIndex;
  const isOpen = openCollapseIds.has(id);
  const openCls = isOpen ? ' open' : '';
  let html = '<div class="system-prompt-entry">';
  html += '<div class="system-prompt-toggle" onclick="toggleCollapse(\\'' + id + '\\')">';
  html += '<span class="toggle-arrow' + openCls + '" id="arrow-' + id + '">&#9654;</span>';
  html += '<span class="role-badge system">system prompt</span>';
  if (entry.timestamp) html += '<span class="entry-timestamp">' + fmtTime(entry.timestamp) + '</span>';
  html += '<span style="margin-left:auto;color:#484f58;font-size:0.65rem">' + fmt(entry.content.length) + ' chars</span>';
  html += '</div>';
  html += '<div class="system-prompt-body' + openCls + '" id="body-' + id + '">' + esc(entry.content) + '</div>';
  html += '</div>';
  return html;
}

function renderMessage(entry, toolResultMap) {
  const msg = entry.message;
  const role = msg.role;
  const bodyClass = role === 'user' ? 'user-body' : 'assistant-body';

  let html = '<div class="entry">';
  html += '<div class="entry-header">';
  html += '<span class="role-badge ' + role + '">' + role + '</span>';
  if (entry.timestamp) html += '<span class="entry-timestamp">' + fmtTime(entry.timestamp) + '</span>';
  if (entry.cost) {
    const c = entry.cost;
    html += '<span class="entry-cost">';
    html += '$' + (c.inputCost + c.outputCost).toFixed(4);
    html += ' (in:' + fmt(c.usage.input) + ' out:' + fmt(c.usage.output);
    if (c.usage.cacheRead) html += ' cache:' + fmt(c.usage.cacheRead);
    html += ')';
    html += '</span>';
  }
  html += '</div>';

  html += '<div class="entry-body ' + bodyClass + '">';
  for (const block of msg.content) {
    if (block.type === 'tool_use' && toolResultMap && toolResultMap[block.id]) {
      // render tool call + its result as a grouped pair
      html += '<div class="content-block tool-group">';
      html += renderToolUse(block);
      html += renderToolResult(toolResultMap[block.id]);
      html += '</div>';
    } else {
      html += renderContentBlock(block);
    }
  }
  html += '</div>';
  html += '</div>';
  return html;
}

function renderToolRun(group, toolResultMap) {
  const id = 'trun-' + group.indices[0];
  const isOpen = openCollapseIds.has(id);
  const openCls = isOpen ? ' open' : '';

  // check if the last entry is a text-only summary (no tool calls)
  const lastEntry = group.entries[group.entries.length - 1];
  const lastHasToolUse = lastEntry.message.content.some(b => b.type === 'tool_use');
  const lastHasText = lastEntry.message.content.some(b => b.type === 'text');
  const hasSummary = !lastHasToolUse && lastHasText && group.entries.length > 1;
  const collapsedEntries = hasSummary ? group.entries.slice(0, -1) : group.entries;

  let toolCallCount = 0;
  let totalCost = 0;
  for (const entry of collapsedEntries) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') toolCallCount++;
    }
    if (entry.cost) totalCost += entry.cost.inputCost + entry.cost.outputCost;
  }

  let html = '<div class="entry tool-run">';
  html += '<div class="tool-run-header" onclick="toggleCollapse(\\'' + id + '\\')">';
  html += '<span class="toggle-arrow' + openCls + '" id="arrow-' + id + '">&#9654;</span>';
  html += '<span class="role-badge assistant">assistant</span>';
  html += '<span class="tool-run-summary">' + toolCallCount + ' tool call' + (toolCallCount !== 1 ? 's' : '') + '...</span>';
  if (totalCost > 0) html += '<span class="entry-cost">$' + totalCost.toFixed(4) + '</span>';
  html += '</div>';
  html += '<div class="tool-run-body' + openCls + '" id="body-' + id + '">';
  for (const entry of collapsedEntries) {
    html += renderMessage(entry, toolResultMap);
  }
  html += '</div>';
  // render final summary message outside the collapsed section
  if (hasSummary) {
    html += renderMessage(lastEntry, toolResultMap);
  }
  html += '</div>';
  return html;
}

function renderContentBlock(block) {
  if (block.type === 'text') {
    return '<div class="content-block text-content">' + esc(block.text) + '</div>';
  }

  if (block.type === 'tool_use') {
    return renderToolUse(block);
  }

  if (block.type === 'tool_result') {
    return renderToolResult(block);
  }

  if (block.type === 'image') {
    return renderImage(block);
  }

  // unknown block type
  return '<div class="content-block" style="color:#484f58;font-size:0.7rem">[' + esc(block.type) + ' block]</div>';
}

function renderToolUse(block) {
  const id = 'tu-' + block.id;
  const isOpen = openCollapseIds.has(id);
  const openCls = isOpen ? ' open' : '';
  const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);

  let html = '<div class="content-block tool-use-block">';
  html += '<div class="tool-use-header" onclick="toggleCollapse(\\'' + id + '\\')">';
  html += '<span class="toggle-arrow' + openCls + '" id="arrow-' + id + '">&#9654;</span>';
  html += '<span class="tool-name">' + esc(block.name) + '</span>';
  html += '<span class="tool-id">' + esc(block.id) + '</span>';
  html += '</div>';
  html += '<div class="tool-use-input' + openCls + '" id="body-' + id + '">' + esc(inputStr) + '</div>';
  html += '</div>';
  return html;
}

function renderToolResult(block) {
  const id = 'tr-' + block.tool_use_id;
  const isOpen = openCollapseIds.has(id);
  const openCls = isOpen ? ' open' : '';
  const isError = block.is_error;
  const errorCls = isError ? ' error' : '';

  let contentText = '';
  if (typeof block.content === 'string') {
    contentText = block.content;
  } else if (Array.isArray(block.content)) {
    contentText = block.content.map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[image]';
      return '[' + (c.type || 'unknown') + ']';
    }).join('\\n');
  }

  // show a short preview in the header
  const preview = truncate(contentText.split('\\n')[0], 80);

  let html = '<div class="content-block tool-result-block' + errorCls + '">';
  html += '<div class="tool-result-header" onclick="toggleCollapse(\\'' + id + '\\')">';
  html += '<span class="toggle-arrow' + openCls + '" id="arrow-' + id + '">&#9654;</span>';
  html += '<span class="result-label">' + (isError ? 'error' : 'result') + '</span>';
  html += '<span style="color:#8b949e;font-size:0.65rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + esc(preview) + '</span>';
  html += '<span class="result-id">' + esc(block.tool_use_id) + '</span>';
  html += '</div>';
  html += '<div class="tool-result-content' + openCls + '" id="body-' + id + '">' + esc(contentText) + '</div>';
  html += '</div>';
  return html;
}

function renderImage(block) {
  if (block.source.type === 'url') {
    return '<div class="content-block image-block"><img src="' + esc(block.source.url) + '" alt="image" loading="lazy"></div>';
  }
  if (block.source.type === 'base64') {
    return '<div class="content-block image-block"><img src="data:' + esc(block.source.media_type) + ';base64,' + block.source.data + '" alt="image" loading="lazy"></div>';
  }
  return '<div class="content-block image-placeholder">[image: unsupported source]</div>';
}

// ── collapsible toggle ─────────────────────────────────
function toggleCollapse(id) {
  const body = document.getElementById('body-' + id);
  const arrow = document.getElementById('arrow-' + id);
  if (!body) return;
  body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open');
  if (openCollapseIds.has(id)) openCollapseIds.delete(id);
  else openCollapseIds.add(id);
}
// expose to onclick handlers
window.toggleCollapse = toggleCollapse;

function toggleSkillGroup(id) {
  if (openSkillGroups.has(id)) {
    openSkillGroups.delete(id);
  } else {
    openSkillGroups.add(id);
  }
  if (selectedPluginName) renderPluginDetail(selectedPluginName);
}
window.toggleSkillGroup = toggleSkillGroup;

// ── chat input ────────────────────────────────────────
function showChatInput(show) {
  const bar = document.getElementById('chat-input-bar');
  if (bar) bar.style.display = show ? 'flex' : 'none';
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  const text = input.value.trim();
  if (!text || !selectedSessionId) return;

  btn.disabled = true;
  input.value = '';
  autoResizeInput();

  try {
    const r = await fetch(apiBase + '/session/' + encodeURIComponent(selectedSessionId) + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      console.error('send failed:', err.error);
    }
  } catch (err) {
    console.error('send error:', err);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
window.sendChatMessage = sendChatMessage;

// auto-resize textarea
function autoResizeInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
}

document.getElementById('chat-input').addEventListener('input', autoResizeInput);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// ── system prompt ───────────────────────────────────────
async function fetchSystemPrompt() {
  try {
    const r = await fetch(apiBase + '/debug/system');
    if (!r.ok) throw new Error(r.statusText);
    const text = await r.text();
    systemPromptText = text;
    renderSystemPromptPanel(text);
  } catch (e) {
    document.getElementById('prompt-meta').textContent = 'error: ' + e.message;
    document.getElementById('prompt-content').innerHTML =
      '<div class="prompt-placeholder" style="color:#f85149">failed to load system prompt</div>';
  }
}

function renderSystemPromptPanel(text) {
  const chars = text.length;
  const lines = text.split('\\n').length;
  const tokens = Math.ceil(chars / 4);
  document.getElementById('prompt-meta').textContent =
    fmt(chars) + ' chars · ~' + fmt(tokens) + ' tokens · ' + fmt(lines) + ' lines · updated ' + new Date().toLocaleTimeString();
  document.getElementById('prompt-content').textContent = text;
}

async function copySystemPrompt() {
  if (!systemPromptText) return;
  const btn = document.getElementById('copy-prompt-btn');
  try {
    await navigator.clipboard.writeText(systemPromptText);
    btn.textContent = 'copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 2000);
  } catch {
    btn.textContent = 'failed';
    setTimeout(() => { btn.textContent = 'copy'; }, 2000);
  }
}
window.copySystemPrompt = copySystemPrompt;

// ── plugin context ─────────────────────────────────────
async function fetchPluginContexts() {
  try {
    const r = await fetch(apiBase + '/status/plugin-context');
    if (!r.ok) return;
    pluginContexts = await r.json();
    document.getElementById('plugin-count').textContent = pluginContexts.length;
    renderPluginList();
    if (selectedPluginName) renderPluginDetail(selectedPluginName);
  } catch {}
}

function renderPluginList() {
  const container = document.getElementById('plugin-items');
  let html = '';
  for (const p of pluginContexts) {
    const active = p.name === selectedPluginName ? ' active' : '';
    const toolCount = p.tools ? p.tools.length : 0;
    const hasPrompt = p.systemPrompt ? true : false;
    html += '<div class="session-item' + active + '" data-plugin-name="' + esc(p.name) + '">';
    html += '<div class="route">' + esc(p.name) + '</div>';
    html += '<div class="session-meta">';
    html += toolCount + ' tool' + (toolCount !== 1 ? 's' : '');
    if (hasPrompt) html += ' · has context';
    html += '</div>';
    html += '</div>';
  }
  if (pluginContexts.length === 0) {
    html = '<div style="padding:1rem;color:#484f58;font-size:0.8rem">no plugins loaded</div>';
  }
  container.innerHTML = html;
}

function renderSkillItem(s) {
  const tag = s.source === 'core' ? 'core' : 'user';
  return '<div class="skill-item">' +
    '<span class="skill-name">' + esc(s.name) + '</span>' +
    '<span class="skill-source">[' + tag + ']</span>' +
    '<span class="skill-desc">' + esc(s.description) + '</span>' +
    '</div>';
}

function renderSkillsDashboard(data) {
  let html = '';

  // ungrouped (foundational) skills — always visible
  if (data.ungrouped && data.ungrouped.length > 0) {
    html += '<div class="plugin-section">';
    html += '<div class="plugin-section-title">skills (' + data.ungrouped.length + ')</div>';
    for (const s of data.ungrouped) {
      html += renderSkillItem(s);
    }
    html += '</div>';
  }

  // grouped skills — collapsible
  if (data.groups && data.groups.length > 0) {
    html += '<div class="plugin-section">';
    html += '<div class="plugin-section-title">skill families (' + data.groups.length + ')</div>';
    for (let i = 0; i < data.groups.length; i++) {
      const g = data.groups[i];
      const gid = 'skill-group-' + i;
      const isOpen = openSkillGroups.has(gid);
      html += '<div class="skill-group-header" onclick="toggleSkillGroup(\\\'' + gid + '\\\')">';
      html += '<span class="skill-group-arrow' + (isOpen ? ' open' : '') + '">&#9654;</span>';
      html += '<span class="skill-group-name">' + esc(g.name) + '</span>';
      html += '<span class="skill-group-count">(' + g.skills.length + ' skills)</span>';
      html += '</div>';
      html += '<div class="skill-group-body' + (isOpen ? ' open' : '') + '" id="' + gid + '">';
      for (const s of g.skills) {
        html += renderSkillItem(s);
      }
      html += '</div>';
    }
    html += '</div>';
  }

  return html;
}

function renderPluginDetail(name) {
  const p = pluginContexts.find(x => x.name === name);
  const area = document.getElementById('plugin-detail-area');
  if (!p) {
    area.innerHTML = '<div class="transcript-placeholder">plugin not found</div>';
    return;
  }

  let html = '<div style="padding:0.5rem 0">';
  html += '<h2 style="color:#58a6ff;font-size:1rem;margin-bottom:1rem">' + esc(p.name) + '</h2>';

  // description
  html += '<div class="plugin-section">';
  html += '<div class="plugin-section-title">description</div>';
  if (p.description) {
    html += '<div class="plugin-context-block">' + esc(p.description) + '</div>';
  } else {
    html += '<div class="plugin-context-block empty">no description</div>';
  }
  html += '</div>';

  // if this plugin provides structured skills data, render the grouped view
  if (p.dashboardData && p.dashboardData.ungrouped) {
    html += renderSkillsDashboard(p.dashboardData);
  }

  // system prompt contribution
  html += '<div class="plugin-section">';
  html += '<div class="plugin-section-title">system prompt contribution</div>';
  if (p.systemPrompt) {
    html += '<div class="plugin-context-block">' + esc(p.systemPrompt) + '</div>';
  } else {
    html += '<div class="plugin-context-block empty">none</div>';
  }
  html += '</div>';

  // tools
  html += '<div class="plugin-section">';
  html += '<div class="plugin-section-title">tools (' + p.tools.length + ')</div>';
  if (p.tools.length > 0) {
    html += '<ul class="plugin-tool-list">';
    for (const t of p.tools) {
      html += '<li><span class="plugin-tool-name">' + esc(t.name) + '</span>';
      html += '<span class="plugin-tool-desc">' + esc(t.description) + '</span></li>';
    }
    html += '</ul>';
  } else {
    html += '<div class="plugin-context-block empty">no tools</div>';
  }
  html += '</div>';

  html += '</div>';
  area.innerHTML = html;
}

document.getElementById('plugin-items').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const name = item.dataset.pluginName;
  if (name === selectedPluginName) return;
  selectedPluginName = name;
  renderPluginList();
  renderPluginDetail(name);
});

// ── config tab ─────────────────────────────────────────
async function fetchConfig() {
  try {
    const r = await fetch(apiBase + '/config');
    if (!r.ok) return;
    configData = await r.json();
    configDirty = {};
    renderConfigSections();
    if (selectedConfigSection) renderConfigDetail(selectedConfigSection);
    else {
      // auto-select first section
      selectedConfigSection = 'server';
      renderConfigSections();
      renderConfigDetail('server');
    }
  } catch {}
}

function getConfigSections() {
  if (!configData) return [];
  const sections = [
    { key: 'server', label: 'server', type: 'core' },
    { key: 'session', label: 'session', type: 'core' },
    { key: 'llm', label: 'llm', type: 'core' },
    { key: 'general', label: 'general', type: 'core' },
  ];
  if (configData.pluginSchemas) {
    for (const p of configData.pluginSchemas) {
      sections.push({ key: 'plugin:' + p.name, label: p.name, type: 'plugin' });
    }
  }
  return sections;
}

function renderConfigSections() {
  const sections = getConfigSections();
  const container = document.getElementById('config-section-items');
  let html = '';
  let lastType = null;
  for (const s of sections) {
    if (s.type !== lastType) {
      html += '<div class="config-section-label">' + (s.type === 'core' ? 'core' : 'plugins') + '</div>';
      lastType = s.type;
    }
    const active = s.key === selectedConfigSection ? ' active' : '';
    html += '<div class="session-item' + active + '" data-config-section="' + esc(s.key) + '">';
    html += '<div class="route">' + esc(s.label) + '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
}

// core config field definitions (mirroring the Zod schema)
const CORE_FIELDS = {
  server: [
    { key: 'port', type: 'number', description: 'server port' },
  ],
  session: [
    { key: 'compactAtTokens', type: 'number', description: 'compaction threshold (tokens)' },
    { key: 'compactMinTokens', type: 'number', description: 'min tokens before compaction', default: 10000 },
    { key: 'warnAtTokens', type: 'number', description: 'context size warning threshold (tokens)', default: 150000 },
    { key: 'lifespanSeconds', type: 'number', description: 'session lifespan (seconds)' },
    { key: 'compactionPrompt', type: 'string', description: 'custom compaction prompt' },
    { key: 'compactionTrimLength', type: 'number', description: 'trim compaction to N chars' },
  ],
  llm: [
    { key: 'provider', type: 'string', description: 'LLM provider name' },
    { key: 'model', type: 'string', description: 'model name' },
    { key: 'apiKey', type: 'string', description: 'API key', secret: true },
    { key: 'effort', type: 'string', description: 'effort level (low/medium/high/max)' },
    { key: 'maxOutputTokens', type: 'number', description: 'max output tokens' },
    { key: 'maxToolResultTokens', type: 'number', description: 'max tool result tokens' },
    { key: 'maxToolResultChars', type: 'number', description: 'max tool result chars' },
    { key: 'baseUrl', type: 'string', description: 'base URL for API' },
    { key: 'thinking', type: 'boolean', description: 'enable thinking/reasoning' },
    { key: 'temperature', type: 'number', description: 'sampling temperature' },
    { key: 'topP', type: 'number', description: 'top-p sampling' },
  ],
  general: [
    { key: 'timezone', type: 'string', description: 'server timezone', default: 'America/New_York' },
    { key: 'notifyOnRestart', type: 'string', description: 'output target to notify on restart' },
    { key: 'restartMessage', type: 'string', description: 'message sent on restart' },
  ],
};

function getFieldsForSection(sectionKey) {
  if (CORE_FIELDS[sectionKey]) return { fields: CORE_FIELDS[sectionKey], values: sectionKey === 'general' ? configData.config : configData.config[sectionKey] || {} };
  // plugin section
  const pluginName = sectionKey.replace('plugin:', '');
  const ps = configData.pluginSchemas.find(p => p.name === pluginName);
  return { fields: ps ? ps.schema : [], values: ps ? (ps.config || {}) : {} };
}

function renderConfigDetail(sectionKey) {
  const area = document.getElementById('config-detail-area');
  if (!configData) { area.innerHTML = '<div class="transcript-placeholder">loading...</div>'; return; }

  const { fields, values } = getFieldsForSection(sectionKey);
  const label = sectionKey.startsWith('plugin:') ? sectionKey.replace('plugin:', '') : sectionKey;
  const dirty = configDirty[sectionKey] || {};

  let html = '<div style="padding:0.5rem 0">';
  html += '<h2 style="color:#58a6ff;font-size:1rem;margin-bottom:1rem">' + esc(label) + '</h2>';

  if (fields.length === 0) {
    html += '<div style="color:#484f58;font-size:0.8rem">no configurable fields</div>';
  } else {
    for (const f of fields) {
      const rawVal = dirty.hasOwnProperty(f.key) ? dirty[f.key] : (sectionKey === 'general' ? configData.config[f.key] : values[f.key]);
      const isSet = rawVal !== undefined && rawVal !== null && rawVal !== '';
      const isModified = dirty.hasOwnProperty(f.key);
      const inputId = 'cfg-' + sectionKey + '-' + f.key;

      html += '<div class="config-field">';
      html += '<label for="' + inputId + '">' + esc(f.key);
      if (f.description) html += '<span class="field-desc">' + esc(f.description) + '</span>';
      if (f.default !== undefined) html += '<span class="field-desc"> (default: ' + esc(String(f.default)) + ')</span>';
      html += '</label>';

      if (f.type === 'boolean') {
        const checked = rawVal === true || rawVal === 'true';
        html += '<div class="checkbox-row">';
        html += '<input type="checkbox" id="' + inputId + '"' + (checked ? ' checked' : '') + ' onchange="onConfigChange(\\'' + esc(sectionKey) + '\\', \\'' + esc(f.key) + '\\', this.checked, \\'boolean\\')">';
        if (!isSet && !isModified) html += '<span class="unset-tag">unset</span>';
        html += '</div>';
      } else if (f.secret && isSet && !isModified) {
        html += '<input type="text" id="' + inputId + '" value="<redacted>" placeholder="(secret)" onfocus="this.value=\\'\\'; this.placeholder=\\'enter new value\\'" onchange="onConfigChange(\\'' + esc(sectionKey) + '\\', \\'' + esc(f.key) + '\\', this.value, \\'' + f.type + '\\')">';
      } else {
        const displayVal = isSet ? String(rawVal) : '';
        html += '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" id="' + inputId + '" value="' + esc(displayVal) + '"' + (isModified ? ' class="modified"' : '') + ' placeholder="' + (isSet ? '' : 'unset') + '" onchange="onConfigChange(\\'' + esc(sectionKey) + '\\', \\'' + esc(f.key) + '\\', this.value, \\'' + f.type + '\\')">';
      }
      html += '</div>';
    }
  }

  // save bar
  const hasChanges = Object.keys(configDirty).some(k => Object.keys(configDirty[k]).length > 0);
  html += '<div class="config-save-bar">';
  html += '<button onclick="saveConfigChanges()"' + (hasChanges ? '' : ' disabled') + '>save</button>';
  html += '<span class="save-status" id="config-save-status">' + (hasChanges ? 'unsaved changes' : '') + '</span>';
  html += '</div>';

  html += '</div>';
  area.innerHTML = html;
}

function onConfigChange(section, key, value, type) {
  if (!configDirty[section]) configDirty[section] = {};
  if (type === 'number') {
    configDirty[section][key] = value === '' ? undefined : Number(value);
  } else if (type === 'boolean') {
    configDirty[section][key] = value;
  } else {
    configDirty[section][key] = value === '' ? undefined : value;
  }
  // re-render to update save bar state
  renderConfigDetail(selectedConfigSection);
}
window.onConfigChange = onConfigChange;

async function saveConfigChanges() {
  const statusEl = document.getElementById('config-save-status');
  statusEl.textContent = 'saving...';

  // build the config update payload
  const update = {};
  for (const [section, changes] of Object.entries(configDirty)) {
    if (Object.keys(changes).length === 0) continue;
    if (section === 'general') {
      // general fields are top-level
      for (const [k, v] of Object.entries(changes)) {
        update[k] = v;
      }
    } else if (section.startsWith('plugin:')) {
      const pluginName = section.replace('plugin:', '');
      if (!update.plugins) update.plugins = { ...configData.config.plugins };
      if (!update.plugins[pluginName]) update.plugins[pluginName] = { ...(configData.config.plugins[pluginName] || {}) };
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined) delete update.plugins[pluginName][k];
        else update.plugins[pluginName][k] = v;
      }
    } else {
      // core section (server, session, llm)
      update[section] = { ...(configData.config[section] || {}) };
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined) delete update[section][k];
        else update[section][k] = v;
      }
    }
  }

  try {
    const r = await fetch(apiBase + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (!r.ok) {
      const err = await r.json();
      statusEl.textContent = 'error: ' + (err.error || r.statusText);
      statusEl.style.color = '#f85149';
      return;
    }
    statusEl.textContent = 'saved! restart server to apply.';
    statusEl.style.color = '#238636';
    // refresh config data
    await fetchConfig();
  } catch (err) {
    statusEl.textContent = 'error: ' + err.message;
    statusEl.style.color = '#f85149';
  }
}
window.saveConfigChanges = saveConfigChanges;

document.getElementById('config-section-items').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const section = item.dataset.configSection;
  if (section === selectedConfigSection) return;
  selectedConfigSection = section;
  renderConfigSections();
  renderConfigDetail(section);
});

// ── polling ────────────────────────────────────────────
async function pollStatus() {
  try {
    const r = await fetch(statusUrl);
    if (!r.ok) throw new Error(r.statusText);
    const d = await r.json();

    document.getElementById('pulse').className = '';
    document.getElementById('meta').textContent =
      'last updated ' + new Date().toLocaleTimeString() + ' · polling every ' + (POLL_MS / 1000) + 's';

    renderOverview(d);
    // update plugin count badge from status data
    document.getElementById('plugin-count').textContent = d.plugins ? d.plugins.length : 0;
  } catch (e) {
    document.getElementById('pulse').className = 'err';
    document.getElementById('meta').textContent = 'error: ' + e.message;
  }
}

// session list polling (less frequent)
let sessionListInterval = null;
function startSessionListPolling() {
  if (sessionListInterval) return;
  fetchSessionList();
  sessionListInterval = setInterval(fetchSessionList, SESSION_LIST_POLL_MS);
}

// ── init ───────────────────────────────────────────────
pollStatus();
setInterval(pollStatus, POLL_MS);
startSessionListPolling();
// refresh system prompt every 30s while tab is visible
setInterval(() => { if (currentTab === 'system-prompt') fetchSystemPrompt(); }, 30000);
</script>
</body>
</html>`;
}
