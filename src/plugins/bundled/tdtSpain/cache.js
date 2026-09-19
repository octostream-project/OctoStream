// Cache helpers for TDT Spain.

import { CACHE_KEY, CACHE_TTL_MS } from './constants.js'
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
    }
  } catch {
    return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0, epgTs: 0, channelsTs: 0 }
  }
}

export function saveCache(cache) {
  try {
    // Prune EPG entries older than 2 days to limit storage size
    if (cache.epg) {
      const cutoff = Date.now() / 1000 - 2 * 24 * 60 * 60
      for (const [chKey, events] of Object.entries(cache.epg)) {
        if (!Array.isArray(events)) continue
        const filtered = events.filter(ev => {
          const end = ev.endTimestamp || ev.hf || 0
          return end > cutoff
        })
        if (filtered.length !== events.length) {
          cache.epg[chKey] = filtered
        }
      }
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
