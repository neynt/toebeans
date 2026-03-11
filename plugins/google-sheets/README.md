# google-sheets plugin

read and write google sheets via a service account. all access goes through the Google Sheets API v4.

## setup

place a service account credentials JSON at `~/.toebeans/secrets/google-service-account.json`. the service account needs the `spreadsheets` scope. share target spreadsheets with the service account's email address.

## tools

| Tool | Description |
|------|-------------|
| `google_sheets_read` | Read data from a sheet. Returns a formatted text table. If no range given, reads the entire first sheet (truncated to 100 rows). |
| `google_sheets_write` | Batch-write values to individual cells. Takes an array of `{range, value}` pairs in A1 notation (e.g. `"Sheet1!B2"`). |
| `google_sheets_append` | Append rows to the end of a sheet. Each row is a `string[]`. Defaults to `Sheet1` if no sheet name given. |
| `google_sheets_list` | List all sheet/tab names in a spreadsheet. |

## ranges and tabs

all ranges use A1 notation: `Sheet1!A1:D10`, `Sheet1!B2`, etc.

- `read` with no range auto-detects the first sheet and reads it all
- `write` requires explicit sheet-qualified cell ranges
- `append` takes a `sheet` parameter (default `"Sheet1"`) and appends after existing data

## data shape

- all cell values are strings
- `write` uses `valueInputOption: USER_ENTERED`, so google sheets will parse formulas and numeric types on its end
- `read` returns an ASCII-aligned table with a header separator after the first row
- `append` takes `rows: string[][]` — array of rows, each row an array of cell values

## notes

- credentials are loaded lazily on first tool call and cached for the process lifetime
- reads without an explicit range are auto-truncated to 100 rows to keep context manageable
- `append` uses `insertDataOption: INSERT_ROWS`
- `spreadsheet_id` is the long ID from the spreadsheet URL, not the full URL
