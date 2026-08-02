/**
 * Formats an ISO 8601 timestamp (e.g. `2026-08-01T18:57:34.529342+00:00`, the
 * shape `DocumentSummary.uploadedAt` comes back as from the backend) as
 * `DD.MM.YYYY HH:mm` (24-hour clock) in the browser's local timezone - the
 * most useful reading for an operator watching the Upload table live, rather
 * than the raw UTC instant. `Date`'s local getters (`getDate`/`getMonth`/...)
 * already do the UTC-to-local conversion; this just formats the result.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day}.${month}.${year} ${hours}:${minutes}`
}
