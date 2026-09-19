// DLive (DaddyLive/DLHD) sports plugin — schedule scraping.
// The web domain rotates (dlive.sx, dlhd.sx, daddylive.*); the plugin tries the
// candidates in order and caches the one that serves the schedule markup.
// Schedule: GET / → .schedule__category / .schedule__event blocks
//           GET /schedule-api.php?source=extra_* → JSON { html } with a
//           "LIVE NOW" category carrying /watchlivelive.php?id=HEX links.
// Streams: watchlivelive.php pages expose the m3u8 in the playerFrame iframe
//          src (?url=…) → direct HLS. watchextra.php / stream-N.php are
//          obfuscated players → embed fallback (resolved by the app's headless
//          WebView resolver).

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { logWarn } from '../../../utils/logger.js'
import { httpGetText, httpGetJson, shortSignal } from '../../../utils/httpClient.js'
import { parseSchedule, extractLiveLiveUrl, catalogFor, eventId, sofaSportFor } from './parse.js'
import { probeHlsQuality } from '../../../utils/streamProbe.js'
import { enrichLogos } from '../../../utils/sofascore.js'

// Candidate domains — the service rotates often; first one answering with
// schedule markup wins and is cached.
const BASE_CANDIDATES = [
  'https://dlive.sx',
  'https://dlhd.st',
  'https://dlstreams.st',
]
const EXTRA_SOURCES = ['extra_sports', 'extra_backup', 'extra_sd']
const BASE_TTL = 30 * 60 * 1000
const SCHEDULE_TTL = 5 * 60 * 1000

let baseCache = null // { ts, base }
const scheduleCache = new Map() // 'all' → { ts, events }

const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) OctoStream/1.0' }

async function resolveBase(signal) {
  if (baseCache && Date.now() - baseCache.ts < BASE_TTL) return baseCache.base
  // Sonda paralela con timeout corto: un dominio bloqueado por el ISP ya no
  // puede comerse 20s en serie antes de probar el siguiente.
  const probe = async (base) => {
    const html = await httpGetText(`${base}/`, UA, shortSignal(signal, 6000))
    if (!html || !html.includes('schedule__')) throw new Error('no schedule markup')
    return base
  }
  try {
    const base = await Promise.any(BASE_CANDIDATES.map(probe))
    baseCache = { ts: Date.now(), base }
    return base
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err
    }
    throw new Error('no dlive domain reachable')
  }
}

async function fetchAllEvents(signal) {
  const hit = scheduleCache.get('all')
  if (hit && Date.now() - hit.ts < SCHEDULE_TTL) return hit.events

  const base = await resolveBase(signal)
  const [mainHtml, ...extras] = await Promise.all([
    httpGetText(`${base}/`, UA, signal),
    ...EXTRA_SOURCES.map(src =>
      httpGetJson(`${base}/schedule-api.php?source=${src}`, UA, signal)
        .then(j => j?.html || '')
        .catch(() => '')),
  ])

  const byKey = new Map()
  for (const e of parseSchedule(mainHtml, base)) byKey.set(eventId(e), e)
  for (const html of extras) {
    for (const e of parseSchedule(html, base)) {
      const k = eventId(e)
      const prev = byKey.get(k)
      if (!prev) { byKey.set(k, e); continue }
      // Same match in the main schedule and in LIVE NOW/extras: keep the live
      // flag, earliest time and the union of links.
      const seen = new Set(prev.links.map(l => l.url))
      for (const l of e.links) if (!seen.has(l.url)) { prev.links.push(l); seen.add(l.url) }
      prev.live = prev.live || e.live
      if (!prev.time && e.time) prev.time = e.time
    }
  }

  const events = [...byKey.values()]
  scheduleCache.set('all', { events, ts: Date.now() })
  return events
}

// ─── Item mapping ────────────────────────────────────────────────────────────

// Categorías del site que no son deportes (reality, TV, marcadores genéricos).
const JUNK_CAT_RE = /big brother|tv shows?|upcoming events|movies?|entertainment|news|music|kids|documentar|24\/7|ppv events/i

const SPORT_LABEL = {
  'dlive-football': 'Fútbol', 'dlive-basketball': 'Baloncesto',
  'dlive-tennis': 'Tenis', 'dlive-motor': 'Motor', 'dlive-others': 'Otros',
}

// The site shows HH:mm for "today" (schedule resets daily); treat as local
// time and flag live if it started within the last 3h.
function eventDate(time) {
  const m = String(time || '').match(/(\d{1,2}):(\d{2})/)
  if (!m) return 0
  const d = new Date()
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d.getTime()
}

function toItem(e, catId) {
  const matchDate = eventDate(e.time)
  const isLive = e.live || (matchDate && Date.now() >= matchDate && Date.now() - matchDate < 3 * 3600 * 1000)
  return {
    id: eventId(e),
    type: 'channel',
    pluginId: 'dlive',
    name: e.home && e.away ? `${e.home} vs ${e.away}` : e.title,
    title: e.home && e.away ? `${e.home} vs ${e.away}` : e.title,
    description: [e.league || e.category, e.time].filter(Boolean).join(' · '),
    _home: e.home ? { name: e.home, logo: null } : null,
    _away: e.away ? { name: e.away, logo: null } : null,
    _league: { name: e.league || e.category },
    _score: null,
    _sofaSport: sofaSportFor(e.category, e.league),
    _matchDate: matchDate,
    _isLive: !!isLive,
    genre: SPORT_LABEL[catId] || 'Otros',
    _links: e.links,
  }
}

// ─── Stream resolution ───────────────────────────────────────────────────────

// watchlivelive.php expone el m3u8 firmado en el iframe (sin JS) → HLS directo.
// watch.php / watchextra / stream-N son players ofuscados → embed (la app los
// resuelve con el WebView headless). El picker de Sports prefiere siempre los
// directos; los embeds quedan como fallback cuando no hay HLS.
async function resolveEventStreams(item, signal) {
  const streams = []
  const jobs = (item._links || []).map(async (link) => {
    if (/watchlivelive\.php/.test(link.url)) {
      try {
        const html = await httpGetText(link.url, UA, shortSignal(signal, 8000))
        const r = extractLiveLiveUrl(html)
        if (r) {
          const quality = await probeHlsQuality(r.url,
            r.referer ? { Referer: r.referer } : UA, signal)
          streams.push({
            name: `DLive ${link.label}`,
            title: 'Directo',
            url: r.url,
            referer: r.referer,
            headers: r.referer ? { Referer: r.referer } : undefined,
            streamType: 'hls',
            quality: quality || undefined,
            isLive: true,
            _noCache: true,
          })
          return
        }
      } catch (e) {
        if (e?.name === 'AbortError') throw e
      }
    }
    // Player web (ofuscado) o watchlivelive no resuelto → embed fallback.
    // Los players tiestep/«Sandbox check» (watch.php, stream-N.php,
    // watchextra) sirven el m3u8 SOLO a su propio documento — la URL
    // extraída da 403 en ExoPlayer, así que van directo al WebView playback.
    const wvPlayback = /watch\.php|\/stream\/|watchextra|watchplus|\/plus\b/i.test(link.url)
    streams.push({
      name: link.label,
      title: 'DLive · Web',
      url: link.url,
      referer: baseCache?.base ? baseCache.base + '/' : undefined,
      streamType: 'embed',
      isLive: true,
      _noCache: true,
      _wvPlayback: wvPlayback || undefined,
    })
  })
  await Promise.all(jobs)
  return streams
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

function buildCatalogs() {
  return [
    { id: 'dlive-live', name: 'DLive · Directos', type: CONTENT_TYPES.CHANNEL },
    { id: 'dlive-football', name: 'DLive · Fútbol', type: CONTENT_TYPES.CHANNEL },
    { id: 'dlive-basketball', name: 'DLive · Baloncesto', type: CONTENT_TYPES.CHANNEL },
    { id: 'dlive-tennis', name: 'DLive · Tenis', type: CONTENT_TYPES.CHANNEL },
    { id: 'dlive-motor', name: 'DLive · Motor', type: CONTENT_TYPES.CHANNEL },
    { id: 'dlive-others', name: 'DLive · Otros', type: CONTENT_TYPES.CHANNEL },
  ]
}

export const dliveFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'dlive',
    name: config.manifest?.name || 'DLive Deportes',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'Deportes en directo desde dlive (DaddyLive).',
    types: [CONTENT_TYPES.CHANNEL],
    catalogs: buildCatalogs(),
    icon: 'trophy',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 500, signal }) {
      try {
        const events = await fetchAllEvents(signal)
        const items = events
          .filter(e => !JUNK_CAT_RE.test(e.category) &&
            (id === 'dlive-live' || catalogFor(e.category, e.league) === id))
          .map(e => toItem(e, id === 'dlive-live' ? catalogFor(e.category, e.league) : id))
          .sort((a, b) => (b._isLive ? 1 : 0) - (a._isLive ? 1 : 0) || a._matchDate - b._matchDate)
        // Escudos: pasada rápida (eventos live). La búsqueda profunda la
        // hace la página en segundo plano tras pintar.
        const page = items.slice(skip, skip + top)
        try { await enrichLogos(page, signal, { deep: false }) } catch { /* best-effort */ }
        return page
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[DLive] getCatalog failed:', String(e?.message || e))
        return []
      }
    },

    async getMeta({ id, signal }) {
      if (!String(id).startsWith('dlive:')) return null
      try {
        const events = await fetchAllEvents(signal)
        for (const e of events) {
          const it = toItem(e, 'dlive-live')
          if (it.id === id) return it
        }
        return null
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        return null
      }
    },

    async getStreams({ id, signal }) {
      if (!String(id).startsWith('dlive:')) return []
      try {
        const events = await fetchAllEvents(signal)
        const e = events.find(ev => eventId(ev) === id)
        if (!e) return []
        return await resolveEventStreams(toItem(e, 'dlive-live'), signal)
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[DLive] getStreams failed:', String(e?.message || e))
        return []
      }
    },
  })
}
