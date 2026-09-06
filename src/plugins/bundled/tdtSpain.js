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
  const fetchUrl = proxied(url)
  const res = await fetch(fetchUrl, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // Browser handles gzip transparently for fetch
  return res.json()
}

async function fetchJson(url, headers = {}) {
  const fetchUrl = proxied(url)
  const res = await fetch(fetchUrl, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url, headers = {}) {
  const fetchUrl = proxied(url)
  const res = await fetch(fetchUrl, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function proxied(url) {
  // In Electron, session.webRequest intercepts all requests to inject
  // correct Origin/Referer and strip CORS headers. So API calls can
  // go direct. We only need the proxy for:
  // - HLS streams (proxy rewrites manifests with proxied segment URLs)
  // - .gz files (proxy decompresses them)
  // EXCEPT: Mediaset/DAI streams must NOT go through the proxy because
  // the CDN uses cookies/session tied to the original DAI request chain.
  // Proxying breaks this and causes 403 on segments.
  // In web mode (no proxy available), return URL as-is.
  if (typeof window !== 'undefined' && window.optopus?.proxyUrl && /^https?:\/\//.test(url) && !url.includes('127.0.0.1')) {
    // Skip proxy for Mediaset/DAI - Electron session interceptor handles headers
    if (/mediaset|dai\.google\.com|doubleclick\.net/i.test(url)) return url
    const isHls = /\.m3u8/i.test(url) || /\.ts(\?|$)/i.test(url)
    const isGz = /\.gz$/i.test(url)
    if (isHls || isGz) {
      return window.optopus.proxyUrl + encodeURIComponent(url)
    }
  }
  return url
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
    console.log('[TDT Spain] EPG raw data type:', typeof data, 'isArray:', Array.isArray(data))
    const m = {}
    if (Array.isArray(data)) {
      console.log('[TDT Spain] EPG array length:', data.length, 'first item keys:', data[0] ? Object.keys(data[0]) : 'none')
      console.log('[TDT Spain] EPG first channel:', data[0]?.name, 'first event:', JSON.stringify(data[0]?.events?.[0]).substring(0, 200))
      for (const ch of data) {
        if (ch && ch.name) {
          // Normalize events to common format with start/end as ISO strings
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
          // Also store by normalized key for fuzzy matching
          m[normKey(ch.name)] = events
        }
      }
    }
    console.log('[TDT Spain] EPG parsed channels:', Object.keys(m).length)
    cache.epg = m
    saveCache(cache)
  } catch (e) {
    logWarn('TDT Spain EPG fetch failed', String(e?.message || e))
    console.error('[TDT Spain] EPG fetch error:', e)
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
  const pageSlug = page.match(/\/directo\/([^/]+)/)?.[1] || ''

  // Slug -> callSign mapping (from nownext.json observation)
  const slugMap = {
    telecinco: 'T5', cuatro: 'CT', fdf: 'FD', energy: 'EN', divinity: 'DV',
    bemad: 'BM', boing: 'BO', 'mitele-comedia': 'MC', 'mitele-viajes': 'MV',
    'mitele-en-la-calle': 'ME', 'mitele-top-series': 'MS', 'mtmad-24h': 'MT',
    'mitele-plus-lqsa': 'ML', acontraplus: 'AC', 'fight-sports': 'FS',
  }

  let callSign = slugMap[pageSlug] || null

  // If not in map, try nownext.json lookup
  if (!callSign) {
    try {
      const initUrl = attrs.initUrl || 'https://services-ott-prod-fe.mediaset.net/esp/static/nownext/v3.0/nownext.json'
      const nn = await fetchJson(initUrl, hdr)
      const stations = nn?.response?.stations || {}
      for (const st of Object.values(stations)) {
        if (!st || typeof st !== 'object') continue
        const vpu = String(st['mediasetstation$videoPageUrl'] || st.videoPageUrl || '')
        if (vpu && pageSlug) {
          const vpuSlug = vpu.match(/\/directo\/([^/]+)/)?.[1] || ''
          if (vpuSlug === pageSlug) {
            callSign = st.callSign
            break
          }
        }
      }
    } catch (e) {
      console.warn('[TDT Spain] Mediaset nownext fetch failed:', e?.message)
    }
  }
  if (!callSign) {
    console.warn('[TDT Spain] Mediaset: no callSign found for', pageSlug)
    return null
  }
  console.log('[TDT Spain] Mediaset resolving:', pageSlug, '-> callSign:', callSign)

  // Anonymous login (POST only)
  const appname = attrs.appname || 'web//mediasetplay-web/1.2.1-d1b2024'
  const urlToken = attrs.urltoken || 'https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login'
  const clientId = String(Date.now() % 1000000000) + '-' + String(Math.floor(Math.random() * 900000) + 100000)
  const loginRes = await fetch(urlToken, {
    method: 'POST',
    headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName: appname, client_id: clientId }),
  }).then(r => r.json()).catch(e => { console.error('[TDT Spain] Mediaset login failed:', e?.message); return null })

  const sid = loginRes?.response?.sid
  const beToken = loginRes?.response?.beToken
  if (!sid || !beToken) {
    console.warn('[TDT Spain] Mediaset login: no sid/beToken', JSON.stringify(loginRes)?.substring(0, 200))
    return null
  }
  console.log('[TDT Spain] Mediaset login OK, sid:', sid.substring(0, 12) + '...')

  // Playback check
  const checkUrl = `https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${sid}`
  const chkRes = await fetch(checkUrl, {
    method: 'POST',
    headers: { ...hdr, Authorization: 'Bearer ' + beToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelCode: callSign, streamType: 'LIVE' }),
  }).then(r => r.json()).catch(e => { console.error('[TDT Spain] Mediaset check failed:', e?.message); return null })

  const dai = chkRes?.response?.dai?.assetKey
  if (!dai) {
    console.warn('[TDT Spain] Mediaset: no DAI assetKey', JSON.stringify(chkRes)?.substring(0, 200))
    return null
  }
  console.log('[TDT Spain] Mediaset DAI assetKey:', dai)

  // Get DAI stream manifest
  const daiUrl = 'https://pubads.g.doubleclick.net/ssai/event/' + dai + '/streams'
  const daiRes = await fetch(daiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'ppid=' + clientId + '&vpa=auto&wta=1&vpmute=0',
  }).then(r => r.json()).catch(e => { console.error('[TDT Spain] Mediaset DAI failed:', e?.message); return null })

  const manifest = daiRes?.stream_manifest
  if (!manifest) {
    console.warn('[TDT Spain] Mediaset: no stream_manifest', JSON.stringify(daiRes)?.substring(0, 200))
    return null
  }
  console.log('[TDT Spain] Mediaset stream OK:', manifest.substring(0, 80))
  return { url: manifest, streamType: 'hls', quality: 'LIVE', headers: hdr }
}

// ─── U7D stream resolution ──────────────────────────────────────────────────

async function resolveU7dStream(itemId, cache) {
  // itemId format: u7d-{channelKey}-{startTimestamp}
  // We need to find which channel and item this is, then resolve stream
  const parts = itemId.match(/^u7d-(.+?)-(\d+(?:\.\d+)?)$/)
  if (!parts) return null
  const chKey = parts[1]
  const startTs = parseFloat(parts[2])

  cache = await getU7d(cache)
  const u7d = cache.u7d || {}
  const u7dConf = u7d.U7dConf || {}
  const chData = u7dConf[chKey]
  if (!chData) return null
  const u7dtype = chData.u7dtype || ''

  console.log('[TDT Spain] U7D stream resolve:', chKey, 'type:', u7dtype, 'ts:', startTs)

  if (u7dtype === 'stream1') {
    // RTVE: resolve via ztnr.rtve.es using idAsset
    // We need to re-fetch the programs to find the one matching this timestamp
    const u7dUrl = chData.u7ddata || ''
    if (!u7dUrl) return null
    try {
      const progData = await fetchJson(u7dUrl)
      const items = progData.items || []
      // Find program by timestamp
      let program = null
      for (const it of items) {
        const bt = it.begintime || ''
        if (bt && /^\d{14}$/.test(bt)) {
          const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
          const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
          const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
          const ts = Math.floor(dt.getTime() / 1000)
          if (ts === Math.floor(startTs)) {
            program = it
            break
          }
        }
      }
      if (!program) {
        console.warn('[TDT Spain] U7D RTVE: program not found for ts', startTs)
        return null
      }
      const idAsset = program.idAsset || program.idPrograma
      if (!idAsset) {
        console.warn('[TDT Spain] U7D RTVE: no idAsset/idPrograma for', program.name)
        return null
      }
      // RTVE U7D: ztnr redirects to HLS (works for both DRM and non-DRM)
      const hlsUrl = `https://ztnr.rtve.es/ztnr/${idAsset}.m3u8`
      console.log('[TDT Spain] U7D RTVE stream:', hlsUrl)
      return {
        name: program.name || 'RTVE',
        url: hlsUrl,
        streamType: 'hls',
        quality: 'VOD',
        headers: { 'User-Agent': UA, Origin: 'https://www.rtve.es', Referer: 'https://www.rtve.es/' },
      }
    } catch (e) {
      console.error('[TDT Spain] U7D RTVE resolve error:', e?.message)
      return null
    }
  }

  if (u7dtype === 'stream11') {
    // Atresplayer U7D: items have link.href -> resolve like VOD
    const u7dUrl = chData.u7ddata || ''
    if (!u7dUrl) return null
    try {
      const progData = await fetchJson(u7dUrl)
      const progs = progData.itemRows || progData.items || []
      let program = null
      for (const p of progs) {
        const pTs = Math.floor((p.startTime || 0) / 1000)
        if (pTs === Math.floor(startTs)) {
          program = p
          break
        }
      }
      if (!program) {
        console.warn('[TDT Spain] U7D Atresplayer: program not found for ts', startTs)
        return null
      }
      // Get the video link from the program
      const link = program.link?.href || program.link?.url || program.href || ''
      if (!link) {
        console.warn('[TDT Spain] U7D Atresplayer: no link for', program.title)
        return null
      }
      const hdr = { 'User-Agent': UA, Origin: 'https://www.atresplayer.com', Referer: 'https://www.atresplayer.com/' }
      // Atresplayer VOD: resolve through same API chain as live
      const fullUrl = link.startsWith('http') ? link : `https://api.atresplayer.com${link}`
      const r1 = await fetchJson(fullUrl, hdr)
      const urlVideo = r1?.urlVideo || ''
      if (!urlVideo) {
        // Try page -> urlVideo flow
        const pageHref = r1?.href || ''
        if (pageHref) {
          const r2 = await fetchJson(pageHref, hdr)
          const uv = r2?.urlVideo || ''
          if (uv) {
            const player = await fetchJson(uv + '?usp=true&device=desktop&NODRM=true', hdr)
            const sources = player?.sources || player?.sourcesLive || []
            for (const src of sources) {
              const t = String(src.type || '')
              const u = String(src.src || '')
              if (u && (/mpegurl/.test(t) || /hls/.test(t) || u.endsWith('.m3u8'))) {
                return { name: program.title || 'Atresplayer', url: u, streamType: 'hls', quality: 'VOD', headers: hdr }
              }
            }
          }
        }
        return null
      }
      const player = await fetchJson(urlVideo + '?usp=true&device=desktop&NODRM=true', hdr)
      const sources = player?.sources || player?.sourcesLive || []
      for (const src of sources) {
        const t = String(src.type || '')
        const u = String(src.src || '')
        if (u && (/mpegurl/.test(t) || /hls/.test(t) || u.endsWith('.m3u8'))) {
          console.log('[TDT Spain] U7D Atresplayer stream:', u.substring(0, 80))
          return { name: program.title || 'Atresplayer', url: u, streamType: 'hls', quality: 'VOD', headers: hdr }
        }
      }
      return null
    } catch (e) {
      console.error('[TDT Spain] U7D Atresplayer resolve error:', e?.message)
      return null
    }
  }

  if (u7dtype === 'stream10') {
    // Mediaset U7D VOD: anonymous login → playback check → mediaSelector → SMIL → stream URL
    // Only AVOD (free) content is shown in the catalog. SVOD content returns LicenseNotGranted.
    // The stream URL (rawvod.mediaset.es) may be geo-blocked outside Spain.
    const u7dUrl = chData.u7ddata || ''
    if (!u7dUrl) return null
    try {
      // Re-fetch programs to find the matching item
      const callSignMatch = u7dUrl.match(/byCallSign=([^&]+)/)
      const callSign = callSignMatch ? callSignMatch[1] : ''
      if (!callSign) return null

      const now = Date.now()
      const ONE_DAY = 24 * 60 * 60 * 1000
      // Fetch the day containing this timestamp
      const targetMs = startTs * 1000
      const dayStart = targetMs - ONE_DAY
      const dayEnd = targetMs + ONE_DAY
      const dayUrl = `https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=${callSign}&byListingTime=${dayStart}~${dayEnd}`
      const dayData = await fetchJson(dayUrl).catch(() => null)
      if (!dayData) return null

      let guid = ''
      let hasVod = false
      let isFree = false
      const entries = dayData.response?.entries || []
      for (const entry of entries) {
        for (const listing of (entry.listings || [])) {
          const lTs = Math.floor((listing.startTime || 0) / 1000)
          if (lTs === Math.floor(startTs)) {
            const prog = listing.program || {}
            guid = prog.guid || ''
            hasVod = !!prog['mediasetprogram$hasVod']
            const rights = prog['mediasetprogram$channelsRights'] || []
            isFree = rights.includes('AVOD')
            break
          }
        }
        if (guid) break
      }

      if (!guid || !hasVod) {
        console.warn('[TDT Spain] U7D Mediaset: no VOD for this program', chKey, startTs)
        return null
      }
      if (!isFree) {
        console.warn('[TDT Spain] U7D Mediaset: SVOD content (requires subscription)', guid)
        return null
      }

      const hdr = { 'User-Agent': UA, Origin: 'https://www.mediasetinfinity.es', Referer: 'https://www.mediasetinfinity.es/' }
      const appname = cache.streamTypes?.stream10?.atributtes?.appname || 'web//mediasetplay-web/1.2.1-d1b2024'
      const clientId = String(Date.now() % 1000000000) + '-' + String(Math.floor(Math.random() * 900000) + 100000)

      // Anonymous login
      const loginRes = await fetch('https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login', {
        method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName: appname, client_id: clientId }),
      }).then(r => r.json()).catch(() => null)
      const sid = loginRes?.response?.sid
      const beToken = loginRes?.response?.beToken
      if (!sid || !beToken) return null

      // Playback check with VOD streamType
      const checkRes = await fetch(`https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${sid}`, {
        method: 'POST',
        headers: { ...hdr, Authorization: 'Bearer ' + beToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId: guid, streamType: 'VOD', delivery: 'Streaming', createDevice: true, overrideAppName: appname }),
      }).then(r => r.json()).catch(() => null)

      const ms = checkRes?.response?.mediaSelector
      if (!ms?.url) {
        console.warn('[TDT Spain] U7D Mediaset: no mediaSelector for', guid)
        return null
      }

      // Build SMIL URL - only pass safe params, skip assetTypes
      // (assetTypes with geoES|geoNo causes NoAssetTypeFormatMatches
      //  when the server can't match the exact asset type requested)
      const authBasic = btoa(':' + beToken)
      const smilParams = new URLSearchParams()
      for (const [k, v] of Object.entries(ms)) {
        if (k === 'url' || k === 'assetTypes') continue
        smilParams.append(k, v)
      }
      const smilUrl = ms.url + '?' + smilParams.toString()
      const smilRes = await fetch(smilUrl, { headers: { ...hdr, Authorization: 'Basic ' + authBasic } })
      const smilText = await smilRes.text()

      // Parse stream URL from SMIL XML
      const srcMatch = smilText.match(/src="(https?:\/\/[^"]+)"/)
      const isException = /isException.*value="true"/.test(smilText)
      if (!srcMatch || isException) {
        const errMatch = smilText.match(/exception.*value="([^"]+)"/)
        const errType = errMatch?.[1] || 'unknown'
        console.warn('[TDT Spain] U7D Mediaset: SMIL error for', guid, '-', errType)
        return null
      }

      const streamUrl = srcMatch[1]
      const isDash = /\.mpd/i.test(streamUrl)
      const isMp4 = /\.mp4/i.test(streamUrl)
      console.log('[TDT Spain] U7D Mediaset stream:', streamUrl.substring(0, 80))
      return {
        name: 'Mediaset VOD',
        url: streamUrl,
        streamType: isDash ? 'dash' : (isMp4 ? 'mp4' : 'hls'),
        quality: 'VOD',
        headers: hdr,
      }
    } catch (e) {
      console.error('[TDT Spain] U7D Mediaset resolve error:', e?.message)
      return null
    }
  }

  console.warn('[TDT Spain] U7D: unknown type', u7dtype, 'for', chKey)
  return null
}

// ─── Stream resolution ──────────────────────────────────────────────────────

// Stream types we can resolve. Channels with types not in this set are filtered out.
const RESOLVABLE_TYPES = new Set(['', 'hls', 'stream1', 'stream10', 'stream11', 'stream12', 'geturl', 'posturl'])

async function resolveGetUrl(url) {
  // Fetch the page/API and extract an HLS URL
  try {
    const res = await fetch(proxied(url), {
      headers: { 'User-Agent': UA, Origin: new URL(url).origin, Referer: new URL(url).origin + '/' },
    })
    if (!res.ok) {
      console.warn('[TDT Spain] geturl fetch failed:', res.status, url.substring(0, 80))
      return null
    }
    const text = await res.text()
    // Try JSON first (some APIs return JSON with stream URL)
    try {
      const json = JSON.parse(text)
      // Look for m3u8 URL in JSON values
      const jsonStr = JSON.stringify(json)
      const m = jsonStr.match(/https?:\/\/[^"'\\ ]*\.m3u8[^"'\\ ]*/)
      if (m) return { url: m[0], streamType: 'hls', quality: 'LIVE' }
    } catch {}
    // Extract m3u8 from HTML
    const m = text.match(/https?:\/\/[^"'\s<>]*\.m3u8[^"'\s<>]*/)
    if (m) return { url: m[0], streamType: 'hls', quality: 'LIVE' }
    // Look for dailymotion CDN URLs
    const dm = text.match(/https?:\/\/[^"'\s<>]*dailymotion\.com\/cdn\/live\/video\/[^"'\s<>]*\.m3u8[^"'\s<>]*/)
    if (dm) return { url: dm[0], streamType: 'hls', quality: 'LIVE' }
    console.warn('[TDT Spain] geturl: no m3u8 found in response from', url.substring(0, 80))
    return null
  } catch (e) {
    console.warn('[TDT Spain] geturl error:', e?.message, url.substring(0, 80))
    return null
  }
}

async function resolvePostUrl(url) {
  // POST to the URL to get a stream manifest (DAI-style)
  try {
    const res = await fetch(proxied(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'ppid=' + Date.now() + '&vpa=auto&wta=1&vpmute=0',
    })
    if (!res.ok) {
      console.warn('[TDT Spain] posturl fetch failed:', res.status, url.substring(0, 80))
      return null
    }
    const data = await res.json().catch(() => null)
    const manifest = data?.stream_manifest
    if (manifest) return { url: manifest, streamType: 'hls', quality: 'LIVE' }
    console.warn('[TDT Spain] posturl: no stream_manifest in response from', url.substring(0, 80))
    return null
  } catch (e) {
    console.warn('[TDT Spain] posturl error:', e?.message, url.substring(0, 80))
    return null
  }
}

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
  if (st === 'geturl') {
    if (/^https?:\/\//.test(url)) return await resolveGetUrl(url)
  }
  if (st === 'posturl') {
    if (/^https?:\/\//.test(url)) return await resolvePostUrl(url)
  }
  if (/^https?:\/\//.test(url) && (/\.m3u8/.test(url) || /\/hls/.test(url))) {
    return { url, streamType: 'hls', quality: 'LIVE' }
  }
  return null
}

// ─── Normalization ──────────────────────────────────────────────────────────

function currentEvent(epg, epgId) {
  // Try exact match, then normalized key
  let events = epg[String(epgId || '')] || epg[normKey(epgId || '')] || []
  // Also try with .TV suffix
  if (events.length === 0 && epgId) {
    const variants = [String(epgId) + '.TV', normKey(epgId) + '.tv']
    for (const v of variants) {
      if (epg[v]) { events = epg[v]; break }
      if (epg[normKey(v)]) { events = epg[normKey(v)]; break }
    }
  }
  const now = Math.floor(Date.now() / 1000)
  for (const ev of events) {
    const hi = ev.startTimestamp || parseInt(ev.hi || 0)
    const hf = ev.endTimestamp || parseInt(ev.hf || 0)
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
        let cache = loadCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const channels = cache.channels || []
        const visible = channels.filter(ch => String(ch.ocultar || '') !== 'true')

        if (id === 'tdtspain-live') {
          // Only show channels with resolvable stream types
          const live = visible.filter(ch => {
            const st = String(ch.streamtype || '')
            return RESOLVABLE_TYPES.has(st)
          })
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
          // Return list of available U7D channels (not the programs themselves)
          // Mediaset U7D is included - free (AVOD) content is playable.
          // SVOD-only programs are filtered out at the program listing level.
          cache = await getU7d(cache)
          const u7d = cache.u7d || {}
          const u7dConf = u7d.U7dConf || {}
          const items = []
          for (const [chKey, chData] of Object.entries(u7dConf)) {
            const chName = chData.idchannel || chKey
            const u7dUrl = chData.u7ddata || ''
            if (u7dUrl && /^https?:\/\//.test(u7dUrl)) {
              // Find matching channel from channels list for logo
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
          // Load programs for a specific U7D channel
          const chKey = id.replace('u7d-programs-', '')
          cache = await getU7d(cache)
          const u7d = cache.u7d || {}
          const u7dConf = u7d.U7dConf || {}
          const chData = u7dConf[chKey]
          if (!chData) return []
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
              // Mediaset API only accepts 1-day ranges; fetch each day in parallel
              const callSignMatch = u7dUrl.match(/byCallSign=([^&]+)/)
              const callSign = callSignMatch ? callSignMatch[1] : ''
              if (callSign) {
                const now = Date.now()
                const ONE_DAY = 24 * 60 * 60 * 1000
                const dayFetches = []
                for (let d = 0; d < 7; d++) {
                  const end = now - d * ONE_DAY
                  const start = end - ONE_DAY
                  const dayUrl = `https://services-ott-prod-fe.mediaset.net/esp/feed/v3.0/allListingFeedEpg?byCallSign=${callSign}&byListingTime=${start}~${end}`
                  dayFetches.push(fetchJson(dayUrl).catch(() => null))
                }
                console.log('[TDT Spain] Mediaset U7D fetching 7 days for', callSign)
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
                      const vodUrl = prog['mediasetprogram$videoPageUrl'] || ''
                      const guid = prog.guid || ''
                      // Determine if content is free (AVOD) or paid (SVOD-only)
                      const rights = prog['mediasetprogram$channelsRights'] || []
                      const isFree = hasVod && rights.includes('AVOD')
                      // Show ALL programs like the APK does (no filtering)
                      // The UI will dim non-playable items and prevent clicking them
                      // Use thumbnail from program data
                      const thumbs = prog.thumbnails || {}
                      const poster = thumbs['image_keyframe_poster']?.url || thumbs['image_horizontal_cover']?.url || ''
                      items.push({
                        id: `u7d-${chKey}-${startTs || Math.random()}`,
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
                        playable: isFree, // only AVOD content is actually playable
                        vodUrl,
                        guid,
                        _raw: listing,
                      })
                    }
                  }
                }
                console.log('[TDT Spain] Mediaset U7D parsed', items.length, 'programs for', callSign)
              }
            } else {
              // For RTVE, Atresplayer, and others: fetch the URL directly
              console.log('[TDT Spain] U7D fetch:', u7dUrl.substring(0, 120))
              const progData = await fetchJson(u7dUrl)

              if (isAtresplayer) {
                // Atresmedia format: { itemRows: [{ title, startTime (ms), image }] }
                const progs = progData.itemRows || progData.items || []
                console.log('[TDT Spain] Atresplayer U7D parsed', progs.length, 'programs')
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
                // RTVE format: { items: [{ name, begintime "YYYYMMDDHHmmss", duration, idAsset, idPrograma }] }
                const progs = progData.items || progData.programs || progData.events || (Array.isArray(progData) ? progData : [])
                console.log('[TDT Spain] RTVE U7D parsed', progs.length, 'programs')
                for (const prog of progs) {
                  // Only include programs with idAsset (otherwise no VOD)
                  const idAsset = prog.idAsset || prog.idPrograma || ''
                  if (!idAsset) continue
                  let startTs = 0, startStr = ''
                  const bt = prog.begintime || prog.start || prog.begin || prog.startTime
                  if (bt) {
                    if (typeof bt === 'string' && /^\d{14}$/.test(bt)) {
                      const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
                      const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
                      const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
                      startTs = dt.getTime() / 1000; startStr = dt.toISOString()
                    } else {
                      const dt = new Date(bt)
                      if (!isNaN(dt)) { startTs = dt.getTime() / 1000; startStr = dt.toISOString() }
                    }
                  }
                  let durationSec = 0
                  const dur = prog.duration || prog.dur
                  if (typeof dur === 'string' && /^\d{6}$/.test(dur)) {
                    durationSec = parseInt(dur.slice(0,2))*3600 + parseInt(dur.slice(2,4))*60 + parseInt(dur.slice(4,6))
                  } else if (typeof dur === 'number') { durationSec = dur }
                  items.push({
                    id: `u7d-${chKey}-${startTs || Math.random()}`,
                    type: CONTENT_TYPES.LIVE,
                    name: prog.name || prog.title || 'Sin título',
                    title: prog.name || prog.title || 'Sin título',
                    description: prog.description || prog.desc || '',
                    poster: prog.poster || prog.thumbnail || '',
                    channelName: chMatch?.name || chName,
                    channelId: chKey,
                    startTimestamp: startTs,
                    startTime: startStr,
                    duration: durationSec,
                    idAsset: String(idAsset),
                    _raw: prog,
                  })
                }
              } else {
                // Generic format
                const progs = progData.items || progData.programs || progData.events || progData.itemRows || (Array.isArray(progData) ? progData : [])
                console.log('[TDT Spain] Generic U7D parsed', progs.length, 'programs')
                for (const prog of progs) {
                  let startTs = 0, startStr = ''
                  const bt = prog.begintime || prog.start || prog.begin || prog.startTime
                  if (bt) {
                    if (typeof bt === 'string' && /^\d{14}$/.test(bt)) {
                      const y = bt.slice(0,4), mo = bt.slice(4,6), d = bt.slice(6,8)
                      const h = bt.slice(8,10), mi = bt.slice(10,12), s = bt.slice(12,14)
                      const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
                      startTs = dt.getTime() / 1000; startStr = dt.toISOString()
                    } else if (typeof bt === 'number' && bt > 1000000000000) {
                      startTs = Math.floor(bt / 1000); startStr = new Date(bt).toISOString()
                    } else {
                      const dt = new Date(bt)
                      if (!isNaN(dt)) { startTs = dt.getTime() / 1000; startStr = dt.toISOString() }
                    }
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
            return items.slice(skip, skip + top)
          } catch (e) {
            logWarn(`TDT Spain U7D fetch failed for ${chKey}`, String(e?.message || e))
            console.error('[TDT Spain] U7D error for', chKey, ':', e?.message || e)
            return []
          }
        }

        // Default: all channels (only resolvable types)
        const resolvable = visible.filter(ch => RESOLVABLE_TYPES.has(String(ch.streamtype || '')))
        return resolvable.slice(skip, skip + top).map(ch => normalizeChannel(ch, cache.epg))
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

        // U7D program meta
        if (id.startsWith('u7d-')) {
          return {
            id,
            type: CONTENT_TYPES.LIVE,
            name: 'Programa U7D',
            title: 'Programa U7D',
            description: 'Contenido de los últimos 7 días',
            isU7d: true,
          }
        }

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

        // U7D program stream resolution
        if (id.startsWith('u7d-')) {
          const stream = await resolveU7dStream(id, cache)
          if (stream) {
            return [{ name: stream.name || 'U7D', url: stream.url, streamType: stream.streamType || 'hls', quality: stream.quality || 'VOD', headers: stream.headers }]
          }
          return []
        }

        // Live channel stream resolution
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

    async getEpg({ date, channelId } = {}) {
      try {
        let cache = loadCache()
        cache = await getChannels(cache)
        cache = await getEpg(cache)
        const epg = cache.epg || {}
        const channels = cache.channels || []
        const targetDate = date ? new Date(date) : new Date()
        const dayStr = targetDate.toISOString().slice(0, 10)
        console.log('[TDT Spain] getEpg for date', dayStr, '- epg keys:', Object.keys(epg).length, 'channels:', channels.length)
        let searchChannels = channels
        if (channelId) {
          searchChannels = channels.filter(ch => String(ch.id) === channelId || String(ch.epgid) === channelId)
        }
        const programs = []
        for (const ch of searchChannels) {
          if (String(ch.ocultar || '') === 'true') continue
          // Match by epgid/id first (EPG uses "La1.TV" as key, channel has epgid="La1.TV")
          const epgId = String(ch.epgid || ch.id || '')
          let events = epg[epgId] || epg[normKey(epgId)] || []
          if (events.length === 0) {
            const chName = String(ch.name || '')
            events = epg[chName] || epg[normKey(chName)] || []
            if (events.length === 0) {
              const variants = [chName + '.TV', chName.replace(/\s+/g, '') + '.TV', normKey(chName) + '.tv']
              for (const v of variants) {
                if (epg[v]) { events = epg[v]; break }
                if (epg[normKey(v)]) { events = epg[normKey(v)]; break }
              }
            }
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
        console.log('[TDT Spain] getEpg returning', programs.length, 'programs for', dayStr)
        return programs
      } catch (e) {
        logWarn('TDT Spain getEpg failed', String(e?.message || e))
        console.error('[TDT Spain] getEpg error:', e)
        return []
      }
    },
  })
}
