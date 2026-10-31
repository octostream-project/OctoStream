const PARTY_ID = /^[a-zA-Z0-9_-]{8,80}$/
const ALLOWED_FIELDS = new Set([
  'kind', 'version', 'partyId', 'command', 'mediaKey', 'title',
  'position', 'playing', 'sentAt',
])

export function isValidPartyId(value) {
  return typeof value === 'string' && PARTY_ID.test(value)
}

export function isValidWatchPartyState(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (Object.keys(data).some(key => !ALLOWED_FIELDS.has(key))) return false
  if (data.kind !== 'octostream-watch-party' || data.version !== 1
      || !isValidPartyId(data.partyId) || data.command !== 'state') return false
  if (typeof data.playing !== 'boolean'
      || typeof data.position !== 'number'
      || !Number.isFinite(data.position)
      || data.position < 0 || data.position > 24 * 60 * 60) return false
  if (typeof data.sentAt !== 'number' || !Number.isFinite(data.sentAt)
      || data.sentAt < now - 120_000 || data.sentAt > now + 10_000) return false
  if (typeof data.mediaKey !== 'string' || data.mediaKey.length > 200) return false
  if (typeof data.title !== 'string' || data.title.length < 1 || data.title.length > 240) return false
  return true
}
