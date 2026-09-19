// Data loading: channels, EPG, U7D, RTVE HLS map.

import { CHANNELS_URL, EPG_URL, U7D_URL, TDTCHANNELS_M3U, RTVE_HLS_FALLBACK, normKey, twarn } from './constants.js'
import { fetchGzJson, fetchJson, fetchText } from './http.js'
import { saveCache } from './cache.js'
import { logWarn } from '../../../utils/logger.js'

export async function getChannels(cache) {
  if (cache.channels && Date.now() - (cache.channelsTs || cache.ts || 0) < 60 * 60 * 1000) return cache
  const data = await fetchJson(CHANNELS_URL)
  cache.streamTypes = data.streamstype || {}
  cache.channels = data.canales || []
  cache.channelsTs = Date.now()
  cache.ts = Date.now()
  saveCache(cache)
  return cache
}

export function getEpg(cache) {
  // Solo epgTs cuenta para la frescura del EPG; cache.ts cambia al guardar
  // channels/u7d y marcaría un EPG viejo como fresco.
  if (cache.epg && Object.keys(cache.epg).length > 0 && Date.now() - (cache.epgTs || 0) < 60 * 60 * 1000) {
    return Promise.resolve(cache)
  }
  // Guard in-flight: si ya hay un fetch EPG en curso, reutilizarlo.
  if (!cache._epgPromise) {
    cache._epgPromise = fetchEpg(cache).finally(() => { cache._epgPromise = null })
  }
  return cache._epgPromise
}

async function fetchEpg(cache) {
  try {
    const data = await fetchGzJson(EPG_URL)
    const m = {}
    if (Array.isArray(data)) {
      for (const ch of data) {
        if (ch && ch.name) {
          const events = (ch.events || ch.programs || ch.epg || []).map(ev => ({
            title: ev.t || ev.title || ev.name || '',
            description: ev.d || ev.desc || ev.description || '',
            start: ev.hi ? new Date(ev.hi * 1000).toISOString() : (ev.start || null),
            end: ev.hf ? new Date(ev.hf * 1000).toISOString() : (ev.end || ev.stop || null),
            startTimestamp: ev.hi || null,
            endTimestamp: ev.hf || null,
            duration: ev.hi && ev.hf ? (ev.hf - ev.hi) : (ev.duration || 0),
            genre: ev.g || ev.genre || '',
          }))
          m[String(ch.name)] = events
          m[normKey(ch.name)] = events
        }
      }
    }
    cache.epg = m
    cache.epgTs = Date.now()
    saveCache(cache)
  } catch (e) {
    logWarn('TDT Spain EPG fetch failed', String(e?.message || e))
    twarn('[TDT Spain] EPG fetch error:', e)
  }
  return cache
}

// Carga channels + EPG antes de normalizar el catálogo. Las tarjetas de TV
// necesitan el EPG ya disponible para mostrar el programa actual; cargarlo en
// background dejaba nowPlaying vacío y no había una segunda normalización.
// getEpg tiene guard in-flight: no duplica fetches si ya hay uno en curso.
export async function getChannelsAndEpg(cache) {
  if (!(cache.channels && Date.now() - (cache.channelsTs || cache.ts || 0) < 60 * 60 * 1000)) await getChannels(cache)
  await getEpg(cache)
  return cache
}

export async function getU7d(cache) {
  if (cache.u7d && Date.now() - cache.ts < 60 * 60 * 1000) return cache
  try {
    cache.u7d = await fetchJson(U7D_URL)
    saveCache(cache)
  } catch (e) {
    logWarn('TDT Spain U7D fetch failed', String(e?.message || e))
    cache.u7d = {}
  }
  return cache
}

export async function getRtveHls(cache) {
  if (cache.rtveHls && Date.now() - cache.ts < 60 * 60 * 1000) return cache.rtveHls
  const m = {}
  for (const [cid, url] of Object.entries(RTVE_HLS_FALLBACK)) {
    m[cid] = url
    m[normKey(cid)] = url
  }

  try {
    const body = await fetchText(TDTCHANNELS_M3U, { Referer: 'https://www.tdtchannels.com/' })
    let curId = null, curName = null
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#EXTINF:')) {
        const idMatch = trimmed.match(/tvg-id="([^"]+)"/)
        const nameMatch = trimmed.match(/tvg-name="([^"]+)"/)
        curId = idMatch?.[1] || null
        curName = nameMatch?.[1] || null
        if (!curName) {
          const commaMatch = trimmed.match(/,\s*(.+?)\s*$/)
          curName = commaMatch?.[1] || null
        }
      } else if (/^https?:\/\//.test(trimmed) && /rtve|ztnr/.test(trimmed.toLowerCase())) {
        const keys = []
        if (curId) keys.push(curId, normKey(curId))
        if (curName) keys.push(normKey(curName))
        for (const k of keys) {
          if (!m[k] || /rtvelivestream/.test(trimmed)) m[k] = trimmed
        }
        curId = curName = null
      }
    }
  } catch (e) {
    logWarn('TDT Spain RTVE M3U fetch failed, using fallbacks', String(e?.message || e))
  }

  cache.rtveHls = m
  saveCache(cache)
  return m
}
