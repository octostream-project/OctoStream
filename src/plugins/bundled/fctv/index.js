// FCTV sports plugin — live sports streams via the fctv*/rbtv* network.
// The web domain rotates frequently; the API data hosts are semi-stable and
// /api/common/params (ROT47 JSON) publishes the current web/player domains.
// Match list: GET {apiHost}/api/match/live?sportType=N (protobuf).
// Stream playback: the match page /{sport}/{league}-match-{id}/{team}-{MMYYYY}.html
// on a player domain is loaded by the app's WebView embed resolver which
// intercepts the media URL.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { logWarn } from '../../../utils/logger.js'
import {
  parseLiveResponse, parseDetailStreams, parseStreamDetail, parseUserInfo, rot47,
} from './proto.js'
import { enrichLogos } from '../../../utils/sofascore.js'
import { httpGetBlob, httpGetBlobWithHeaders, httpGetText, shortSignal } from '../../../utils/httpClient.js'
import { probeHlsQuality } from '../../../utils/streamProbe.js'

// slug → API sportType (values reverse-engineered from the official app)
const SPORT_TYPES = {
  football: 1, basketball: 2, tennis: 3, baseball: 4, cricket: 6,
  motorsport: 7, rugby: 8, 'american-football': 9, 'aussie-rules': 10,
  hockey: 11, badminton: 12, volleyball: 13, fighting: 14, cycling: 15,
  handball: 16, others: 90,
}
const SPORT_SLUG = Object.fromEntries(Object.entries(SPORT_TYPES).map(([k, v]) => [v, k]))

const SPORT_NAMES = {
  1: 'Fútbol', 2: 'Baloncesto', 3: 'Tenis', 4: 'Béisbol', 6: 'Cricket',
  7: 'Motor', 8: 'Rugby', 9: 'F. Americano', 10: 'Aussie Rules',
  11: 'Hockey', 12: 'Bádminton', 13: 'Voleibol', 14: 'Combate',
  15: 'Ciclismo', 16: 'Balonmano', 90: 'Otros',
}

// ─── Domain / host resolution ───────────────────────────────────────────────

const CONFIG_TTL = 30 * 60 * 1000
let cache = null // { ts, apiHost, webDomain, playerDomains }

// Semi-stable API data hosts (rotate rarely; params endpoint lives here).
// Los dos últimos salen del APK oficial v3.0.322 (com.rblive) — los mantienen
// como pool de respaldo.
const API_HOST_CANDIDATES = [
  'https://apis-data10.tcllu137fien.ru',
  'https://apis-data-defra10.tcllu137fien.ru',
  'https://apis-live.ta2mnt200stayr2.cfd',
  'https://apis-data10.tcdru136ovur.ru',
]

// Web-domain fallbacks if both params and hub page fail
const WEB_DOMAIN_FALLBACKS = [
  'https://www.fctv33hd.digital',
  'https://www.fctv33hd.icu',
]

// Player-iframe domain fallbacks (g_player_domains.foth)
const PLAYER_DOMAIN_FALLBACKS = [
  'https://jack29eo.mpgreatestclgczbmiddle.my',
  'https://nadia59bc.mp77g69ainei3gx2voxygen.ru',
  'https://morgan33cg.006hndchurch05g7ifbreathing.sbs',
]

// Direct iframe-player host fallbacks (common:web:client.*.iframePlayerDomains).
// teagan01bp.* es el Referer oficial según el rbHeaders embebido del APK.
const IFRAME_DOMAIN_FALLBACKS = [
  'nadia01eo.tn76degree12ec3out.cfd',
  'mimi01eo.fut0newsiryroquite.cfd',
  'tim01bp.2wc4tool8utphnumber.cfd',
  'teagan01bp.mvksstick9uq6cprotection.cfd',
]

function safeJson(s) { try { return JSON.parse(s) } catch { return null } }

// El CDN de logos rota (logosN.<dominio>.cfd suele estar muerto); el host
// actual visto en el APK oficial sirve los mismos paths /aelogo/...
const LOGO_CDN_HOST = 'https://logos1.tcdru136ovur.ru'
const fixLogoCdn = (u) =>
  /^https?:\/\/logos\d*\.[a-z0-9-]+\.cfd\//i.test(u || '')
    ? u.replace(/^https?:\/\/[^/]+/i, LOGO_CDN_HOST)
    : u

async function fetchParams(apiHost, signal) {
  const { data: raw } = await httpGetText(`${apiHost}/api/common/params`, {}, signal)
  if (!raw || raw.length > 2_000_000) throw new Error('params: bad response')
  return JSON.parse(rot47(raw))
}

function parseConfig(params, apiHost) {
  const targets = safeJson(params['common:web:sw2'])?.targets
  const foth = targets?.[0]?.digit?.foth || targets?.[0]?.digit?.seth
  const webDomain = foth?.main?.startsWith('https://') ? foth.main : WEB_DOMAIN_FALLBACKS[0]

  const pd = safeJson(params['g_player_domains'])
  const playerDomains = (pd?.foth || pd?.seth || [])
    .filter(d => typeof d === 'string' && d.startsWith('https://'))
    .map(d => d.replace(/\/+$/, ''))

  // Iframe player hosts live under common:web:client.<brand>.iframePlayerDomains
  const client = safeJson(params['common:web:client']) || {}
  const iframeDomains = Object.values(client)
    .flatMap(v => v?.iframePlayerDomains || [])
    .filter(d => typeof d === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))

  return {
    ts: Date.now(),
    apiHost,
    webDomain,
    playerDomains: playerDomains.length ? playerDomains : PLAYER_DOMAIN_FALLBACKS,
    iframeDomains: iframeDomains.length ? [...new Set(iframeDomains)] : IFRAME_DOMAIN_FALLBACKS,
  }
}

// Resolve { apiHost, webDomain, playerDomains }. Order: cached → params on
// known API hosts → hubu.ru biolink page → fallbacks.
async function resolveConfig(signal) {
  if (cache && Date.now() - cache.ts < CONFIG_TTL) return cache

  // 1. Params on the known API hosts also yields web domain + player domains.
  // Sonda paralela con timeout corto: un host caído no puede bloquear en
  // serie los siguientes candidatos durante 20s cada uno.
  try {
    const hit = await Promise.any(API_HOST_CANDIDATES.map(async (apiHost) => {
      const params = await fetchParams(apiHost, shortSignal(signal, 6000))
      return parseConfig(params, apiHost)
    }))
    cache = hit
    return cache
  } catch (e) {
    if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err }
    // Todos los hosts fallaron → hubu.ru biolink como último recurso.
  }

  // 2. hubu.ru/fctvlink biolink page → href to the current domain
  let webDomain = null
  try {
    const { data: html } = await httpGetText('https://hubu.ru/fctvlink', {}, signal)
    const m = html.match(/href="(https:\/\/(?:www\.)?(?:fctv|rbtv|sokapicks)[^"]*)"/i)
      || html.match(/href="(https:\/\/[^"]+)"[^>]*data-track-biolink-block-id/i)
    if (m) webDomain = new URL(m[1]).origin
  } catch { /* fall through */ }

  cache = {
    ts: Date.now(),
    apiHost: API_HOST_CANDIDATES[0],
    webDomain: webDomain || WEB_DOMAIN_FALLBACKS[0],
    playerDomains: PLAYER_DOMAIN_FALLBACKS,
    iframeDomains: IFRAME_DOMAIN_FALLBACKS,
  }
  return cache
}

// ─── API client ─────────────────────────────────────────────────────────────

function blobToBuffer(data) {
  // CapacitorHttp returns base64 strings for blob responses on Android —
  // except when the server lies about Content-Type (e.g. application/json
  // on a protobuf body), in which case it returns the UTF-8-decoded text.
  if (typeof data === 'string') {
    try {
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes.buffer
    } catch {
      // UTF-8-decoded text: re-encoding recovers the original bytes.
      // U+FFFD would mean the body was corrupted by the decode.
      if (data.includes('\uFFFD')) throw new Error('protobuf body corrupted by text decode')
      return new TextEncoder().encode(data).buffer
    }
  }
  return data.arrayBuffer()
}

// apiHost failover: si el host cacheado muere (los dominios rotan), invalidar
// la config y reintentar una vez con el siguiente candidato.
async function apiCall(cfg0, fn, signal) {
  let cfg = cfg0
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn(cfg)
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      if (attempt === 0) {
        cache = null // forzar re-resolución (itera los hosts API candidatos)
        try { cfg = await resolveConfig(signal) } catch { throw e }
        if (cfg.apiHost === cfg0.apiHost) throw e // mismo host — sin alternativa
      } else throw e
    }
  }
}

async function apiGet(cfg, path, params, signal) {
  const qs = new URLSearchParams(params).toString()
  return apiCall(cfg, async (c) => {
    const data = await httpGetBlob(`${c.apiHost}${path}?${qs}`, {
      'Referer': c.webDomain + '/',
      'Accept': 'application/octet-stream, */*',
    }, signal)
    return blobToBuffer(data)
  }, signal)
}

// Same as apiGet but also returns response headers (rb-session lives there).
async function apiGetRaw(cfg, path, params, signal) {
  const qs = new URLSearchParams(params).toString()
  return apiCall(cfg, async (c) => {
    const { data, headers } = await httpGetBlobWithHeaders(`${c.apiHost}${path}?${qs}`, {
      'Referer': c.webDomain + '/',
      'Accept': 'application/octet-stream, */*',
    }, signal)
    const hdrs = {}
    for (const [k, v] of Object.entries(headers || {})) hdrs[k.toLowerCase()] = v
    return { buf: await blobToBuffer(data), headers: hdrs }
  }, signal)
}

// ─── Normalization ──────────────────────────────────────────────────────────

const LIST_TTL = 60 * 1000 // live data changes fast
const listCache = new Map()

function formatMatchTime(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

// Real match-page URL used by the site and the player iframe hosts:
// /{sportSlug}/{leagueSlug}-match-{matchId}/{teamSlug}-{MMYYYY}.html
function matchPageUrl(base, m) {
  const sportSlug = SPORT_SLUG[m.sportType] || 'football'
  const league = m.leagueSlug || 'league'
  const team = m.slug || `match-${m.matchId}`
  const d = new Date(m.matchDate || Date.now())
  const mmyyyy = String(d.getMonth() + 1).padStart(2, '0') + d.getFullYear()
  return `${base}/${sportSlug}/${league}-match-${m.matchId}/${team}-${mmyyyy}.html`
}

function matchToItem(m, cfg, streamEntry) {
  const hasStream = !!streamEntry
  const name = m.title || [m.home.name, m.away.name].filter(Boolean).join(' vs ')
  const sportName = SPORT_NAMES[m.sportType] || 'Deporte'
  const league = m.league?.name || ''
  const time = formatMatchTime(m.matchDate)

  const desc = [
    sportName,
    league,
    time,
    m.score?.home != null && m.score?.away != null ? `${m.score.home} - ${m.score.away}` : null,
  ].filter(Boolean).join(' · ')

  return {
    id: `fctv:${m.matchId}:${m.sportType}`,
    type: CONTENT_TYPES.CHANNEL,
    name: `${hasStream ? '🔴 ' : ''}${name}`,
    title: name,
    poster: m.home?.logo || m.league?.logo || null,
    description: desc,
    genre: sportName,
    url: matchPageUrl(cfg.webDomain, m),
    pluginId: 'fctv',
    _sportType: m.sportType,
    _leagueSlug: m.leagueSlug,
    _slug: m.slug,
    _matchDate: m.matchDate,
    _isLive: hasStream,
    // Structured metadata for the sports page (team crests, league, kickoff).
    _home: m.home?.name ? { name: m.home.name, logo: m.home.logo || null } : null,
    _away: m.away?.name ? { name: m.away.name, logo: m.away.logo || null } : null,
    _league: m.league?.name ? { name: m.league.name, logo: m.league.logo || null } : null,
    _score: m.score || null,
    _status: m.status || 0,
    _sportName: sportName,
  }
}

// ─── Direct stream resolution ───────────────────────────────────────────────
// Reverse-engineered from the official player bundle:
//  1. /api/match/detail?stream=true&usls=rbp → stream entries {streamId, siteType}
//  2. /api/stream/detail?…&usls=rbp&continent&country → f4=ROT47 url (8-char
//     prefix), f12=ROT47 backup origins, header rb-session
//  3. final url = origin + '/token-' + encUri(base64(AES-256-CBC(rbSession))) + 'a'
//     + pathname + search

const TOKEN_KEY = 'a7981cc9eb2f4d19dcfea57b101ecd89'
const TOKEN_IV = '8017d3a8f1400d2f'
let tokenKeyPromise = null

function u8ToB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  }
  return btoa(s)
}

async function signRbSession(rbSession) {
  const te = new TextEncoder()
  if (!tokenKeyPromise) {
    tokenKeyPromise = crypto.subtle.importKey('raw', te.encode(TOKEN_KEY), 'AES-CBC', false, ['encrypt'])
  }
  const key = await tokenKeyPromise
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: te.encode(TOKEN_IV) }, key, te.encode(rbSession))
  return encodeURIComponent(u8ToB64(new Uint8Array(ct))) + 'a'
}

function decodeStreamUrl(enc) {
  const dec = rot47(enc).slice(8)
  return /^https:\/\//.test(dec) ? dec : ''
}

let userInfoCache = null // { ts, country, continent }
async function getUserInfo(cfg, signal) {
  if (userInfoCache && Date.now() - userInfoCache.ts < CONFIG_TTL) return userInfoCache
  try {
    const buf = await apiGet(cfg, '/api/user/info', {}, signal)
    const ui = parseUserInfo(new Uint8Array(buf))
    userInfoCache = { ts: Date.now(), ...ui }
  } catch {
    userInfoCache = { ts: Date.now(), country: '', continent: '' }
  }
  return userInfoCache
}

async function resolveDirectStreams(cfg, m, signal) {
  const detBuf = await apiGet(cfg, '/api/match/detail', {
    matchId: m.matchId, sportType: m.sportType, stream: 'true', usls: 'rbp',
  }, signal)
  const entries = parseDetailStreams(new Uint8Array(detBuf))
    .filter(e => e.streamId && e.siteType)
  if (!entries.length) return []

  const ui = await getUserInfo(cfg, signal)
  const geo = ui.country ? { continent: ui.continent, country: ui.country } : {}
  const streams = []

  for (const e of entries.slice(0, 4)) {
    try {
      const { buf, headers } = await apiGetRaw(cfg, '/api/stream/detail', {
        matchId: m.matchId, sportType: m.sportType,
        streamId: e.streamId, siteType: e.siteType, usls: 'rbp', ...geo,
      }, signal)
      const sd = parseStreamDetail(new Uint8Array(buf))
      const rbSession = headers['rb-session']
      const decUrl = decodeStreamUrl(sd.url)
      if (!decUrl || !rbSession) continue

      const token = await signRbSession(rbSession)
      const u = new URL(decUrl)
      const sign = (origin) => `${origin}/token-${token}${u.pathname}${u.search}`
      const label = sd.name || e.name || 'Live'
      // The segment CDN 302-redirects to an edge host that requires the
      // iframe-player Referer — ExoPlayer must send it on every request.
      // Rotar el dominio de iframe por entrada: si uno muere, los siguientes
      // enlaces usan otro (los dominios rotan a menudo).
      const iframeDom = cfg.iframeDomains[streams.length % cfg.iframeDomains.length] || cfg.iframeDomains[0]
      const reqHeaders = { Referer: `https://${iframeDom}/` }

      streams.push({
        name: label,
        title: 'FCTV · Directo',
        url: sign(u.origin),
        streamType: 'hls',
        quality: 'LIVE',
        isLive: true,
        headers: reqHeaders,
        _noCache: true,
      })
      // Backup origins (same token works across their CDN hosts)
      for (const b of sd.backups.slice(0, 2)) {
        const bd = decodeStreamUrl(b)
        if (!bd) continue
        try {
          streams.push({
            name: `${label} (alt)`,
            title: 'FCTV · Directo (respaldo)',
            url: sign(new URL(bd).origin),
            streamType: 'hls',
            quality: 'LIVE',
            isLive: true,
            headers: reqHeaders,
            _noCache: true,
          })
        } catch { /* bad backup origin */ }
      }
    } catch (e2) {
      if (e2?.name === 'AbortError') throw e2
      logWarn('[FCTV] stream detail failed:', String(e2?.message || e2))
    }
  }
  // Resolución real del master .m3u8 (los CDN rotan; sonda paralela con
  // timeout propio — nunca bloquea la lista si un origen está caído).
  await Promise.allSettled(streams.slice(0, 8).map(async (s) => {
    const q = await probeHlsQuality(s.url, s.headers, signal)
    if (q) s.quality = q
  }))
  return streams
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

function buildCatalogs() {
  return [
    { id: 'fctv-football', name: 'Fútbol', type: CONTENT_TYPES.CHANNEL },
    { id: 'fctv-basketball', name: 'Baloncesto', type: CONTENT_TYPES.CHANNEL },
    { id: 'fctv-tennis', name: 'Tenis', type: CONTENT_TYPES.CHANNEL },
    { id: 'fctv-motor', name: 'Motor', type: CONTENT_TYPES.CHANNEL },
    { id: 'fctv-others', name: 'Otros deportes', type: CONTENT_TYPES.CHANNEL },
  ]
}

const CATALOG_SPORT = {
  'fctv-football': SPORT_TYPES.football,
  'fctv-basketball': SPORT_TYPES.basketball,
  'fctv-tennis': SPORT_TYPES.tennis,
  'fctv-motor': SPORT_TYPES.motorsport,
  'fctv-others': SPORT_TYPES.others,
}

async function fetchLive(cfg, sportType, signal) {
  const cacheKey = `live:${sportType}`
  const hit = listCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < LIST_TTL) return hit.items

  // sportType=0 returns all sports; `language` param makes the API 499 — omit it.
  const buf = await apiGet(cfg, '/api/match/live', { sportType }, signal)
  const parsed = parseLiveResponse(new Uint8Array(buf))
  // live list stream markers carry matchId (f50) — a match is streamable
  // when its matchId appears there.
  const streamByMatch = new Map()
  for (const s of parsed.streams) {
    if (s.matchId && !streamByMatch.has(s.matchId)) streamByMatch.set(s.matchId, s)
  }

  const items = parsed.matches
    .filter(m => m.matchId && (m.title || m.home?.name || m.away?.name))
    .map(m => matchToItem(m, cfg, streamByMatch.get(m.matchId)))
    .sort((a, b) => (b._isLive ? 1 : 0) - (a._isLive ? 1 : 0))

  // El CDN de logos de FCTV está muerto: pasada rápida de Sofascore (eventos
  // live, ~1 request por deporte). La búsqueda profunda de escudos la hace
  // la página en segundo plano tras pintar las tarjetas.
  try { await enrichLogos(items, signal, { deep: false }) } catch { /* best-effort */ }

  // El CDN de logos rotó de logos*.cfd (muerto) a logos1.tcdru136ovur.ru:
  // reescribir los que Sofascore no haya cubierto (sirven en redes sin
  // bloqueo; donde haya bloqueo el <img> falla y se oculta, sin regresión).
  for (const it of items) {
    for (const side of ['_home', '_away', '_league']) {
      if (it[side]?.logo) it[side].logo = fixLogoCdn(it[side].logo)
    }
    if (it.poster) it.poster = fixLogoCdn(it.poster)
  }

  listCache.set(cacheKey, { items, ts: Date.now() })
  return items
}

export const fctvFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'fctv',
    name: config.manifest?.name || 'FCTV Deportes',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'Deportes en directo — fútbol, baloncesto, tenis, motor y más.',
    types: [CONTENT_TYPES.CHANNEL],
    catalogs: buildCatalogs(),
    icon: 'trophy',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 50, signal }) {
      try {
        const cfg = await resolveConfig(signal)
        const sportType = CATALOG_SPORT[id] ?? 0
        const items = await fetchLive(cfg, sportType, signal)
        return items.slice(skip, skip + top)
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[FCTV] getCatalog failed:', String(e?.message || e))
        return []
      }
    },

    async getMeta({ id, signal }) {
      const matchId = parseInt(String(id).replace(/^fctv:/, ''), 10)
      if (!matchId) return null
      try {
        const cfg = await resolveConfig(signal)
        // The detail endpoint needs the sportType; live list already has it cached.
        for (const entry of listCache.values()) {
          const item = entry.items.find(i => i.id === id)
          if (item) return item
        }
        const items = await fetchLive(cfg, 0, signal)
        return items.find(i => i.id === id) || null
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[FCTV] getMeta failed:', String(e?.message || e))
        return null
      }
    },

    async getStreams({ id, signal }) {
      const parts = String(id).replace(/^fctv:/, '').split(':')
      const matchId = parts[0]
      if (!/^\d+$/.test(matchId)) return []
      try {
        const cfg = await resolveConfig(signal)
        // Recover match metadata from the cached catalog entries
        let item = null
        for (const entry of listCache.values()) {
          item = entry.items.find(i => i.id === id)
          if (item) break
        }

        const m = {
          matchId: Number(matchId),
          sportType: item?._sportType || Number(parts[1]) || SPORT_TYPES.football,
          leagueSlug: item?._leagueSlug,
          slug: item?._slug,
          matchDate: item?._matchDate,
        }

        // Embeds baratos primero: garantizan enlaces aunque la API de streams
        // se coma el timeout del manager (25s) en redes lentas de TV.
        // The site's own iframe uses mdata=b64(matchId_sportType). The player
        // page rejects requests without a Referer — pass the match page URL so
        // the native resolver sends it on the initial loadUrl.
        const referer = matchPageUrl(cfg.webDomain, m)
        const mdata = btoa(`${matchId}_${m.sportType}`)
        const embeds = []
        for (const [i, dom] of cfg.iframeDomains.slice(0, 3).entries()) {
          embeds.push({
            name: `FCTV Web ${i + 1}`,
            title: 'FCTV · Web',
            url: `https://${dom}/es/player.html?mdata=${mdata}&ilang=es`,
            referer,
            streamType: 'embed',
            quality: 'auto',
            isLive: true,
          })
        }

        // Fallback: the full match page on the player/web domains (the page
        // itself creates the iframe with the proper Referer).
        for (const [i, base] of [cfg.playerDomains[0], cfg.webDomain].entries()) {
          if (!base) continue
          embeds.push({
            name: `FCTV Página${i ? ' (alt)' : ''}`,
            title: 'FCTV · Web',
            url: matchPageUrl(base, m),
            streamType: 'embed',
            quality: 'auto',
            isLive: true,
          })
        }

        // Direct HLS: match/detail → stream/detail → ROT47 + rb-session token.
        // Presupuesto propio de 15s: si la API va lenta, se devuelven los
        // embeds en vez de reventar el timeout del manager y volver vacío.
        let direct = []
        try {
          direct = await resolveDirectStreams(cfg, m, shortSignal(signal, 15000))
        } catch (e) {
          if (signal?.aborted) throw e
          logWarn('[FCTV] direct resolve failed:', String(e?.message || e))
        }
        return [...direct, ...embeds]
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[FCTV] getStreams failed:', String(e?.message || e))
        return []
      }
    },

    async search({ query, signal }) {
      try {
        const cfg = await resolveConfig(signal)
        const items = await fetchLive(cfg, 0, signal)
        const q = query.toLowerCase()
        return items
          .filter(i => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
          .slice(0, 30)
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        logWarn('[FCTV] search failed:', String(e?.message || e))
        return []
      }
    },
  })
}
