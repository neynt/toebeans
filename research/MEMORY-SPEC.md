# Memory System Redesign Spec

## Current Architecture

### File layout

```
~/.toebeans/
  SOUL.md                       # personality/identity (user-written)
  config.json                   # plugin config, session settings
  knowledge/
    USER.md                     # bot-maintained user profile
    YYYY-MM-DD.md               # daily session logs (append-only)
    *.md                        # ad-hoc topic files (created via `remember` tool)
  sessions/
  workspace/
```

### System prompt assembly

Built fresh every agent turn in `server/index.ts:363-383`:

1. **SOUL.md** (`~/.toebeans/SOUL.md`, fallback to `server/default-soul.md`)
   - loaded once at server startup, cached in `soul` variable
2. **Plugin system prompts** (`pluginManager.buildSystemPrompts()`)
   - memory plugin contributes: full USER.md + last N days of daily logs (default N=2)
3. **Working directory** (one line)
4. **Plugin descriptions section** (tool availability listing)

### Memory plugin (`plugins/memory/index.ts`)

**Tools:**
- `remember(topic, content, append?)` — write/append a markdown file in `knowledge/`
- `recall(topic?, query?)` — read a specific file, list all files, or `rg` search across all files

**`buildSystemPrompt()`** — injects into system prompt every turn:
- Full contents of `knowledge/USER.md`
- Full contents of daily logs for the last `recentLogDays` days (default 2)
- These are joined under a `## Recent Activity` heading

**`onPreCompaction(context)`** — runs before session compaction:
1. Reads current USER.md
2. Trims tool results in conversation to `compactionTrimLength` chars (default 200)
3. Sends trimmed conversation to LLM with extraction prompt
4. LLM responds with `## Summary` and optionally `## User Profile`
5. Summary appended to today's daily log (`knowledge/YYYY-MM-DD.md`)
6. If profile section present, USER.md is fully overwritten

### The problem

Daily logs for the last 2 days are loaded in full into the system prompt. On active days this can be 5,000-10,000+ tokens of low-value context. The system prompt has been observed at ~15k tokens total, which is expensive and wastes context window.

Topic files (`knowledge/*.md`) are only accessible via the `recall` tool — the bot has no awareness they exist unless it decides to list/search them.

There is no periodic curation of USER.md — it can only grow during compaction. No mechanism to offload less-important facts into topic files.

---

## Target Architecture

### File layout (unchanged paths, changed semantics)

```
~/.toebeans/
  SOUL.md                       # tier 1: user-written, not bot-modified (NO CHANGE)
  knowledge/
    USER.md                     # tier 2: bot-maintained, loaded in full
    *.md (non-date files)       # tier 3: topic files, filenames listed in prompt
    YYYY-MM-DD.md               # tier 4: daily logs, NOT in system prompt
```

### Tier definitions

#### Tier 1 — SOUL.md (`~/.toebeans/SOUL.md`)
- **Written by:** user (manually)
- **Modified by bot:** never
- **In system prompt:** always, first position
- **Changes needed:** none

#### Tier 2 — USER.md (`~/.toebeans/knowledge/USER.md`)
- **Written by:** bot (during compaction)
- **Modified by bot:** yes, full rewrite during compaction (same as today)
- **In system prompt:** always, loaded in full
- **New behavior:** weekly trimming pass moves less-essential info to topic files
- **Target size:** ~1000 tokens max (soft guideline enforced by extraction prompt)

#### Tier 3 — Topic files (`~/.toebeans/knowledge/*.md`, excluding date files)
- **Written by:** bot (via `remember` tool, or during weekly trim of USER.md)
- **In system prompt:** filenames only, listed so the bot knows they exist
- **Accessible via:** `recall` tool (read, search) — same as today
- **Format in prompt:** a short listing like:
  ```
  ## Available Knowledge Files
  anki-chinese-workflow, daily-schedule-preferences, delegation-style, discord-style, ...
  ```

#### Tier 4 — Daily logs (`~/.toebeans/knowledge/YYYY-MM-DD.md`)
- **Written by:** bot (during compaction, same as today)
- **In system prompt:** NOT loaded (this is the key change)
- **Accessible via:** `recall` tool (grep/read on demand)
- **No other changes** to how they're written

### System prompt assembly (new order)

1. SOUL.md (unchanged)
2. USER.md in full (unchanged)
3. Topic file listing — filenames only (NEW)
4. Working directory (unchanged)
5. Plugin descriptions (unchanged)

Daily logs are **removed** from the system prompt entirely.

---

## Concrete Code Changes

### 1. `plugins/memory/index.ts` — `buildSystemPrompt()`

**Current behavior (lines 250-292):**
- Reads and includes full USER.md
- Reads and includes full daily logs for last N days

**New behavior:**
- Reads and includes full USER.md (unchanged)
- **Remove** daily log loading entirely
- **Add** directory listing of topic files: scan `knowledge/` for `*.md`, exclude date-pattern files (`/^\d{4}-\d{2}-\d{2}\.md$/`) and `USER.md`, collect remaining filenames, format as a compact listing

**Prompt format for topic file listing:**
```
## Available Knowledge Files
Use `recall` to read these when relevant: anki-chinese-workflow, daily-schedule-preferences, ...
```
If no topic files exist, omit this section.

### 2. `plugins/memory/index.ts` — `onPreCompaction()` extraction prompt

**Current behavior (lines 7-26):**
- Asks for `## Summary` and optionally `## User Profile`

**New behavior:**
- Same two sections, no change to extraction prompt
- (Weekly trimming is a separate concern — see item 4)

No changes here for now. The extraction prompt already instructs the LLM to keep USER.md concise (~1000 tokens). Weekly trimming is a future enhancement.

### 3. `plugins/memory/index.ts` — `recall` tool

No changes needed. It already supports:
- Listing all files (including topic files and daily logs)
- Reading specific files by topic name
- Searching across all files with `rg`

The bot can already grep daily logs on demand — removing them from the system prompt just means it needs to use `recall` explicitly when it wants historical context.

### 4. Weekly USER.md trimming (NEW — optional/future)

**Not implemented in v1.** This is a future enhancement:
- A periodic hook (weekly) that:
  1. Reads USER.md
  2. Sends it to LLM asking: "move less-essential facts to topic files, keep only the most important stuff in USER.md"
  3. LLM outputs a trimmed USER.md and a set of `remember` calls for offloaded facts
- Could be triggered on first compaction after midnight Sunday, or via a cron-like mechanism
- For now, the extraction prompt already caps USER.md at ~1000 tokens, and the user can manually curate topic files

### 5. `cli/debug/analyze-system-prompt.ts`

**Current behavior (lines 81-97):**
- Loads and displays token count for recent daily logs

**New behavior:**
- Remove daily log loading
- Add topic file listing section (scan for non-date, non-USER.md files, format as comma-separated names)
- Display token count for the listing

### 6. `plugins/memory/index.ts` — helper function

**Add** a helper to distinguish topic files from daily logs:

```typescript
function isDateFile(filename: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(filename)
}
```

Used by `buildSystemPrompt()` to filter the file listing.

---

## Migration

No data migration needed. All files stay in the same locations with the same formats. The only change is what gets loaded into the system prompt.

Existing daily logs remain in `knowledge/` and are still accessible via `recall`. They just stop being injected into every turn's system prompt.

The `recentLogDays` config option becomes unused and can be removed from the config type, or left as a no-op for backwards compat.

---

## Token Budget Impact

**Before (typical active day):**
- SOUL.md: ~300 tokens
- USER.md: ~200 tokens
- Recent daily logs (2 days): ~3,000-10,000 tokens
- Working dir + plugin descriptions: ~300 tokens
- **Total: ~4,000-11,000 tokens**

**After:**
- SOUL.md: ~300 tokens
- USER.md: ~200 tokens
- Topic file listing: ~50-100 tokens
- Working dir + plugin descriptions: ~300 tokens
- **Total: ~850-900 tokens**

Savings: ~3,000-10,000 tokens per turn, depending on daily log size.

---

## Summary of files to change

| File | Change |
|------|--------|
| `plugins/memory/index.ts` | Remove daily log injection from `buildSystemPrompt()`. Add topic file listing. Add `isDateFile()` helper. |
| `cli/debug/analyze-system-prompt.ts` | Replace daily log section with topic file listing section. |
| `plugins/memory/index.ts` (config type) | `recentLogDays` becomes unused — remove or deprecate. |

**Files NOT changed:**
- `server/index.ts` (system prompt assembly order unchanged)
- `server/session.ts` (paths unchanged)
- `server/session-manager.ts` (compaction flow unchanged)
- `server/default-soul.md` (unchanged)
- `~/.toebeans/knowledge/*` (no data migration)
