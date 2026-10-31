export const LIVE_EARLY_MS = 15 * 60 * 1000
export const LIVE_DURATION_MS = 4 * 60 * 60 * 1000

export function isMatchInLiveWindow(matchDate, now = Date.now()) {
  return Number.isFinite(matchDate)
    && matchDate > 0
    && matchDate > now - LIVE_DURATION_MS
    && matchDate <= now + LIVE_EARLY_MS
}

export function preferFctvMatchDate(fctvDate, fallbackDate = 0) {
  if (Number.isFinite(fctvDate) && fctvDate > 0) return fctvDate
  return Number.isFinite(fallbackDate) && fallbackDate > 0 ? fallbackDate : 0
}

export function matchesForSportsView(items, view, dayStart, dayEnd, now = Date.now()) {
  const list = Array.isArray(items) ? items : []
  const hasScore = (item) => item?._score?.home != null && item?._score?.away != null
  const inDay = (item) => item?._matchDate >= dayStart && item?._matchDate < dayEnd

  if (view === 'live') return list.filter(item => item._isLive)
  if (view === 'today') return list.filter(inDay)
  if (view === 'results') {
    return list.filter(item => !item._isLive && hasScore(item)
      && (!item._matchDate || inDay(item)))
  }
  if (view === 'upcoming') {
    return list.filter(item => !hasScore(item) && !item._isLive
      && inDay(item) && item._matchDate > now)
  }
  return list
}
