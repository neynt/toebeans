# google-calendar plugin

CRUD access to Google Calendar via a service account.

## setup

1. create a Google Cloud service account with Calendar API enabled
2. save the key JSON to `~/.toebeans/secrets/google-service-account.json`
3. share your calendar(s) with the service account's email address

## tools

| tool | description |
|-|-|
| `google_calendar_list` | list all calendars the service account can see |
| `google_calendar_events` | list events from a calendar (default: next 7 days, max 20) |
| `google_calendar_create_event` | create an event |
| `google_calendar_update_event` | patch an event (only provided fields change) |
| `google_calendar_delete_event` | delete an event |

every tool except `google_calendar_list` requires a `calendar_id`. use `google_calendar_list` to discover calendar IDs.

## date/time handling

- **all-day events**: use `YYYY-MM-DD` for start/end
- **timed events**: use ISO 8601 datetime (e.g. `2025-03-15T14:30:00`)
- timed events use the configured `timezone` (default `America/New_York`)

## config

in `~/.toebeans/config.json5` under `plugins`:

```json5
"google-calendar": {
  timezone: "America/Toronto",
}
```

## notes

- the calendar API client is lazy-initialized on first tool call and cached
- recurring events are expanded into individual instances (`singleEvents: true`)
- updating attendees replaces the entire list (not a merge)
- event listing is ordered by start time, no pagination
