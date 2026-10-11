// Cache helpers for TDT Spain.

import { CACHE_KEY, CACHE_TTL_MS, normKey } from './constants.js'
import { getItemSync, setItemSync } from '../../../utils/storage.js'

// Single shared in-memory cache object. Avoids re-reading localStorage
// and re-fetching on every plugin operation.
let sharedCache = null

export function getSharedCache() {
  if (!sharedCache) {
    sharedCache = loadCache()
  }
  return sharedCache
}

export function loadCache() {
  try {
    const raw = getItemSync(CACHE_KEY)
    if (!raw) return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0 }
    const parsed = JSON.parse(raw)
    // Validate shape to avoid crashes on corrupt data
    if (!parsed || typeof parsed !== 'object') {
      return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0 }
    }
    return {
      channels: parsed.channels || null,
      streamTypes: parsed.streamTypes || {},
      epg: parsed.epg || {},
      u7d: parsed.u7d || null,
      rtveHls: parsed.rtveHls || null,
      ts: parsed.ts || 0,
      epgTs: parsed.epgTs || 0,
      channelsTs: parsed.channelsTs || 0,
      u7dTs: parsed.u7dTs || 0,
      rtveHlsTs: parsed.rtveHlsTs || 0,
    }
  } catch {
    return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0, epgTs: 0, channelsTs: 0, u7dTs: 0, rtveHlsTs: 0 }
  }
}

export function saveCache(cache) {
  try {
    // Prune EPG entries older than 2 days to limit storage size.
    // Cada canal se indexa dos veces (nombre crudo + normKey) apuntando al
    // MISMO array: deduplicar por referencia y quedarse con una sola clave
    // — las consultas prueban normKey como fallback, así que no se pierde
    // cobertura y el JSON persistido baja a la mitad.
    if (cache.epg) {
      const cutoff = Date.now() / 1000 - 2 * 24 * 60 * 60
      const entries = Object.entries(cache.epg)
      // Preferir la clave normalizada (== su normKey) como representante.
      entries.sort(([a], [b]) => (a === normKey(a) ? 0 : 1) - (b === normKey(b) ? 0 : 1))
      const seen = new Set()
      const deduped = {}
      for (const [chKey, events] of entries) {
        if (!Array.isArray(events) || seen.has(events)) continue
        seen.add(events)
        deduped[chKey] = events.filter(ev => {
          const end = ev.endTimestamp || ev.hf || 0
          return end > cutoff
        })
      }
      cache.epg = deduped
    }
    // Strip internal in-flight promise guards (keys starting with _)
    const out = { ts: Date.now() }
    for (const [k, v] of Object.entries(cache)) {
      if (!k.startsWith('_')) out[k] = v
    }
    setItemSync(CACHE_KEY, JSON.stringify(out))
    sharedCache = cache
  } catch {
    // storage full, ignore
  }
}

export function isCacheFresh(cache, key = 'channels') {
  return cache[key] && Date.now() - cache.ts < CACHE_TTL_MS
}
