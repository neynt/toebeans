// shared timezone-aware time formatting
// uses the configured timezone (defaults to America/New_York)

let configuredTimezone = 'America/New_York'

export function setTimezone(tz: string) {
  configuredTimezone = tz
}

export function getTimezone(): string {
  return configuredTimezone
}

/** Format a Date as "2024-02-05 14:30:00 EST" */
export function formatLocalTime(date: Date): string {
  const datePart = formatLocalDate(date)
  const timePart = formatLocalTimeOnly(date)
  return `${datePart} ${timePart}`
}

/** Format just the time portion as "14:30:00 EST" */
export function formatLocalTimeOnly(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: configuredTimezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  })
}

/** Format just the date as "2024-02-05" (in local timezone) */
export function formatLocalDate(date: Date): string {
  // use sv-SE locale for ISO-like YYYY-MM-DD format
  return date.toLocaleDateString('sv-SE', { timeZone: configuredTimezone })
}
