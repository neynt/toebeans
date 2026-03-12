# gmail plugin

read, search, compose, and send gmail via OAuth2. full draft lifecycle management and label operations.

## tools

| tool | description |
|------|-------------|
| `gmail_search` | search messages using gmail query syntax. returns id, thread, from, to, subject, date, snippet. |
| `gmail_read` | fetch full message by id. extracts plain text from multipart MIME, falls back to stripped HTML. |
| `gmail_drafts_list` | list drafts with optional search query. returns draft id, message id, to, subject, date, snippet. |
| `gmail_draft_read` | read a draft's full content by draft id. returns headers and body. |
| `gmail_draft_create` | create a new draft. supports plain text and optional HTML (multipart/alternative). supports replies via `in_reply_to`. returns draft id. |
| `gmail_draft_update` | update an existing draft in place by draft id. same compose params as create; draft id is preserved. |
| `gmail_draft_delete` | permanently delete a draft by draft id. |
| `gmail_send` | send an email directly. same compose parameters as `gmail_draft_create`. |
| `gmail_labels` | list all labels with their ids and names. |
| `gmail_modify_labels` | add or remove labels from a message by label id. |

## draft workflow

the draft tools are designed around a read-modify-write pattern:

1. **find drafts** — `gmail_drafts_list` to browse or search existing drafts
2. **read a draft** — `gmail_draft_read` to see full content (headers + body) by draft id
3. **create or update** — `gmail_draft_create` for new drafts, `gmail_draft_update` to revise in place
4. **delete** — `gmail_draft_delete` to discard a draft

draft ids and message ids are different things. `gmail_drafts_list` and `gmail_draft_create` return draft ids. `gmail_read` takes message ids (from `gmail_search`). use `gmail_draft_read` when you have a draft id.

### replying to a thread

both `gmail_draft_create` and `gmail_draft_update` accept `in_reply_to` (a message id). when set, the tool fetches the original message's `Message-ID` header and `threadId`, then adds `In-Reply-To` and `References` headers so gmail threads the reply correctly. the subject is auto-prefixed with "Re: " if needed.

### html emails

`gmail_draft_create`, `gmail_draft_update`, and `gmail_send` accept an optional `html_body` parameter. when provided, the email is constructed as `multipart/alternative` with both `text/plain` and `text/html` parts. the plain `body` is always required and serves as the fallback for clients that can't render HTML.

when `html_body` is omitted, emails are sent as plain `text/plain` — no behavioral change from before.

## how it works

authenticates via OAuth2 refresh token. access tokens are cached in memory and auto-refreshed with a 30-second expiry buffer.

`gmail_search` fetches matching message ids, then batch-fetches metadata headers for each result. `gmail_read` fetches the full message and walks the MIME tree — prefers `text/plain`, falls back to `text/html` with tag stripping, handles nested multipart.

draft and send tools build RFC 2822 messages and base64url-encode them. when `html_body` is provided, the message uses `multipart/alternative` with both text/plain and text/html parts; otherwise it's plain text/plain. the Gmail API's drafts endpoint supports POST (create), PUT (update), GET (read), and DELETE operations, all of which are exposed.

## setup

requires a Google OAuth2 credential file at `~/.toebeans/secrets/gmail-oauth.json`:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```

you'll need a Google Cloud project with the Gmail API enabled and an OAuth consent screen configured. the refresh token must have sufficient scopes for the operations you want (e.g. `gmail.readonly`, `gmail.compose`, `gmail.modify`).

## notes

- the `From:` header is hardcoded in `buildMessage` — edit it to match your account
- search uses [gmail's query syntax](https://support.google.com/mail/answer/7190): `from:`, `to:`, `is:unread`, `subject:`, `label:`, date ranges, etc.
- `gmail_search` defaults to 10 results; pass `max_results` to change
- `gmail_modify_labels` takes label IDs, not names — use `gmail_labels` to look them up
- no plugin-level rate limiting; gmail API quotas apply
- all tools return `is_error: true` on failure with the error message

## migration from previous version

the old `gmail_draft` tool has been replaced by `gmail_draft_create` with the same parameters. if you have any automation referencing `gmail_draft`, rename it to `gmail_draft_create`.
