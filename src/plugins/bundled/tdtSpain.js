// Bundled external plugin: TDT Spain.
// Port of plugin.video.tdtspain (Kodi) to Optopus Stream.
// Uses TDTSpain public APIs: channels, EPG, U7D (last 7 days).
// Resolves live streams for RTVE, Atresplayer, Mediaset and direct HLS.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { logError, logWarn } from '../../utils/logger.js'

// ─── API URLs ──────────────────────────────────────────────────────────────

const CHANNELS_URL = 'https://www.tdtspain.com/canales/canalesv4.json'
const EPG_URL = 'https://www.tdtspain.com/epg/TV.json.gz'
const U7D_URL = 'https://www.tdtspain.com/u7d/u7dv1.json'
const TDTCHANNELS_M3U = 'https://www.tdtchannels.com/lists/tv.m3u8'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_KEY = 'optopus_tdspain_cache'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0 }
    return JSON.parse(raw)
  } catch {
    return { channels: null, streamTypes: {}, epg: {}, u7d: null, rtveHls: null, ts: 0 }
  }
}

function saveCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...cache, ts: Date.now() }))
  } catch {
    // storage full, ignore
  }
}

async function fetchGzJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // Browser handles gzip transparently for fetch
  return res.json()
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// ─── Data loading ───────────────────────────────────────────────────────────

async function getChannels(cache) {
  if (cache.channels && Date.now() - cache.ts < CACHE_TTL_MS) return cache
  const data = await fetchJson(CHANNELS_URL)
  cache.streamTypes = data.streamstype || {}
  cache.channels = data.canales || []
  cache.ts = Date.now()
  saveCache(cache)
  return cache
}

async function getEpg(cache) {
  if (cache.epg && Object.keys(cache.epg).length > 0 && Date.now() - cache.ts < CACHE_TTL_MS) return cache
  try {
    const data = await fetchGzJson(EPG_URL)
    const m = {}
    if (Array.isArray(data)) {
      for (const ch of data) {
        if (ch && ch.name) m[String(ch.name)] = ch.events || []
      }
    }
    cache.epg = m
    saveCache(cache)
  } catch (e) {
    logWarn('TDT Spain EPG fetch failed', String(e?.message || e))
  }
  return cache
}

async function getU7d(cache) {
  if (cache.u7d && Date.now() - cache.ts < CACHE_TTL_MS) return cache
  try {
    cache.u7d = await fetchJson(U7D_URL)
    saveCache(cache)
  } catch (e) {
    logWarn('TDT Spain U7D fetch failed', String(e?.message || e))
    cache.u7d = {}
  }
  return cache
}

// ─── RTVE HLS resolution ────────────────────────────────────────────────────

const RTVE_HLS_FALLBACK = {
  'La1.TV': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8',
  'La2.TV': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main_dvr.m3u8',
  '24Horas.TV': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main_dvr.m3u8',
  'Clan.TV': 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main_dvr.m3u8',
  'TDP.TV': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
  'TVE_INTER.TV': 'https://rtvelivestream.rtve.es/rtvesec/int/tvei_eu_main_dvr.m3u8',
  'TVE_STAR.TV': 'https://rtvelivestream.rtve.es/rtvesec/int/star_main_dvr.m3u8',
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[^\w.-]/g, '')
}

async function getRtveHls(cache) {
  if (cache.rtveHls && Date.now() - cache.ts < CACHE_TTL_MS) return cache.rtveHls
  const m = {}
  for (const [cid, url] of Object.entries(RTVE_HLS_FALLBACK)) {
    m[cid] = url
    m[normKey(cid)] = url
  }

  try {
    const body = await fetchText(TDTCHANNELS_M3U, {
      Referer: 'https://www.tdtchannels.com/',
    })
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

function resolveRtveHls(ch, rtveMap) {
  const chid = String(ch.id || '')
  const name = String(ch.name || '')
  const url = rtveMap[chid] || rtveMap[normKey(chid)] || rtveMap[normKey(name)]
  if (url) {
    return {
      url,
      streamType: 'hls',
      quality: 'LIVE',
      headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' },
    }
  }
  const aliases = { la1: 'La1.TV', la2: 'La2.TV', '24h': '24Horas.TV', '24horas': '24Horas.TV', clan: 'Clan.TV', teledeporte: 'TDP.TV', tdp: 'TDP.TV' }
  const a = aliases[normKey(name)]
  if (a) {
    const u = rtveMap[a] || rtveMap[normKey(a)]
    if (u) return { url: u, streamType: 'hls', quality: 'LIVE', headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' } }
  }
  return null
}

// ─── Atresplayer resolution ─────────────────────────────────────────────────

async function resolveAtresLive(ch, streamTypes) {
  const def = streamTypes.stream11 || {}
  const page = String(ch.url || '')
  let key = page.match(/atresplayer\.com(\/.*)$/)?.[1] || page
  if (!key.startsWith('/')) key = '/' + key
  if (!key.endsWith('/')) key += '/'
  const encKey = encodeURIComponent(key)
  const baseTmpl = def.baseurl || 'https://api.atresplayer.com/client/v1/url?href=$key'
  let base = baseTmpl.replace('$key', encKey)
  if (base === baseTmpl) base = 'https://api.atresplayer.com/client/v1/url?href=' + encKey

  const hdr = { 'User-Agent': UA, Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/' }
  const r1 = await fetchJson(base, hdr)
  if (!r1?.href) return null
  const r2 = await fetchJson(r1.href, hdr)
  if (!r2) return null
  const urlVideo = r2.urlVideo || ''
  if (!urlVideo) return null

  const player = await fetchJson(urlVideo + '?usp=true&device=desktop&NODRM=true', hdr)
  if (!player) return null
  const sources = player.sourcesLive || player.sources || []
  for (const src of sources) {
    const t = String(src.type || '')
    const u = String(src.src || '')
    if (u && (/mpegurl/.test(t) || /hls/.test(t) || u.endsWith('.m3u8'))) {
      return { url: u, streamType: 'hls', quality: 'LIVE', headers: hdr }
    }
  }
  return null
}

// ─── Mediaset resolution ────────────────────────────────────────────────────

async function resolveMediasetLive(ch, streamTypes) {
  const def = streamTypes.stream10 || {}
  const attrs = def.atributtes || def.attributes || {}
  const hdr = { 'User-Agent': UA, Origin: 'https://www.mediasetinfinity.es', Referer: 'https://www.mediasetinfinity.es/' }

  const page = String(ch.url || '')
  const initUrl = attrs.initUrl || 'https://services-ott-prod-fe.mediaset.net/esp/static/nownext/v3.0/nownext.json'
  const nn = await fetchJson(initUrl, hdr)
  const stations = nn?.response?.stations || {}
  let callSign = null
  for (const st of Object.values(stations)) {
    if (!st || typeof st !== 'object') continue
    const vpu = String(st.mediasetstation$videoPageUrl || st.videoPageUrl || '')
    if (vpu && page) {
      if (vpu === page || /directo\/([^/]+)/.exec(vpu)?.[1] && page.includes(RegExp.$1)) {
        callSign = st.callSign
        break
      }
    }
  }
  if (!callSign) {
    const slug = page.match(/\/directo\/([^/]+)/)?.[1] || ''
    const mp = { telecinco: 'T5', cuatro: 'C4', fdf: 'FD', energy: 'EN', divinity: 'DV', bemad: 'BM', boing: 'BOING' }
    callSign = mp[slug]
  }
  if (!callSign) return null

  // Anonymous login
  const appname = attrs.appname || 'web//mediasetplay-web/1.2.1-d1b2024'
  const urlToken = attrs.urltoken || 'https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login'
  const clientId = String(Date.now() % 1000000000) + '-' + String(Math.floor(Math.random() * 900000) + 100000)
  const login = await fetchJson(urlToken, {
    ...hdr,
    'Content-Type': 'application/json',
  })
  // POST not available via fetch GET; use a different approach
  const loginRes = await fetch(urlToken, {
    method: 'POST',
    headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName: appname, client_id: clientId }),
  }).then(r => r.json()).catch(() => null)

  const sid = loginRes?.response?.sid
  const beToken = loginRes?.response?.beToken
  if (!sid || !beToken) return null

  const checkTmpl = attrs.mediaSelector || 'https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${token.clave}'
  const checkUrl = checkTmpl.replace('${token.clave}', sid).replace('$token.clave', sid)
  const chkRes = await fetch(checkUrl, {
    method: 'POST',
    headers: { ...hdr, Authorization: 'Bearer ' + beToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelCode: callSign, streamType: 'LIVE' }),
  }).then(r => r.json()).catch(() => null)

  const dai = chkRes?.response?.dai?.assetKey
  if (!dai) return null

  const daiUrl = 'https://pubads.g.doubleclick.net/ssai/event/' + dai + '/streams'
  const daiRes = await fetch(daiUrl, {
    method: 'POST',
    headers: { ...hdr, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'ppid=' + clientId + '&vpa=auto&wta=1&vpmute=0',
  }).then(r => r.json()).catch(() => null)

  const manifest = daiRes?.stream_manifest
  if (!manifest) return null
  return { url: manifest, streamType: 'hls', quality: 'LIVE', headers: hdr }
}

// ─── Stream resolution ──────────────────────────────────────────────────────

async function resolveLiveStream(ch, cache) {
  const st = String(ch.streamtype || '')
  const url = String(ch.url || '')

  if (st === 'stream1') {
    const rtveMap = await getRtveHls(cache)
    return resolveRtveHls(ch, rtveMap)
  }
  if (st === 'stream11') {
    try {
      return await resolveAtresLive(ch, cache.streamTypes)
    } catch (e) {
      logWarn('TDT Spain Atresplayer resolve failed', String(e?.message || e))
      return null
    }
  }
  if (st === 'stream10') {
    try {
      return await resolveMediasetLive(ch, cache.streamTypes)
    } catch (e) {
      logWarn('TDT Spain Mediaset resolve failed', String(e?.message || e))
      return null
    }
  }
  if (st === '' || st === 'hls') {
    if (/^https?:\/\//.test(url)) return { url, streamType: 'hls', quality: 'LIVE' }
  }
  if (st === 'stream12') {
    // Dailymotion geo player
    try {
      const data = await fetchJson(url, { Origin: 'https://geo.dailymotion.com', Referer: 'https://geo.dailymotion.com/' })
      const auto = data?.qualities?.auto
      if (Array.isArray(auto) && auto[0]?.url) return { url: auto[0].url, streamType: 'hls', quality: 'LIVE' }
    } catch (e) {
      logWarn('TDT Spain Dailymotion resolve failed', String(e?.message || e))
    }
  }
  if (/^https?:\/\//.test(url) && (/\.m3u8/.test(url) || /\/hls/.test(url))) {
    return { url, streamType: 'hls', quality: 'LIVE' }
  }
  return null
}

// ─── Normalization ──────────────────────────────────────────────────────────

function currentEvent(epg, epgId) {
  const events = epg[String(epgId || '')] || []
  const now = Math.floor(Date.now() / 1000)
  for (const ev of events) {
    const hi = parseInt(ev.hi || 0)
    const hf = parseInt(ev.hf || 0)
    if (hi <= now && now < hf) return ev
  }
  return null
}

function normalizeChannel(ch, epg) {
  const cur = currentEvent(epg, ch.epgid || ch.id)
  const logo = ch.logo || ch.image || ''
  const name = ch.name || ch.id
  let overview = 'Canal TDT en directo'
  if (cur) {
    overview = `Ahora: ${cur.t || ''}\n${cur.d || ''}`
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
    nowPlaying: cur?.t || '',
    group: ch.group || 'Otros',
    _raw: ch,
  }
}

// ─── Plugin factory ─────────────────────────────────────────────────────────

export const tdtSpainFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'tdtspain',
    name: config.manifest?.name || 'TDT Spain',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'TDT España: directos, EPG y últimos 7 días. RTVE, Atresmedia, Mediaset y más.',
    types: [CONTENT_TYPES.LIVE, CONTENT_TYPES.CHANNEL],
    catalogs: [
      { id: 'tdtspain-all', name: 'Todos los canales', type: CONTENT_TYPES.LIVE },
      { id: 'tdtspain-live', name: 'En directo', type: CONTENT_TYPES.LIVE },
      { id: 'tdtspain-groups', name: 'Por grupo', type: CONTENT_TYPES.LIVE },
    ],
    icon: 'tv',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 100 }) {
      try {
        let cache = loadCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const channels = cache.channels || []
        const visible = channels.filter(ch => String(ch.ocultar || '') !== 'true')

        if (id === 'tdtspain-live') {
          const live = visible.filter(ch => {
            const st = String(ch.streamtype || '')
            const url = String(ch.url || '')
            return st === '' || st === 'hls' || (/^https?:\/\//.test(url) && /\.m3u8/.test(url))
          })
          return live.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
        }

        if (id === 'tdtspain-groups') {
          const groups = new Set()
          for (const ch of visible) {
            const g = String(ch.group || '').split(';')[0].trim()
            if (g) groups.add(g)
          }
          return [...groups].sort().map(g => ({
            id: `group-${g}`,
            type: CONTENT_TYPES.LIVE,
            name: g,
            title: g,
            description: `Canales del grupo ${g}`,
            genres: [g],
          }))
        }

        // Default: all channels
        return visible.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
      } catch (e) {
        logWarn('TDT Spain getCatalog failed', String(e?.message || e))
        return []
      }
    },

    async getMeta({ id }) {
      try {
        let cache = loadCache()
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
        let cache = loadCache()
        cache = await getChannels(cache)
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
          headers: stream.headers,
        }]
      } catch (e) {
        logError('TDT Spain getStreams failed', String(e?.message || e))
        return []
      }
    },

    async search({ query }) {
      try {
        let cache = loadCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const q = (query || '').toLowerCase()
        const channels = cache.channels || []
        return channels
          .filter(ch => {
            const name = String(ch.name || '').toLowerCase()
            const cid = String(ch.id || '').toLowerCase()
            const group = String(ch.group || '').toLowerCase()
            return name.includes(q) || cid.includes(q) || group.includes(q)
          })
          .filter(ch => String(ch.ocultar || '') !== 'true')
          .map(ch => normalizeChannel(ch, cache.epg))
      } catch (e) {
        logWarn('TDT Spain search failed', String(e?.message || e))
        return []
      }
    },
  })
}
