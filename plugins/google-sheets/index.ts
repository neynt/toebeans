// google-sheets plugin for toebeans
// read/write access to google sheets via service account

import type { Plugin, Tool, ToolResult } from '../../server/types.ts'
import { google } from 'googleapis'
import { readFile } from 'node:fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const SERVICE_ACCOUNT_PATH = join(homedir(), '.toebeans', 'secrets', 'google-service-account.json')

let sheetsClient: ReturnType<typeof google.sheets> | null = null

async function getSheets() {
  if (sheetsClient) return sheetsClient

  const keyJson = JSON.parse(await readFile(SERVICE_ACCOUNT_PATH, 'utf-8'))
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}

function formatAsTable(values: string[][]): string {
  if (!values || values.length === 0) return '(empty)'

  // compute column widths
  const colCount = Math.max(...values.map(row => row.length))
  const widths: number[] = Array(colCount).fill(0)
  for (const row of values) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      widths[i] = Math.max(widths[i], cell.length)
    }
  }

  // render rows
  const lines: string[] = []
  for (const row of values) {
    const cells = []
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      cells.push(cell.padEnd(widths[i]))
    }
    lines.push(cells.join(' | '))
  }

  // add separator after header row
  if (lines.length > 1) {
    const sep = widths.map(w => '-'.repeat(w)).join('-+-')
    lines.splice(1, 0, sep)
  }

  return lines.join('\n')
}

const tools: Tool[] = [
  {
    name: 'google_sheets_read',
    description: 'Read data from a Google Sheet. Returns cell values as a text table.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID from the Google Sheets URL',
        },
        range: {
          type: 'string',
          description: 'A1 notation range (e.g. "Sheet1!A1:D10"). If omitted, reads the entire first sheet.',
        },
      },
      required: ['spreadsheet_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { spreadsheet_id, range } = input as { spreadsheet_id: string; range?: string }

      try {
        const sheets = await getSheets()

        let effectiveRange = range
        if (!effectiveRange) {
          // get first sheet name
          const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheet_id })
          const firstSheet = meta.data.sheets?.[0]?.properties?.title
          if (!firstSheet) {
            return { content: 'no sheets found in spreadsheet', is_error: true }
          }
          effectiveRange = firstSheet
        }

        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheet_id,
          range: effectiveRange,
        })

        const values = (res.data.values ?? []) as string[][]

        // if no explicit range and data exceeds 100 rows, truncate
        if (!range && values.length > 100) {
          const totalRows = values.length
          const colCount = Math.max(...values.map(row => row.length))
          const lastCol = String.fromCharCode(64 + Math.min(colCount, 26))
          const truncated = values.slice(0, 100)
          return {
            content: formatAsTable(truncated) +
              `\n\nShowing 100 of ${totalRows} rows (columns A-${lastCol})`,
          }
        }

        return { content: formatAsTable(values) }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to read sheet: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_sheets_write',
    description: 'Write values to cells in a Google Sheet. Takes an array of {range, value} pairs where range is A1 notation (e.g. "Sheet1!A1").',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID from the Google Sheets URL',
        },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              range: { type: 'string', description: 'Cell in A1 notation (e.g. "Sheet1!B2")' },
              value: { type: 'string', description: 'Value to write' },
            },
            required: ['range', 'value'],
          },
          description: 'Array of {range, value} pairs to write',
        },
      },
      required: ['spreadsheet_id', 'updates'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { spreadsheet_id, updates } = input as {
        spreadsheet_id: string
        updates: { range: string; value: string }[]
      }

      try {
        const sheets = await getSheets()
        const data = updates.map(u => ({
          range: u.range,
          values: [[u.value]],
        }))

        const res = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: spreadsheet_id,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data,
          },
        })

        const updated = res.data.totalUpdatedCells ?? 0
        return { content: `updated ${updated} cell${updated === 1 ? '' : 's'}` }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to write to sheet: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'google_sheets_list',
    description: 'List all sheet/tab names in a Google Spreadsheet.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID from the Google Sheets URL',
        },
      },
      required: ['spreadsheet_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { spreadsheet_id } = input as { spreadsheet_id: string }

      try {
        const sheets = await getSheets()
        const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheet_id })
        const names = (meta.data.sheets ?? [])
          .map(s => s.properties?.title)
          .filter(Boolean)

        if (names.length === 0) {
          return { content: 'no sheets found' }
        }
        return { content: names.join('\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to list sheets: ${error.message}`, is_error: true }
      }
    },
  },
]

export default function create(): Plugin {
  return {
    name: 'google-sheets',
    description: 'read and write google sheets via service account',
    tools,
  }
}
