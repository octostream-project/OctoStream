// Shared formatting helpers.

/** Format seconds as "Xh Ym" or "Ym". Returns '' for non-positive values. */
export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  if (hours > 0) return `${hours}h ${remainingMins}m`
  return `${remainingMins}m`
}
