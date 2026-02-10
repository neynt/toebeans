// google-calendar plugin for toebeans
// CRUD access to google calendar via service account

import type { Plugin, Tool, ToolResult } from '../../server/types.ts'
import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import { readFile } from 'node:fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const SERVICE_ACCOUNT_PATH = join(homedir(), '.toebeans', 'secrets', 'google-service-account.json')

interface GoogleCalendarConfig {
  timezone?: string
}

let pluginConfig: GoogleCalendarConfig = {}
let calendarClient: calendar_v3.Calendar | null = null

async function getCalendar() {
  if (calendarClient) return calendarClient

  const keyJson = JSON.parse(await readFile(SERVICE_ACCOUNT_PATH, 'utf-8'))
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })
  calendarClient = google.calendar({ version: 'v3', auth })
  return calendarClient
}

function formatDateTime(dt: calendar_v3.Schema$EventDateTime | undefined): string {
  if (!dt) return '(none)'
  if (dt.date) return dt.date
  if (dt.dateTime) return dt.dateTime
  return '(none)'
}

function formatEvent(event: calendar_v3.Schema$Event): string {
  const lines: string[] = []
  lines.push(`ID: ${event.id}`)
  lines.push(`Summary: ${event.summary ?? '(no title)'}`)
  lines.push(`Start: ${formatDateTime(event.start)}`)
  lines.push(`End: ${formatDateTime(event.end)}`)
  if (event.location) lines.push(`Location: ${event.location}`)
  if (event.description) lines.push(`Description: ${event.description}`)
  if (event.attendees?.length) {
    const emails = event.attendees.map(a => a.email).filter(Boolean)
    lines.push(`Attendees: ${emails.join(', ')}`)
  }
  if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`)
  return lines.join('\n')
}

/** Build a start/end object that supports all-day (date-only) and dateTime. */
function buildEventDateTime(value: string): calendar_v3.Schema$EventDateTime {
  // date-only: YYYY-MM-DD (10 chars, no T)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value }
  }
  return { dateTime: value, timeZone: pluginConfig.timezone ?? 'America/New_York' }
}

const tools: Tool[] = [
  {
    name: 'google_calendar_list',
    description: 'List all calendars the service account has access to.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const cal = await getCalendar()
        const res = await cal.calendarList.list()
        const items = res.data.items ?? []
        if (items.length === 0) {
          return { content: 'no calendars found' }
        }
        const lines = items.map(c =>
          `${c.summary ?? '(unnamed)'} | ${c.id} | ${c.accessRole ?? 'unknown'}`
        )
        return { content: 'Name | Calendar ID | Role\n' + lines.join('\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to list calendars: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_calendar_events',
    description: 'List events from a calendar. Defaults to showing the next 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID (email-like string)',
        },
        time_min: {
          type: 'string',
          description: 'ISO 8601 start time filter (defaults to now)',
        },
        time_max: {
          type: 'string',
          description: 'ISO 8601 end time filter (defaults to 7 days from now)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of events to return (default 20)',
        },
      },
      required: ['calendar_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { calendar_id, time_min, time_max, max_results = 20 } = input as {
        calendar_id: string
        time_min?: string
        time_max?: string
        max_results?: number
      }

      try {
        const cal = await getCalendar()
        const now = new Date()
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

        const res = await cal.events.list({
          calendarId: calendar_id,
          timeMin: time_min ?? now.toISOString(),
          timeMax: time_max ?? weekFromNow.toISOString(),
          maxResults: max_results,
          singleEvents: true,
          orderBy: 'startTime',
        })

        const events = res.data.items ?? []
        if (events.length === 0) {
          return { content: 'no events found in the given time range' }
        }

        return { content: events.map(formatEvent).join('\n\n---\n\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to list events: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_calendar_create_event',
    description: 'Create a new calendar event. Use YYYY-MM-DD for all-day events or full ISO 8601 datetime for timed events.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID',
        },
        summary: {
          type: 'string',
          description: 'Event title',
        },
        start: {
          type: 'string',
          description: 'Start time — YYYY-MM-DD for all-day or ISO 8601 datetime',
        },
        end: {
          type: 'string',
          description: 'End time — YYYY-MM-DD for all-day or ISO 8601 datetime',
        },
        description: {
          type: 'string',
          description: 'Event description',
        },
        location: {
          type: 'string',
          description: 'Event location',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee email addresses',
        },
      },
      required: ['calendar_id', 'summary', 'start', 'end'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { calendar_id, summary, start, end, description, location, attendees } = input as {
        calendar_id: string
        summary: string
        start: string
        end: string
        description?: string
        location?: string
        attendees?: string[]
      }

      try {
        const cal = await getCalendar()
        const event: calendar_v3.Schema$Event = {
          summary,
          start: buildEventDateTime(start),
          end: buildEventDateTime(end),
        }
        if (description) event.description = description
        if (location) event.location = location
        if (attendees?.length) {
          event.attendees = attendees.map(email => ({ email }))
        }

        const res = await cal.events.insert({
          calendarId: calendar_id,
          requestBody: event,
        })

        return { content: formatEvent(res.data) }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to create event: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_calendar_update_event',
    description: 'Update an existing calendar event. Only provided fields will be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID',
        },
        event_id: {
          type: 'string',
          description: 'The event ID to update',
        },
        summary: {
          type: 'string',
          description: 'New event title',
        },
        start: {
          type: 'string',
          description: 'New start time',
        },
        end: {
          type: 'string',
          description: 'New end time',
        },
        description: {
          type: 'string',
          description: 'New event description',
        },
        location: {
          type: 'string',
          description: 'New event location',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of attendee email addresses (replaces existing)',
        },
      },
      required: ['calendar_id', 'event_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { calendar_id, event_id, summary, start, end, description, location, attendees } = input as {
        calendar_id: string
        event_id: string
        summary?: string
        start?: string
        end?: string
        description?: string
        location?: string
        attendees?: string[]
      }

      try {
        const cal = await getCalendar()
        const patch: calendar_v3.Schema$Event = {}
        if (summary !== undefined) patch.summary = summary
        if (start !== undefined) patch.start = buildEventDateTime(start)
        if (end !== undefined) patch.end = buildEventDateTime(end)
        if (description !== undefined) patch.description = description
        if (location !== undefined) patch.location = location
        if (attendees !== undefined) patch.attendees = attendees.map(email => ({ email }))

        const res = await cal.events.patch({
          calendarId: calendar_id,
          eventId: event_id,
          requestBody: patch,
        })

        return { content: formatEvent(res.data) }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to update event: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_calendar_delete_event',
    description: 'Delete an event from a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID',
        },
        event_id: {
          type: 'string',
          description: 'The event ID to delete',
        },
      },
      required: ['calendar_id', 'event_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { calendar_id, event_id } = input as {
        calendar_id: string
        event_id: string
      }

      try {
        const cal = await getCalendar()
        await cal.events.delete({
          calendarId: calendar_id,
          eventId: event_id,
        })
        return { content: `deleted event ${event_id}` }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to delete event: ${error.message}`, is_error: true }
      }
    },
  },
]

export default function create(): Plugin {
  return {
    name: 'google-calendar',
    description: 'read and manage google calendar events via service account',
    tools,

    async init(cfg: unknown) {
      pluginConfig = (cfg as GoogleCalendarConfig) ?? {}
    },
  }
}
