// U7D search for TDT Spain.

import { CONTENT_TYPES } from '../../base.js'
import { tlog } from './constants.js'
import { fetchJson } from './http.js'
import { getU7d } from './data.js'
import { logWarn } from '../../../utils/logger.js'

// Cache de listings U7D por canal y día natural: evita relanzar ~70
// peticiones HTTP en cada búsqueda. El contenido de un día apenas cambia.
const u7dFeedCache = new Map()
const U7D_FEED_TTL = 30 * 60 * 1000
const ONE_DAY = 24 * 60 * 60 * 1000

async function fetchU7dDay(callSign, dayStart) {
  const key = `${callSign}|${dayStart}`
  const hit = u7dFeedCache.get(key)
  if (hit && Date.now() - hit.ts < U7D_FEED_TTL) return hit.listings

  const end = dayStart + ONE_DAY
  const url = `https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=${callSign}&byListingTime=${dayStart}~${end}`
  const data = await fetchJson(url).catch(() => null)

  // Guardar solo los campos necesarios para el filtrado y la tarjeta.
  const listings = []
  for (const entry of (data?.response?.entries || [])) {
    for (const l of (entry.listings || [])) {
      const prog = l.program || {}
      listings.push({
        title: l['mediasetlisting$epgTitle'] || '',
        desc: l.description || '',
        startTime: l.startTime || 0,
        endTime: l.endTime || 0,
        hasVod: !!prog['mediasetprogram$hasVod'],
        rights: prog['mediasetprogram$channelsRights'] || [],
        poster: prog.thumbnails?.image_keyframe_poster?.url || prog.thumbnails?.image_horizontal_cover?.url || '',
        guid: prog.guid || '',
      })
    }
  }
  u7dFeedCache.set(key, { listings, ts: Date.now() })
  if (u7dFeedCache.size > 120) {
    const oldest = u7dFeedCache.keys().next().value
    u7dFeedCache.delete(oldest)
  }
  return listings
}

export async function searchU7d(query, cache) {
  const q = (query || '').toLowerCase()
  if (!q) return []
  try {
    cache = await getU7d(cache)
    const u7d = cache.u7d || {}
    const u7dConf = u7d.U7dConf || {}
    const results = []

    const mediasetChannels = []
    for (const [chKey, chData] of Object.entries(u7dConf)) {
      const u7dUrl = chData.u7ddata || ''
      if (!u7dUrl || !/^https?:\/\//.test(u7dUrl)) continue
      if (!/mediaset/.test(u7dUrl)) continue
      const callSignMatch = u7dUrl.match(/byCallSign=([^&]+)/)
      const callSign = callSignMatch ? callSignMatch[1] : ''
      if (!callSign) continue
      const chName = chData.idchannel || chKey
      const chMatch = cache.channels?.find(c => c.id === chKey || c.epgid === chKey)
      mediasetChannels.push({ chKey, callSign, chName, chMatch })
    }

    // Ventanas alineadas a días naturales: últimos 7 días + hoy.
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const fetches = []
    for (const mc of mediasetChannels) {
      for (let d = 0; d < 7; d++) {
        const dayStart = todayStart.getTime() - d * ONE_DAY
        fetches.push({ mc, promise: fetchU7dDay(mc.callSign, dayStart) })
      }
    }
    const responses = await Promise.all(fetches.map(f => f.promise))

    for (let i = 0; i < fetches.length; i++) {
      const { mc } = fetches[i]
      for (const listing of (responses[i] || [])) {
        const title = listing.title
        const desc = listing.desc
        if (!title.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue
        const startTs = Math.floor(listing.startTime / 1000)
        const isFree = listing.hasVod && listing.rights.includes('AVOD')
        if (!isFree) continue
        results.push({
          id: `u7d-${mc.chKey}-${startTs}-${listing.guid || 'NOGUID'}`,
          type: CONTENT_TYPES.LIVE,
          name: title,
          title,
          description: desc,
          poster: listing.poster,
          channelName: mc.chMatch?.name || mc.chName,
          channelId: mc.chKey,
          startTimestamp: startTs,
          startTime: startTs ? new Date(startTs * 1000).toISOString() : '',
          endTimestamp: Math.floor(listing.endTime / 1000),
          hasVod: listing.hasVod,
          isFree,
          playable: isFree,
          guid: listing.guid,
        })
      }
    }
    tlog('[TDT Spain] U7D search for', query, ':', results.length, 'results')
    // Deduplicar por título + hora de inicio + poster: el feed puede devolver
    // el mismo programa en ventanas de días solapadas.
    const seen = new Set()
    const deduped = []
    for (const r of results) {
      const key = `${(r.title || '').toLowerCase().trim()}|${r.startTimestamp || 0}|${r.poster || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(r)
    }
    return deduped
  } catch (e) {
    logWarn('TDT Spain U7D search failed', String(e?.message || e))
    return []
  }
}
