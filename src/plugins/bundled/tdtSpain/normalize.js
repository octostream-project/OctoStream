// Normalization helpers for TDT Spain: EPG lookup and channel normalization.

import { normKey } from './constants.js'
import { CONTENT_TYPES } from '../../base.js'

export function currentEvent(epg, epgId) {
  if (!epg || !epgId) return null
  // Try multiple key variants: exact, normalized, with .TV suffix
  const keys = [
    String(epgId),
    normKey(epgId),
    String(epgId) + '.TV',
    normKey(epgId) + '.tv',
    normKey(String(epgId) + '.TV'),
  ]
  let events = null
  for (const k of keys) {
    if (epg[k] && epg[k].length > 0) { events = epg[k]; break }
  }
  if (!events) return null

  const now = Math.floor(Date.now() / 1000)
  for (const ev of events) {
    // Support both raw EPG fields (hi/hf/t) and mapped fields (startTimestamp/endTimestamp/title)
    const hi = ev.startTimestamp || parseInt(ev.hi || 0)
    const hf = ev.endTimestamp || parseInt(ev.hf || 0)
    if (hi <= now && now < hf) return ev
  }
  return null
}

// Next event after the current one (for "A continuación" in the zap overlay)
export function nextEvent(epg, epgId) {
  if (!epg || !epgId) return null
  const keys = [
    String(epgId),
    normKey(epgId),
    String(epgId) + '.TV',
    normKey(epgId) + '.tv',
    normKey(String(epgId) + '.TV'),
  ]
  let events = null
  for (const k of keys) {
    if (epg[k] && epg[k].length > 0) { events = epg[k]; break }
  }
  if (!events) return null

  const now = Math.floor(Date.now() / 1000)
  let best = null
  for (const ev of events) {
    const hi = ev.startTimestamp || parseInt(ev.hi || 0)
    if (hi > now && (!best || hi < (best.startTimestamp || parseInt(best.hi || 0)))) best = ev
  }
  return best
}

export function normalizeChannel(ch, epg) {
  // Try to find current program using multiple identifiers
  const cur = currentEvent(epg, ch.epgid || ch.id) || currentEvent(epg, ch.name)
  const nxt = nextEvent(epg, ch.epgid || ch.id) || nextEvent(epg, ch.name)
  const logo = ch.logo || ch.image || ''
  const name = ch.name || ch.id
  let overview = 'Canal TDT en directo'
  const nowTitle = cur?.title || cur?.t || cur?.name || ''
  const nextTitle = nxt?.title || nxt?.t || nxt?.name || ''
  // Timestamps (epoch s) para la barra de progreso del programa en el player
  const nowStart = cur ? (cur.startTimestamp || parseInt(cur.hi || 0) || 0) : 0
  const nowEnd = cur ? (cur.endTimestamp || parseInt(cur.hf || 0) || 0) : 0
  const nextStart = nxt ? (nxt.startTimestamp || parseInt(nxt.hi || 0) || 0) : 0
  if (cur) {
    const desc = cur.description || cur.d || cur.desc || ''
    overview = `Ahora: ${nowTitle}\n${desc}`
  }
  return {
    id: `tdtspain-${ch.id}`,
    type: CONTENT_TYPES.LIVE,
    name,
    title: name,
    poster: logo,
    logo,
    description: overview,
    genres: [ch.group || 'TDT'],
    quality: 'LIVE',
    nowPlaying: nowTitle,
    nextPlaying: nextTitle,
    nowPlayingStart: nowStart,
    nowPlayingEnd: nowEnd,
    nextPlayingStart: nextStart,
    group: ch.group || 'Otros',
    _raw: ch,
  }
}
