# gmail plugin

read, search, compose, and send gmail via OAuth2. manage labels.

## tools

| tool | description |
|------|-------------|
| `gmail_search` | search messages using gmail query syntax. returns id, thread, from, to, subject, date, snippet. |
| `gmail_read` | fetch full message by id. extracts plain text from multipart MIME, falls back to stripped HTML. |
| `gmail_draft` | create a draft email. supports replies via `in_reply_to` (preserves threading). |
| `gmail_send` | send an email directly. same parameters as `gmail_draft`. |
| `gmail_labels` | list all labels with their ids and names. |
| `gmail_modify_labels` | add or remove labels from a message by label id. |

## how it works

authenticates via OAuth2 refresh token. access tokens are cached in memory and auto-refreshed with a 30-second expiry buffer.

`gmail_search` fetches matching message ids, then batch-fetches metadata headers for each result. `gmail_read` fetches the full message and walks the MIME tree — prefers `text/plain`, falls back to `text/html` with tag stripping, handles nested multipart.

`gmail_draft` and `gmail_send` build RFC 2822 messages and base64url-encode them. when `in_reply_to` is set, the original message's `Message-ID` header and `threadId` are fetched and attached so gmail threads the reply correctly.

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
