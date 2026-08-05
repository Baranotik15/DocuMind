/**
 * Formats a byte count as a human-readable size (`"842 B"`, `"12.3 KB"`,
 * `"1.4 MB"`) - binary (1024-based) units, one decimal place once the unit
 * is bigger than bytes. `null` (a pre-existing row from before
 * `fileSizeBytes` existed) renders as an em dash, same "unknown, not zero"
 * convention the Logs table already uses for a null `userEmail`.
 */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}
