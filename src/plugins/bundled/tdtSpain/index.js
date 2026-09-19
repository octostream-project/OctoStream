// TDT Spain bundled plugin (refactored into modules).
// TDT Spain plugin for OctoStream.
// Uses TDTSpain public APIs: channels, EPG, U7D (last 7 days).
// Resolves live streams for RTVE, Atresplayer, Mediaset and direct HLS.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { logWarn } from '../../../utils/logger.js'
import { supportsProductionWidevine } from '../../../utils/platform.js'
import { RESOLVABLE_TYPES, normKey, tlog, twarn } from './constants.js'
import { getSharedCache } from './cache.js'
import { getChannels, getChannelsAndEpg, getEpg, getU7d } from './data.js'
import { fetchJson } from './http.js'
import { resolveLiveStream, resolveU7dStream } from './resolve.js'
import { normalizeChannel } from './normalize.js'
import { searchU7d } from './search.js'

const isHidden = channel => ['1', 'true', 'yes'].includes(String(channel?.ocultar || '').toLowerCase())

export const tdtSpainFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'tdtspain',
    name: config.manifest?.name || 'TDT Spain',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'TDT España: directos, EPG y últimos 7 días. RTVE, Atresmedia, Mediaset y más.',
    types: [CONTENT_TYPES.LIVE, CONTENT_TYPES.CHANNEL],
    catalogs: [
      { id: 'tdtspain-all', name: 'Todos los canales', type: CONTENT_TYPES.LIVE },
      { id: 'tdtspain-groups', name: 'Por grupo', type: CONTENT_TYPES.LIVE },
      { id: 'u7d-tdtspain', name: 'Últimos 7 días', type: CONTENT_TYPES.LIVE },
    ],
    icon: 'tv',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 100 }) {
      try {
        let cache = getSharedCache()
        // Carga channels + EPG en paralelo (antes era secuencial → 2x lento)
        cache = await getChannelsAndEpg(cache)
        const channels = cache.channels || []
        const visible = channels.filter(ch => !isHidden(ch))

        if (id === 'tdtspain-live') {
          const live = visible.filter(ch => RESOLVABLE_TYPES.has(String(ch.streamtype || '')))
          return live.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
        }

        if (id === 'tdtspain-groups') {
          const groups = new Set()
          for (const ch of visible) {
            if (!RESOLVABLE_TYPES.has(String(ch.streamtype || ''))) continue
            const g = String(ch.group || '').split(';')[0].trim()
            if (g) groups.add(g)
          }
          return [...groups].sort().map(g => ({
            id: `tdtspain-group-${g}`,
            type: CONTENT_TYPES.LIVE,
            name: g,
            title: g,
            description: `Canales del grupo ${g}`,
            genres: [g],
            isGroup: true,
          }))
        }

        if (id.startsWith('tdtspain-group-')) {
          const groupName = id.replace('tdtspain-group-', '')
          const groupChannels = visible.filter(ch => {
            const g = String(ch.group || '').split(';')[0].trim()
            return g === groupName && RESOLVABLE_TYPES.has(String(ch.streamtype || ''))
          })
          return groupChannels.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
        }

        if (id === 'u7d-tdtspain') {
          cache = await getU7d(cache)
          const u7d = cache.u7d || {}
          const u7dConf = u7d.U7dConf || {}
          const items = []
          for (const [chKey, chData] of Object.entries(u7dConf)) {
            if (chData.u7dtype === 'stream10' && !supportsProductionWidevine()) continue
            const chName = chData.idchannel || chKey
            const u7dUrl = chData.u7ddata || ''
            if (u7dUrl && /^https?:\/\//.test(u7dUrl)) {
              const chMatch = cache.channels?.find(c => c.id === chKey || c.epgid === chKey)
              items.push({
                id: `u7d-channel-${chKey}`,
                type: CONTENT_TYPES.LIVE,
                name: chMatch?.name || chName,
                title: chMatch?.name || chName,
                channelId: chKey,
                channelName: chMatch?.name || chName,
                channelLogo: chMatch?.logo || '',
                logo: chMatch?.logo || '',
                u7dUrl,
                isU7dChannel: true,
              })
            }
          }
          return items.slice(skip, skip + top)
        }

        if (id.startsWith('u7d-programs-')) {
          return getU7dPrograms(id, cache, skip, top)
        }

        const resolvable = visible.filter(ch => RESOLVABLE_TYPES.has(String(ch.streamtype || '')))
        return resolvable.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
      } catch (e) {
        logWarn('TDT Spain getCatalog failed', String(e?.message || e))
        return []
      }
    },

    async getMeta({ id }) {
      try {
        if (id.startsWith('u7d-')) {
          // Parse the ID: u7d-{chKey}-{startTs}-{guid?}
          const parts = id.match(/^u7d-(.+?)-(\d+(?:\.\d+)?)(?:-([A-Za-z0-9_]+|NOGUID))?$/)
          const chKey = parts?.[1] || ''
          const startTs = parts ? parseFloat(parts[2]) : 0
          const timeStr = startTs ? new Date(startTs * 1000).toLocaleString('es-ES') : ''

          // Try to find the actual program name from the U7D catalog
          let programName = ''
          let programDesc = ''
          let poster = ''
          let channelName = ''
          try {
            const programs = await getU7dPrograms(`u7d-programs-${chKey}`, getSharedCache(), 0, 200)
            const found = programs.find(p => p.id === id || (p.startTimestamp && Math.abs(p.startTimestamp - startTs) < 1))
            if (found) {
              programName = found.name || found.title || ''
              programDesc = found.description || ''
              poster = found.poster || ''
              channelName = found.channelName || ''
            }
          } catch {
            // ignore lookup errors
          }

          return {
            id,
            type: CONTENT_TYPES.LIVE,
            name: programName || `Programa U7D${chKey ? ' - ' + chKey.replace('.TV','') : ''}`,
            title: programName || 'Programa U7D',
            description: programDesc || `Contenido de los últimos 7 días${timeStr ? ' - ' + timeStr : ''}`,
            poster,
            channelName,
            isU7d: true,
          }
        }

        let cache = getSharedCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)

        const chId = id.replace(/^tdtspain-/, '')
        const ch = cache.channels?.find(c => String(c.id) === chId)
        if (!ch) return null
        return normalizeChannel(ch, cache.epg)
      } catch (e) {
        logWarn('TDT Spain getMeta failed', String(e?.message || e))
        return null
      }
    },

    async getStreams({ id }) {
      try {
        tlog('[TDT Spain] getStreams called for', id)
        let cache = getSharedCache()
        cache = await getChannels(cache)

        if (id.startsWith('u7d-')) {
          tlog('[TDT Spain] Resolving U7D stream for', id)
          const stream = await resolveU7dStream(id, cache)
          tlog('[TDT Spain] U7D stream result:', stream ? stream.url.substring(0, 80) : 'NULL')
          if (stream) {
            return [{ name: stream.name || 'U7D', url: stream.url, streamType: stream.streamType || 'hls', quality: stream.quality || 'VOD', lang: 'Esp', headers: stream.headers, drm: stream.drm }]
          }
          return []
        }

        const chId = id.replace(/^tdtspain-/, '')
        const ch = cache.channels?.find(c => String(c.id) === chId)
        if (!ch) return []
        const stream = await resolveLiveStream(ch, cache)
        if (!stream) return []
        return [{
          name: ch.name || 'TDT Spain',
          url: stream.url,
          streamType: stream.streamType || 'hls',
          quality: stream.quality || 'LIVE',
          lang: 'Esp',
          headers: stream.headers,
          drm: stream.drm,
        }]
      } catch (e) {
        logWarn('TDT Spain getStreams failed', String(e?.message || e))
        return []
      }
    },

    async search({ query }) {
      try {
        let cache = getSharedCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const q = (query || '').toLowerCase()
        const channels = cache.channels || []
        const channelResults = channels
          .filter(ch => {
            const name = String(ch.name || '').toLowerCase()
            const cid = String(ch.id || '').toLowerCase()
            const group = String(ch.group || '').toLowerCase()
            return name.includes(q) || cid.includes(q) || group.includes(q)
          })
          .filter(ch => !isHidden(ch))
          .map(ch => normalizeChannel(ch, cache.epg))

        let u7dResults = []
        if (supportsProductionWidevine()) {
          u7dResults = await searchU7d(query, cache)
        }

        return [...channelResults, ...u7dResults]
      } catch (e) {
        logWarn('TDT Spain search failed', String(e?.message || e))
        return []
      }
    },

    async getEpg({ date, channelId } = {}) {
      try {
        let cache = getSharedCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const epg = cache.epg || {}
        const channels = cache.channels || []
        const targetDate = date ? new Date(date) : new Date()
        const dayStr = targetDate.toISOString().slice(0, 10)
        let searchChannels = channels
        if (channelId) {
          searchChannels = channels.filter(ch => String(ch.id) === channelId || String(ch.epgid) === channelId)
        }
        const programs = []
        for (const ch of searchChannels) {
          if (isHidden(ch)) continue
          const epgId = String(ch.epgid || ch.id || '')
          let events = epg[epgId] || epg[normKey(epgId)] || []
          if (events.length === 0) {
            const chName = String(ch.name || '')
            events = epg[chName] || epg[normKey(chName)] || []
          }
          for (const ev of events) {
            if (!ev.start) continue
            const evStart = new Date(ev.start)
            if (evStart.toISOString().slice(0, 10) !== dayStr) continue
            programs.push({
              id: `${ch.id}-${evStart.getTime()}`,
              channelId: ch.id,
              channelName: ch.name,
              channelLogo: ch.logo,
              title: ev.title || 'Sin título',
              description: ev.description || '',
              start: ev.start,
              end: ev.end,
              startTimestamp: ev.startTimestamp || evStart.getTime() / 1000,
              duration: ev.duration || 0,
            })
          }
        }
        return programs
      } catch (e) {
        logWarn('TDT Spain getEpg failed', String(e?.message || e))
        twarn('[TDT Spain] getEpg error:', e)
        return []
      }
    },
  })
}

// U7D programs catalog (kept here because it's tightly coupled to catalog flow).
async function getU7dPrograms(id, cache, skip, top) {
  const chKey = id.replace('u7d-programs-', '')
  cache = await getU7d(cache)
  const u7d = cache.u7d || {}
  const u7dConf = u7d.U7dConf || {}
  const chData = u7dConf[chKey]
  if (!chData || (chData.u7dtype === 'stream10' && !supportsProductionWidevine())) return []
  const u7dUrl = chData.u7ddata || ''
  if (!u7dUrl || !/^https?:\/\//.test(u7dUrl)) return []
  const chName = chData.idchannel || chKey
  const chMatch = cache.channels?.find(c => c.id === chKey || c.epgid === chKey)
  try {
    const items = []
    const isAtresplayer = /atresplayer/.test(u7dUrl)
    const isMediaset = /mediaset/.test(u7dUrl)
    const isRtve = /rtve/.test(u7dUrl)

    if (isMediaset) {
      const callSignMatch = u7dUrl.match(/byCallSign=([^&]+)/)
      const callSign = callSignMatch ? callSignMatch[1] : ''
      if (callSign) {
        const now = Date.now()
        const ONE_DAY = 24 * 60 * 60 * 1000
        const dayFetches = []
        for (let d = 0; d < 7; d++) {
          const end = now - d * ONE_DAY
          const start = end - ONE_DAY
          // byListingTime requiere formato ISO 8601 (no epoch)
          const dayUrl = `https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=${callSign}&byListingTime=${new Date(start).toISOString()}~${new Date(end).toISOString()}`
          dayFetches.push(fetchJson(dayUrl).catch(() => null))
        }
        const dayResults = await Promise.all(dayFetches)
        for (const mediasetData of dayResults) {
          if (!mediasetData) continue
          const entries = mediasetData.response?.entries || mediasetData.entry || []
          for (const entry of entries) {
            const listings = entry.listings || []
            for (const listing of listings) {
              const prog = listing.program || {}
              const startMs = listing.startTime || 0
              const endMs = listing.endTime || 0
              const startTs = Math.floor(startMs / 1000)
              const hasVod = !!prog['mediasetprogram$hasVod']
              const guid = prog.guid || ''
              const rights = prog['mediasetprogram$channelsRights'] || []
              const isFree = hasVod && rights.includes('AVOD')
              if (!isFree) continue
              const thumbs = prog.thumbnails || {}
              const poster = thumbs['image_keyframe_poster']?.url || thumbs['image_horizontal_cover']?.url || ''
              items.push({
                id: `u7d-${chKey}-${startTs || Math.random()}-${guid || 'NOGUID'}`,
                type: CONTENT_TYPES.LIVE,
                name: listing['mediasetlisting$epgTitle'] || listing.title || 'Sin título',
                title: listing['mediasetlisting$epgTitle'] || listing.title || 'Sin título',
                description: listing.description || prog.description || '',
                poster,
                channelName: chMatch?.name || chName,
                channelId: chKey,
                startTimestamp: startTs,
                startTime: startTs ? new Date(startTs * 1000).toISOString() : '',
                endTimestamp: Math.floor(endMs / 1000),
                hasVod,
                isFree,
                playable: true,
                guid,
                _raw: listing,
              })
            }
          }
        }
      }
    } else {
      const progData = await fetchJson(u7dUrl)
      if (isAtresplayer) {
        const progs = progData.itemRows || progData.items || []
        for (const prog of progs) {
          const startMs = prog.startTime || 0
          const startTs = Math.floor(startMs / 1000)
          items.push({
            id: `u7d-${chKey}-${startTs || Math.random()}`,
            type: CONTENT_TYPES.LIVE,
            name: prog.title || 'Sin título',
            title: prog.title || 'Sin título',
            description: prog.description || prog.stickerU7D || '',
            poster: prog.image?.pathHorizontal ? prog.image.pathHorizontal + '640x360.jpg' : '',
            channelName: chMatch?.name || chName,
            channelId: chKey,
            startTimestamp: startTs,
            startTime: startTs ? new Date(startTs * 1000).toISOString() : '',
            _raw: prog,
          })
        }
      } else if (isRtve) {
        const progs = progData.items || progData.programs || progData.events || (Array.isArray(progData) ? progData : [])
        for (const prog of progs) {
          const idAsset = prog.idAsset || prog.idPrograma || ''
          if (!idAsset) continue
          let startTs = 0, startStr = ''
          const bt = prog.begintime || prog.start || prog.begin || prog.startTime
          if (bt && /^\d{14}$/.test(bt)) {
            const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
            const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
            const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
            startTs = dt.getTime() / 1000; startStr = dt.toISOString()
          }
          items.push({
            id: `u7d-${chKey}-${startTs || Math.random()}`,
            type: CONTENT_TYPES.LIVE,
            name: prog.name || prog.title || 'Sin título',
            title: prog.name || prog.title || 'Sin título',
            description: prog.description || prog.desc || '',
            // El feed de schedule de RTVE no incluye imágenes; la CDN expone la
            // miniatura del episodio directamente por idAsset.
            poster: prog.poster || prog.thumbnail || `https://img.rtve.es/v/${idAsset}?w=400`,
            channelName: chMatch?.name || chName,
            channelId: chKey,
            startTimestamp: startTs,
            startTime: startStr,
            idAsset: String(idAsset),
            _raw: prog,
          })
        }
      } else {
        const progs = progData.items || progData.programs || progData.events || progData.itemRows || (Array.isArray(progData) ? progData : [])
        for (const prog of progs) {
          let startTs = 0, startStr = ''
          const bt = prog.begintime || prog.start || prog.begin || prog.startTime
          if (bt && /^\d{14}$/.test(bt)) {
            const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
            const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
            const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
            startTs = dt.getTime() / 1000; startStr = dt.toISOString()
          } else if (typeof bt === 'number' && bt > 1000000000000) {
            startTs = Math.floor(bt / 1000); startStr = new Date(bt).toISOString()
          }
          items.push({
            id: `u7d-${chKey}-${startTs || Math.random()}`,
            type: CONTENT_TYPES.LIVE,
            name: prog.name || prog.title || prog.t || 'Sin título',
            title: prog.name || prog.title || prog.t || 'Sin título',
            description: prog.description || prog.desc || prog.d || '',
            poster: prog.poster || prog.thumbnail || prog.image?.pathHorizontal || '',
            channelName: chMatch?.name || chName,
            channelId: chKey,
            startTimestamp: startTs,
            startTime: startStr,
            _raw: prog,
          })
        }
      }
    }

    items.sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
    // Deduplicar por título + hora de inicio + poster: el feed de Mediaset
    // puede devolver el mismo programa en ventanas de días solapadas.
    const seen = new Set()
    const deduped = []
    for (const item of items) {
      const key = `${(item.title || '').toLowerCase().trim()}|${item.startTimestamp || 0}|${item.poster || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(item)
    }
    return deduped.slice(skip, skip + top)
  } catch (e) {
    logWarn(`TDT Spain U7D fetch failed for ${chKey}`, String(e?.message || e))
    twarn('[TDT Spain] U7D error for', chKey, ':', e?.message || e)
    return []
  }
}
