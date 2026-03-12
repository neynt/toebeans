# discord

chat with your agent through discord. supports guilds and DMs, voice message
transcription, image/file attachments, and per-channel session routing.

## how it works

each discord channel or DM maps to its own agent session. incoming messages are
queued into the agent loop with an `outputTarget` of `discord:<channelId>`. the
agent's text responses are automatically routed back to the originating channel
— no tool call needed.

incoming messages are annotated with context:
- guild: `[#channel channelId, from username]`
- DM: `[DM from username, channel_id: X]`

## tools

| tool | description |
|-|-|
| `discord_send` | send a message to a channel. **don't use this** if the current outputTarget already points at a discord channel (e.g. from a timer) — your text response is already routed there and calling this would duplicate it |
| `discord_read_history` | fetch recent messages from a channel (default 20, max 100) |
| `discord_react` | add a reaction to a message. supports `"last"` as message_id shorthand |
| `discord_send_image` | upload an image file to a channel |
| `discord_fetch_attachment` | download a message's attachments to disk, returns local paths |
| `discord_list_channels` | list all accessible text channels across all guilds |

## output formatting

text responses stream into a single discord message per assistant turn, edited
in-place roughly every 2 seconds as more text arrives. the initial message is
delayed ~2 seconds to avoid a flickery one-character stub; if the response
completes before the delay, the full text is sent as a single message. this
avoids the choppy multi-message behavior of splitting on paragraph boundaries.
if a response exceeds discord's 2000-char limit, the current message is
finalized at a clean break point (\n\n > \n > space) and a new message is
started for the remainder.

tool calls appear as inline code: `` `🔧 toolname: brief (tokens)` ``, updated
with ✅/❌ and token counts when results arrive.

with `condenseToolCalls: true`, tool calls are shown as a single live-updating
progress message that edits in-place as each tool starts and completes. each
tool gets a status line (⏳ running, ✅ done, ❌ failed) with a brief summary
and token counts. the message is sent immediately on the first tool call, then
updated on each subsequent tool_use/tool_result event. when the batch finishes
(next text output or turn end), it gets a final "done" header.

a separate `logChannel` can be configured for verbose tool call/result logs with
full JSON inputs and outputs (unaffected by condensing).

## attachments and media

- **images**: downloaded as base64, resized with ImageMagick if >4MB. passed as
  content blocks to the LLM.
- **voice messages**: transcribed via whisper (configurable model), transcription
  echoed back to channel for verification.
- **other files**: saved to `~/.toebeans/discord/attachments/` with 7-day
  auto-cleanup.

## slash commands

| command | effect |
|-|-|
| `/status` | session info: message count, tokens, age, active claude-code sessions, upcoming timers |
| `/stop` | abort current operation |
| `/compact` | force session compaction with summary |
| `/reset` | clear session without summary |

## config

```json5
{
  token: "...",                    // discord bot token (required)
  allowedUsers: ["user_id"],       // whitelist of discord user IDs (required)
  channels: ["channel_id"],        // limit to specific channels (empty = all)
  onlyRespondToMentions: false,    // require @mention in guilds
  allowDMs: true,
  transcribeVoice: true,
  whisperModel: "medium",
  typingDelayMaxMs: 1000,
  typingDelayPerCharMs: 10,
  logChannel: "channel_id",        // verbose tool call logs
  condenseToolCalls: false,        // live-updating progress message for tool calls
}
```

## operational notes

- `allowedUsers` is **required**. messages from non-whitelisted users are
  silently ignored.
- requires discord intents: `Guilds`, `GuildMessages`, `DirectMessages`,
  `MessageContent`. enable the message content privileged intent in the discord
  developer portal.
- image resizing requires `magick`. voice transcription requires `ffmpeg`.
- sends are serialized per session to prevent out-of-order delivery.
- typing indicators re-fire every 4s, capped at 5 minutes.
- ⏳ reactions on user messages indicate the message is queued in the agent loop.
