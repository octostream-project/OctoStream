// Plurtasko bundled plugin for OctoStream.
// Aggregates multiple channel implementations (hdfull, animeflvone, etc.)
// into a single OctoStream plugin. Each channel handles its own scraping logic.
//
// This plugin is "completely external" in the sense that it is loaded via an
// external manifest but its implementation is bundled in the app (no remote
// server required). It uses CapacitorHttp on Android to bypass CORS.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { logWarn } from '../../../utils/logger.js'
import { withCancelTimeout } from '../../utils.js'

// Solo host para logs: las URLs de embed/debrid llevan tokens en el query.
const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

import { getTmdbApiKey } from '../../builtIn/tmdb.js'
import { resolveEmbed, resolveEmbedWithMeta, resolveEmbed69All, probeM3u8Quality, DEAD_LINK } from './resolver.js'
import { detectLangFromText, normalizeLang, extractQualityFromUrl, extractQualityFromText } from './meta.js'
import { isAlldebridEnabled, isAlldebridSupported, unlockLink, resolveMagnet } from '../alldebrid.js'
import { animeflvone } from './channels/animeflvone.js'
import { animeyt } from './channels/animeyt.js'
import { monoschinos } from './channels/monoschinos.js'
import { pelispedia } from './channels/pelispedia.js'
import { pelisplushd } from './channels/pelisplushd.js'
import { repelishd } from './channels/repelishd.js'
import { animeav1 } from './channels/animeav1.js'
import { hdfull, hasHdfullCredentials } from './channels/hdfull.js'
import { entrepeliculasyseries } from './channels/entrepeliculasyseries.js'
import { serieskao } from './channels/serieskao.js'
import { flizzmovies } from './channels/flizzmovies.js'
import { pelisgratishd } from './channels/pelisgratishd.js'
import { gnulatv } from './channels/gnulatv.js'
import { seriesyonkissx } from './channels/seriesyonkissx.js'
import { doramaexpress } from './channels/doramaexpress.js'
import { doramasyt } from './channels/doramasyt.js'
import { tioanime } from './channels/tioanime.js'
import { jkanime } from './channels/jkanime.js'
import { dontorrent } from './channels/dontorrent.js'
import { grantorrent } from './channels/grantorrent.js'
import { subtorrents } from './channels/subtorrents.js'
import { getItemSync } from '../../../utils/storage.js'

// Registry of all available channels.
// doramedplay excluido: el sitio pasó a ser 100% VIP (páginas de contenido
// redirigen a /vip/); catálogo y búsqueda siguen públicos pero no hay streams.
const CHANNELS = [hdfull, animeflvone, animeyt, monoschinos, pelispedia, pelisplushd, repelishd, animeav1, entrepeliculasyseries, serieskao, flizzmovies, pelisgratishd, gnulatv, seriesyonkissx, doramaexpress, doramasyt, tioanime, jkanime, dontorrent, grantorrent, subtorrents]

// Canales torrent: se desactivan con el ajuste "Búsquedas torrent" de
// Settings (octostream_torrent_search). Apagado = no se consultan los sitios
// de torrents ni se emiten streams .torrent/magnet.
const TORRENT_CHANNEL_IDS = new Set(['dontorrent', 'grantorrent', 'subtorrents'])
export const torrentSearchEnabled = () => getItemSync('octostream_torrent_search') !== 'false'
const activeChannels = () => torrentSearchEnabled()
  ? CHANNELS
  : CHANNELS.filter(ch => !TORRENT_CHANNEL_IDS.has(ch.id))

// Extract TMDB numeric ID from a meta id like "tmdb-movie-12345" or "tmdb-series-67890"
function extractTmdbId(id) {
  const m = id?.match(/^tmdb-(?:movie|series)-(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

// Fetch IMDb ID from TMDB external_ids endpoint.
// Returns "tt0111161" or null. Cached for 10 minutes (los `null` por fallo
// transitorio también expiran en vez de persistir toda la sesión).
const imdbIdCache = new Map()
const IMDB_CACHE_TTL = 10 * 60 * 1000
async function fetchImdbId(tmdbId, isMovie) {
  if (!tmdbId) return null
  const cacheKey = `${tmdbId}:${isMovie ? 'm' : 's'}`
  const cached = imdbIdCache.get(cacheKey)
  if (cached && (Date.now() - cached.ts < IMDB_CACHE_TTL)) return cached.value

  try {
    const apiKey = getTmdbApiKey()
    const endpoint = isMovie ? `/movie/${tmdbId}/external_ids` : `/tv/${tmdbId}/external_ids`
    const url = `https://api.themoviedb.org/3${endpoint}?api_key=${apiKey}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    })
    if (!res.ok) { imdbIdCache.set(cacheKey, { value: null, ts: Date.now() }); return null }
    const data = await res.json()
    const imdbId = data.imdb_id || null
    imdbIdCache.set(cacheKey, { value: imdbId, ts: Date.now() })
    // Prune cache
    if (imdbIdCache.size > 100) {
      const first = imdbIdCache.keys().next().value
      imdbIdCache.delete(first)
    }
    return imdbId
  } catch {
    imdbIdCache.set(cacheKey, { value: null, ts: Date.now() })
    return null
  }
}

// Extract IMDb ID from an embed69/vidurl URL like ".../vidurl/tt0111161/"
function extractImdbFromUrl(url) {
  if (!url) return null
  const m = url.match(/\/vidurl\/(tt\d+)\b/)
  return m ? m[1] : null
}

// detectLangFromText, normalizeLang, extractQualityFromUrl y
// extractQualityFromText viven en ./meta.js (compartido con resolver.js,
// que captura metadatos de las páginas de embed durante la resolución).

// Prefiere etiquetas específicas (1080P, 720P, 4K, CAM) sobre genéricas
// (HD/SD), que solo se usan si no hay nada más preciso.
function pickQuality(...candidates) {
  let generic = ''
  for (const q of candidates) {
    if (!q) continue
    if (q === 'HD' || q === 'SD') { if (!generic) generic = q; continue }
    return q
  }
  return generic
}

// Ensure every stream has quality, lang, and a descriptive name.
// Called as a post-processing step on all resolved streams.
function normalizeStream(s) {
  const quality = pickQuality(s.quality, extractQualityFromText(s.title), extractQualityFromUrl(s.url)) || 'HD'
  // Lang priority: explicit field → name → title → filename in the URL.
  // Unknown stays '' instead of pretending to be Lat.
  let lang = normalizeLang(s.lang)
  if (!lang) lang = detectLangFromText(s.name)
  if (!lang) lang = detectLangFromText(s.title)
  if (!lang && s.url) {
    try {
      const path = decodeURIComponent(new URL(s.url).pathname.split('/').pop() || '')
      lang = detectLangFromText(path)
    } catch {}
  }
  const server = s.server || 'Unknown'
  // Build name: "Server (Lang) Quality" - e.g. "Streamwish (Lat) 1080P"
  const name = `${server}${lang ? ` (${lang})` : ''} ${quality}`.trim()
  return { ...s, quality, lang, server, name }
}

// Try to unlock a link via AllDebrid.
// Returns { link, via } or null.
async function debridUnlock(url) {
  // Convert mega.nz embed URLs to file URLs (Debrid expects /file/ not /embed/)
  let debridUrl = url
  if (/mega\.nz\/embed\//i.test(url)) {
    debridUrl = url.replace(/mega\.nz\/embed\//i, 'mega.nz/file/')
    console.log(`[Plurtasko] Converted Mega embed → file URL: ${debridUrl.substring(0, 80)}`)
  }
  // Some hosts always show captcha and can't be resolved with JS, so always try debrid
  const alwaysTryDebrid = /powvideo|streamplay|mega\.nz/i.test(debridUrl)
  if (!isAlldebridEnabled() || (!alwaysTryDebrid && !isAlldebridSupported(debridUrl))) return null
  try {
    const ad = await unlockLink(debridUrl)
    if (ad?.link) {
      console.log(`[AllDebrid] Unlocked: ${ad.link.substring(0, 80)}`)
      // If there are quality-specific streams, pick the best one
      let bestLink = ad.link
      if (ad.streams && ad.streams.length > 0) {
        const sorted = [...ad.streams].sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
        if (sorted[0]?.link) bestLink = sorted[0].link
      }
      return { link: bestLink, via: 'AllDebrid' }
    }
  } catch (e) {
    logWarn(`[AllDebrid] Failed to unlock: ${hostOf(debridUrl)}`, String(e?.message || e))
  }
  return null
}

// Try to resolve a magnet via AllDebrid.
// Returns { links, via } or null.
async function debridResolveMagnet(url, ep = {}) {
  if (!isAlldebridEnabled()) return null
  try {
    const links = await resolveMagnet(url, 30000, ep)
    if (links?.length) {
      console.log(`[AllDebrid] Resolved magnet: ${links.length} links`)
      return { links, via: 'AllDebrid' }
    }
  } catch (e) {
    logWarn(`[AllDebrid] Failed to resolve magnet:`, String(e?.message || e))
  }
  return null
}

// Validate a channel search result by TMDB/IMDb ID when the channel exposes it.
// Returns true if the result matches, false if it doesn't, null if no ID available.
function validateById(channel, resultUrl, tmdbId, imdbId) {
  // embed69/vidurl URLs contain IMDb IDs
  const urlImdb = extractImdbFromUrl(resultUrl)
  if (urlImdb) {
    if (imdbId && urlImdb === imdbId) return true
    if (imdbId && urlImdb !== imdbId) return false
    return null
  }
  // Channels with extractId method (e.g. poseidonhd with numeric TMDB IDs)
  if (channel.extractId && typeof channel.extractId === 'function') {
    const extractedId = channel.extractId(resultUrl)
    if (extractedId && tmdbId) {
      return extractedId === tmdbId
    }
  }
  return null
}

// Build a flat catalog list from all channels.
function buildCatalogs() {
  const catalogs = []
  for (const ch of activeChannels()) {
    for (const cat of ch.catalogs || []) {
      catalogs.push(cat)
    }
  }
  return catalogs
}

// Normalize a title for comparison: lowercase, strip articles, punctuation, accents.
function normalizeTitle(s) {
  if (!s) return ''
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/^(the|el|la|los|las|un|una|unos|unas|a|an)\s+/i, '') // strip articles
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Check if two titles are similar enough to be the same movie/show.
function isTitleMatch(itemName, targetName) {
  const a = normalizeTitle(itemName)
  const b = normalizeTitle(targetName)
  if (!a || !b) return false
  // Exact match after normalization (best case)
  if (a === b) return true
  const wordsA = a.split(/\s+/).filter(w => w.length >= 4)
  const wordsB = b.split(/\s+/).filter(w => w.length >= 4)
  // Single-word titles must match exactly to avoid false positives
  // (e.g. "Reacher" must NOT match "Preacher" even though it's a substring)
  if (wordsA.length <= 1 || wordsB.length <= 1) return false
  // Contains check: only if the shorter title is at least 80% of the longer one
  // This prevents "Matrix Revolutions" from matching "Matrix"
  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  if (longer.includes(shorter) && shorter.length >= longer.length * 0.8) return true
  // Word overlap check: require ALL significant words to match
  // (not just one, which caused false positives like "Reacher" matching "Preacher: Season 1")
  if (wordsA.length > 0 && wordsB.length > 0) {
    const shared = wordsA.every(w => wordsB.includes(w)) || wordsB.every(w => wordsA.includes(w))
    if (shared) return true
  }
  return false
}

// Find the channel that owns a given catalog id.
function channelForCatalog(catalogId) {
  for (const ch of activeChannels()) {
    if (ch.catalogs?.some(c => c.id === catalogId)) return ch
  }
  return null
}

// Extract channel id from a meta/stream id like "hdfull:https://..."
function channelForId(id) {
  if (typeof id !== 'string' || !id.includes(':') || id.length > 4096) return null
  const separator = id.indexOf(':')
  const prefix = id.slice(0, separator)
  const payload = id.slice(separator + 1)
  const channel = activeChannels().find(ch => ch.id === prefix) || null
  if (!channel || !payload || /[\u0000-\u001f]/.test(payload)) return null
  if (!/^https?:\/\//i.test(payload)) return channel
  try {
    const url = new URL(payload)
    const host = url.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) return null
    if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return null
    const match = host.match(/^(172)\.(\d+)\./)
    if (match && Number(match[2]) >= 16 && Number(match[2]) <= 31) return null
    return channel
  } catch {
    return null
  }
}

function isEpisodicType(type) {
  return type === CONTENT_TYPES.SERIES || type === CONTENT_TYPES.ANIME || type === CONTENT_TYPES.DORAMA
}

function withSeasonsList(meta) {
  if (!meta || !isEpisodicType(meta.type) || meta.seasonsList?.length || !meta.episodes?.length) return meta
  const counts = new Map()
  for (const episode of meta.episodes) {
    const seasonNumber = Number(episode.season) || 1
    counts.set(seasonNumber, (counts.get(seasonNumber) || 0) + 1)
  }
  return {
    ...meta,
    seasonsList: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([seasonNumber, episodeCount]) => ({
        id: `${meta.id}:season:${seasonNumber}`,
        seasonNumber,
        episodeCount,
        name: `Temporada ${seasonNumber}`,
      })),
  }
}

function findProviderEpisode(episodes, season, episode, seasonsList) {
  if (!Array.isArray(episodes) || !episodes.length) return null
  let match = episodes.find(item => Number(item.season) === Number(season) && Number(item.episode) === Number(episode))
  if (!match && seasonsList && Number(season) > 1) {
    let absolute = Number(episode) || 1
    for (const item of seasonsList) {
      if (Number(item.seasonNumber) < Number(season)) absolute += Number(item.episodeCount) || 0
    }
    match = episodes.find(item => Number(item.episode) === absolute)
  }
  if (!match && Number(season) > 1 && episodes.every(item => (Number(item.season) || 1) === 1)) {
    match = episodes.find(item => Number(item.episode) === Number(episode))
  }
  return match || null
}

// Servers that are known to crash the app or be unresolvable server-side.
// These are filtered out to prevent the native WebView from loading pages
// that cause the app to exit (e.g. Doodstream's aggressive popups/redirects).
const BLOCKED_SERVERS = [
  // Supervideo returns 403 server-side
  'supervideo', 'supervideo.cc',
  // Dropstream has captcha on every page (Cloudflare Turnstile — imposible
  // resolver ni en WebView headless). Sin TLD para cubrir dominios rotados.
  'dropstream', 'dr0pstream',
  // Mega embed shows "preview not available" in WebView
  'mega.nz', 'mega.',
  // YouTube: trailers, "pelicula completa", "full movie" - not real streams
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  // Trailer servers
  'trailer',
  // Dead/parked domains — every link on these hosts is dead
  'wolfstream',
  // Auditoría 2025: hosts muertos o sin resolver funcional — no aportan nada
  // en el picker y solo añaden ruido/espera.
  'byse',            // bysefujedu/bysesukior/byseweb/bysexo/byses.org — dominios caídos
  'vidsonic',        // la página cambió de formato, el resolver no extrae
  'rpmvid',          // player propio de flizzmovies sin resolver
  'upnshare', 'uns.bio', // animeav1 — sin resolver
  'vimeos',          // vimeos.net — sin resolver
  'la.movie', 'lamovie', // enlaces muertos
  'mediafire',     // página de descarga, no stream
  'ok.ru', 'okru', // sin resolver ni soporte debrid — embed que no carga
  // PowVideo/StreamPlay sirven reCAPTCHA en TODOS los embeds (form + token):
  // sin cuenta debrid son enlaces captcha garantizados. Debrid los desbloquea
  // directo — se mantienen visibles solo cuando hay cuenta configurada.
  'powvideo', 'powwideo', 'powvldeo', 'povwideo',
  'streamplay', 'stape.fun', 'watchadsontape',
]

// Servers that are normally blocked but can be unlocked via AllDebrid.
// When a debrid account is configured, these are NOT filtered out.
// Based on the actual AllDebrid supported hosts.
const DEBRID_UNLOCKABLE = [
  // Voe — resolver JS propio (port ResolveURL), no necesita debrid pero se
  // mantiene aquí para que el filtro no lo descarte cuando hay cuenta.
  'voe.sx', 'voe-unblock', 'voeunblock', 'eugenemakedraw', 'morencius',
  // Mixdrop (AllDebrid)
  'mixdrop.co', 'mixdrop.to', 'mixdrop.sx', 'mixdrop.ag', 'mixdrop.bz',
  // Streamtape (AllDebrid)
  'streamtape.com', 'streamtape.to',
  // Upstream — resolver JS propio.
  'upstream.to',
  // Doodstream NO está: AllDebrid no lo soporta (verificado contra /hosts) —
  // va por el resolver propio (port AniWorld).
  // Mega (AllDebrid)
  'mega.nz', 'mega.',
  // 1fichier (AllDebrid)
  '1fichier',
  // Rapidgator (AllDebrid)
  'rapidgator',
  // Turbobit (AllDebrid)
  'turbobit',
  // Hitfile (AllDebrid)
  'hitfile',
  // File hosts (AllDebrid)
  'katfile.com', 'filefactory', 'file.al', 'filedot', 'filespace',
  'filerio', 'filezip', 'prefiles', 'alfafile', 'simfileshare', 'world-files',
]

// Cache of search results by title+type+season+episode (5 min TTL)
const searchCache = new Map()
const SEARCH_CACHE_TTL = 5 * 60 * 1000

function getCachedSearch(key) {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return entry.streams
}

function setCachedSearch(key, streams) {
  searchCache.set(key, { streams, ts: Date.now() })
  // Prune old entries
  if (searchCache.size > 50) {
    const now = Date.now()
    for (const [k, v] of searchCache) {
      if (now - v.ts > SEARCH_CACHE_TTL) searchCache.delete(k)
    }
  }
}

// Resolve embed streams to direct playable URLs.
// On Android TV (low memory), we limit resolution to avoid OOM:
// - Direct streams (mp4/hls) are kept as-is
// - Embed streams are kept as embed for the native WebView to handle
// - Only embed69 URLs are expanded (they contain multiple servers)
function normalizeStreamForPlayback(stream) {
  const url = String(stream?.url || '')
  const lowerUrl = url.toLowerCase()
  const server = String(stream?.server || '').toLowerCase().trim()
  const isHls = /\.m3u8(?:$|[?#])|\/master(?:\.m3u8)?(?:$|[?#])|\/hls(?:\/|[?#])/i.test(url)
  const isFile = /\.(?:mp4|mkv|webm)(?:$|[?#])/i.test(url)
    || /videoplayback|\/(?:c1|um|jk)\.php(?:[?#]|$)/i.test(url)

  // Some channels emit an actual media URL with streamType=embed. URL wins.
  if (isHls || isFile) return { ...stream, streamType: isHls ? 'hls' : 'mp4' }

  // morencius /embed pages are Vidhide pages, not Voe pages.
  if (/morencius/i.test(lowerUrl) && /\/embed\//i.test(lowerUrl)) {
    return { ...stream, server: 'vidhide', name: String(stream.name || '').replace(/voe/i, 'vidhide') }
  }

  // A server labelled "directo" is intended for native playback.
  if (server === 'directo' && /^https?:\/\//i.test(url)) {
    return { ...stream, streamType: 'mp4' }
  }

  return stream
}

// Dedupe torrent streams: the same .torrent often appears via mirrors or
// repeated across a channel's pages. Key = provider + release (magnet btih
// infohash or decoded .torrent filename) — the provider stays in the key so
// the same release listed by two torrent sites shows one entry per site
// (the user picks the source); only true repeats within a site collapse.
// Debrid-resolved variants dedupe by originalUrl.
function dedupeTorrentStreams(streams) {
  const pos = new Map()
  const keyOf = (s) => {
    const src = String(s.originalUrl || s.url || '')
    const site = String(s.server || '').toLowerCase()
    const btih = src.match(/btih:([a-zA-Z0-9]{32,40})/i)?.[1].toLowerCase()
    if (btih) return site + '|btih:' + btih
    try { return site + '|' + decodeURIComponent(src.split('/').pop() || '').toLowerCase().replace(/[?#].*$/, '').trim() }
    catch { return site + '|' + src.toLowerCase() }
  }
  const out = []
  for (const s of streams) {
    const src = String(s.originalUrl || s.url || '')
    const isTorrent = s.streamType === 'torrent' || /magnet:|\.torrent/i.test(src)
    if (!isTorrent) { out.push(s); continue }
    const key = keyOf(s)
    if (!key) { out.push(s); continue }
    const prev = pos.get(key)
    if (prev === undefined) { pos.set(key, out.length); out.push(s); continue }
    // Prefer the debrid-resolved variant (direct mp4/hls) over the raw torrent.
    const prevIsResolved = !/\.torrent|magnet:/i.test(String(out[prev].url || ''))
    const curIsResolved = !/\.torrent|magnet:/i.test(String(s.url || ''))
    if (curIsResolved && !prevIsResolved) out[prev] = s
  }
  return out
}

async function resolveStreams(streams, onBatch, context = {}) {
  if (!streams || !streams.length) return []

  // Filter out blocked servers that crash the app
  const debridActive = isAlldebridEnabled()
  const normalizedStreams = streams.map(normalizeStreamForPlayback)
  const isBlockedStream = (url, server, name) => {
    const urlLower = (url || '').toLowerCase()
    const serverLower = (server || '').toLowerCase()
    const nameLower = (name || '').toLowerCase()
    // Check if this server is debrid-unlockable
    const isDebridUnlockable = DEBRID_UNLOCKABLE.some(b => urlLower.includes(b) || serverLower.includes(b))
    // Filter blocked servers/hosts (unless debrid can unlock them)
    if (BLOCKED_SERVERS.some(b => urlLower.includes(b) || serverLower.includes(b))) {
      if (debridActive && isDebridUnlockable) {
        // Keep it - debrid will unlock it
      } else {
        return true
      }
    }
    // Filter YouTube trailers, "pelicula completa", "full movie" by name
    if (/youtube|trailer|pelicula completa|full movie|pelicula\s*completa/i.test(nameLower)) return true
    return false
  }
  const filtered = normalizedStreams.filter(s => !isBlockedStream(s.url, s.server, s.name))

  // Limit streams to avoid memory pressure on TV — por cupos: los embeds
  // tienen 30 huecos y cada proveedor torrent 10, así un solo canal no puede
  // consumir todo el límite y ocultar al resto de webs.
  const limited = []
  const perTorrentSite = new Map()
  let nonTorrentCount = 0
  for (const s of filtered) {
    const src = String(s.originalUrl || s.url || '')
    const isTorrent = s.streamType === 'torrent' || /magnet:|\.torrent/i.test(src)
    if (isTorrent) {
      const site = String(s.server || 'torrent').toLowerCase()
      const n = perTorrentSite.get(site) || 0
      if (n >= 10) continue
      perTorrentSite.set(site, n + 1)
    } else {
      if (nonTorrentCount >= 30) continue
      nonTorrentCount++
    }
    limited.push(s)
  }

  const expanded = []

  // Resolve all embed streams in parallel (much faster than sequential)
  const directStreams = limited.filter(s =>
    s.streamType === 'mp4' || s.streamType === 'hls' || s.streamType === 'dash' ||
    (s.streamType === 'torrent' && torrentSearchEnabled())
  )
  const debridEnabled = isAlldebridEnabled()
  const debridTasks = []
  for (const s of directStreams) {
    // Extract quality from direct URL if not already set
    const urlQuality = extractQualityFromUrl(s.url) || 'HD'

    // For torrents, try debrid services (converts magnet to direct stream).
    // .torrent URLs are converted to magnets first so debrid can ingest them.
    // Se lanzan en paralelo — un torrent no cacheado tarda ~30s de timeout y
    // en serie multiplicaría la espera por cada resultado.
    if (s.streamType === 'torrent' && debridEnabled) {
      debridTasks.push((async () => {
        let magnetUrl = null
        try {
          const { torrentUrlToMagnet, withDefaultTrackers } = await import('../../../utils/torrentFile.js')
          magnetUrl = /magnet:/.test(s.url) ? s.url : null
          if (!magnetUrl && /^https?:\/\//i.test(s.url)) {
            magnetUrl = await torrentUrlToMagnet(s.url)
          }
          if (magnetUrl) magnetUrl = withDefaultTrackers(magnetUrl)
          if (!magnetUrl) return [{ ...s, quality: urlQuality }]
          // Season/episode del contexto de la petición — el stream también
          // puede traerlos (filas por episodio de dontorrent).
          const ep = {
            season: s.season ?? context.season,
            episode: s.episode ?? context.episode,
          }
          const resolved = await debridResolveMagnet(magnetUrl, ep)
          if (resolved?.links?.length) {
            return resolved.links.map(link => ({
              ...s,
              url: link,
              streamType: /\.m3u8/i.test(link) || /m3u8/i.test(link) ? 'hls' : 'mp4',
              quality: urlQuality,
              server: s.server + ' (Debrid)',
              originalUrl: s.url,
              viaDebrid: resolved.via,
            }))
          }
        } catch (e) {
          logWarn(`[Debrid] Failed to resolve magnet: ${hostOf(s.url)}`, String(e?.message || e))
        }
        // Debrid no lo tenía cacheado → cae a P2P con el magnet ya enriquecido
        // con trackers públicos; se marca para que el usuario distinga el
        // fallback del stream "(Debrid)".
        return [{ ...s, url: magnetUrl || s.url, quality: urlQuality, server: s.server + ' (P2P)' }]
      })())
      continue
    }

    expanded.push(s.quality ? s : { ...s, quality: urlQuality })
  }
  for (const entries of await Promise.all(debridTasks)) expanded.push(...entries)

  // Emit direct streams immediately (they're already playable)
  if (onBatch && expanded.length > 0) onBatch(expanded)

  // Los torrent nunca pasan por resolución embed: habilitados van por la vía
  // directa (debrid/magnet); deshabilitados se descartan aquí.
  const embedStreams = limited.filter(s =>
    !(s.streamType === 'mp4' || s.streamType === 'hls' || s.streamType === 'torrent' || s.streamType === 'dash')
  )

  // Resolve all embeds in parallel with a concurrency limit
  const CONCURRENCY = 5
  const resolveOne = async (s) => {
    // Check if this is an embed69 URL (cuevana embed wrapper)
    if (s.url && /embed69\.org|cuevanapro\.org|\/vidurl\//.test(s.url)) {
      try {
        const servers = await resolveEmbed69All(s.url)
        if (servers && servers.length) {
          // Los servidores expandidos por embed69 llegan DESPUÉS del filtro
          // inicial — hay que aplicar BLOCKED_SERVERS aquí también o un host
          // vetado (supervideo, dropstream…) reaparece en el picker.
          const allowed = servers.filter(srv => !isBlockedStream(srv.url, srv.server, srv.server))
          // Try to resolve each server URL to a direct video URL
          const resolvedServers = await Promise.all(
            allowed.map(async srv => {
              // Already direct?
              if (/\.(?:m3u8|mp4|mkv)(\?|$)/i.test(srv.url) || /videoplayback/.test(srv.url)) {
                return { ...srv, directUrl: srv.url, streamType: /\.m3u8/i.test(srv.url) || /m3u8/i.test(srv.url) ? 'hls' : 'mp4' }
              }
              // Try JS resolver
              let srvMeta = {}
              try {
                const res = await resolveEmbedWithMeta(srv.url)
                const directUrl = res.url
                srvMeta = res.meta || {}
                if (directUrl === DEAD_LINK) return null
                if (directUrl && directUrl !== srv.url) {
                  const isHls = /\.m3u8/i.test(directUrl) || /m3u8/i.test(directUrl)
                  const streamType = isHls ? 'hls'
                    : /\.mp4/i.test(directUrl) ? 'mp4'
                    : /magnet:/.test(directUrl) ? 'torrent'
                    : 'hls'
                  return { ...srv, directUrl, streamType, meta: srvMeta }
                }
              } catch (e) {
                logWarn(`[Plurtasko] JS resolver failed for ${srv.server}: ${hostOf(srv.url)}`, String(e?.message || e))
              }
              // Try AllDebrid
              const debrid = await debridUnlock(srv.url)
              if (debrid?.link) {
                const isHls = /\.m3u8/i.test(debrid.link) || /m3u8/i.test(debrid.link)
                const streamType = isHls ? 'hls' : /\.mp4/i.test(debrid.link) ? 'mp4' : 'mp4'
                return { ...srv, directUrl: debrid.link, streamType, viaDebrid: debrid.via }
              }
              // Resolution failed - keep as embed for native WebView
              return { ...srv, directUrl: null, streamType: 'embed' }
            })
          )

          const results = []
          for (const srv of resolvedServers) {
            // Set Referer/Origin to the embed page origin
            const embedHost = (() => { try { return new URL(s.url).origin } catch { return '' } })()
            const headers = embedHost ? { Referer: embedHost + '/', Origin: embedHost } : {}

            // Extract quality from the resolved URL (m3u8/mp4 URLs often contain quality hints)
            const urlQuality = srv.directUrl ? extractQualityFromUrl(srv.directUrl) : ''
            const meta = srv.meta || {}
            const lang = srv.lang || s.lang || meta.lang || ''

            if (!srv.directUrl) {
              // Keep unresolved embeds - the WebView/native player can try to play them
              results.push({
                ...s,
                name: `${srv.server}${lang ? ` (${lang})` : ''}`,
                url: srv.url,
                streamType: 'embed',
                server: srv.server,
                lang,
                quality: pickQuality(meta.quality, srv.quality, s.quality),
                title: meta.title || s.title,
                originalUrl: s.url,
                headers,
              })
              continue
            }
            const quality = pickQuality(urlQuality, meta.quality, srv.quality, s.quality)
            const srvName = srv.viaDebrid ? `${srv.server} (Debrid)` : srv.server
            results.push({
              ...s,
              name: `${srvName}${lang ? ` (${lang})` : ''}`,
              url: srv.directUrl,
              streamType: srv.streamType,
              server: srvName,
              lang,
              quality,
              title: meta.title || s.title,
              originalUrl: s.url,
              headers,
              viaDebrid: srv.viaDebrid,
            })
          }
          return results
        }
      } catch (e) {
        logWarn(`[Plurtasko] Failed to extract embed69 servers from ${hostOf(s.url)}`, String(e?.message || e))
      }
      return []
    }

    // Other embed types - try JS resolver, then AllDebrid, keep as embed if both fail
    if (s.streamType === 'embed' || s.streamType === 'iframe' || !s.streamType) {
      let directUrl = null

      // Premium/captcha hosts - skip JS resolver, go straight to debrid
      // Rapidgator, Nitroflare, Mega and similar always need a premium account or captcha
      const isPremiumHost = /1fichier|rapidgator|turbobit|nitroflare|katfile|filefactory|uptobox|clicknupload|hexupload|hitfile|ddownload|ddl\.to|filespace|filestore|filextras|mediafire|prefiles|uploady|wipfiles|mexa\.sh|isra\.cloud|terabytez|4shared|brupload|dailyuploads|gigapeta|file\.al|filedot|filerio|filezip|alfafile|simfileshare|world-files|mega\.nz|mega\.co\.nz/i.test(s.url)

      let embedMeta = {}
      if (!isPremiumHost) {
        try {
          const res = await resolveEmbedWithMeta(s.url)
          directUrl = res.url
          embedMeta = res.meta || {}
          if (directUrl === DEAD_LINK) {
            console.log(`[Plurtasko] Dead link dropped: ${s.url}`)
            return []
          }
          if (directUrl === s.url) directUrl = null
          console.log(`[Plurtasko] resolveEmbed ${s.server}: ${directUrl ? directUrl.substring(0, 80) : 'FAILED'}`)
        } catch (e) {
          logWarn(`[Plurtasko] Failed to resolve ${hostOf(s.url)}`, String(e?.message || e))
        }
      }

      // Try debrid services if JS resolver failed (or if it's a premium host)
      if (!directUrl) {
        console.log(`[Plurtasko] Trying debrid for: ${s.url}`)
        const debrid = await debridUnlock(s.url)
        if (debrid?.link) {
          directUrl = debrid.link
          console.log(`[Plurtasko] Debrid unlocked: ${s.url} → ${directUrl.substring(0, 80)}`)
        } else {
          console.log(`[Plurtasko] Debrid failed for: ${s.url}`)
        }
      }

      if (directUrl) {
        // Detect stream type from URL - check for HLS patterns including query params
        const isHls = /\.m3u8/i.test(directUrl) || /m3u8/i.test(directUrl)
        const isMp4 = /\.mp4/i.test(directUrl)
        const isMagnet = /magnet:/.test(directUrl)
        // Debrid download links (alldebrid.com/d/...) are direct file downloads, not HLS
        const isDebridDownload = /download\.alldebrid\.com|alldebrid\.com\/d\//i.test(directUrl)
        const newType = isHls ? 'hls'
          : isMp4 ? 'mp4'
          : isMagnet ? 'torrent'
          : isDebridDownload ? 'mp4'
          : 'hls' // Default to HLS for streaming servers (fastream, streamwish, etc.)
        console.log(`[Plurtasko] Resolved ${s.server}: ${directUrl.substring(0, 80)} → ${newType}`)
        // Set Referer/Origin based on provider.
        // Fastream requires the exact Kodi headers used by Alfa/Balandro:
        // Referer = https://fastream.to/ and Origin = https://fastream.to
        const embedHost = (() => { try { return new URL(s.url).origin } catch { return '' } })()
        const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        const isFastream = /fastream\.?to/i.test(s.server || '') || /fastream\.?to/i.test(s.url)
        const isVoe = /voe\.?sx|voe-unblock|voeunblock/i.test(s.server || '') || /\bvoe\b/i.test(s.url)
        // mxcontent.net (MixDrop CDN) 403s without Referer: https://miixdrop.net/
        const isMxcontent = /mxcontent\.net|miixdrop|mixdrop|mixdrp/i.test(directUrl) || /mixdrop|mixdrp|miixdrop/i.test(s.url)
        const headers = { 'User-Agent': DESKTOP_UA }
        if (isMxcontent) {
          headers.Referer = 'https://miixdrop.net/'
        } else if (embedHost) {
          if (isFastream) {
            headers.Referer = s.url
            headers.Origin = embedHost
            headers.Accept = 'application/vnd.apple.mpegurl, */*;q=0.9'
            headers['Accept-Language'] = 'es-ES,es;q=0.9,en-US;q=0.5,en;q=0.3'
          } else if (!isVoe) {
            // Voe CDN links work with UA only; adding a cross-domain Referer can 403
            headers.Referer = s.url
          }
        }
        let urlQuality = extractQualityFromUrl(directUrl)
        // Calidad real desde la página del embed (título del release) o, si la
        // URL directa no la delata, leyendo la playlist m3u8.
        let quality = pickQuality(urlQuality, embedMeta.quality, s.quality)
        if ((!quality || quality === 'HD') && /\.m3u8/i.test(directUrl)) {
          const probed = await probeM3u8Quality(directUrl, s.url)
          if (probed) quality = pickQuality(probed, quality)
        }
        const lang = s.lang || embedMeta.lang || ''
        // For premium hosts unlocked via debrid, use a descriptive server name
        let serverName = s.server
        if (isPremiumHost) {
          const hostMatch = s.url.match(/https?:\/\/([^\/]+)/)
          serverName = hostMatch ? hostMatch[1].replace(/^www\./, '') + ' (Debrid)' : 'Premium (Debrid)'
        }
        return [{ ...s, server: serverName, name: serverName + (lang ? ` (${lang})` : ''), url: directUrl, streamType: newType, quality, lang, title: embedMeta.title || s.title, originalUrl: s.url, headers }]
      }
      // Keep as embed - the WebView/native player can try to play it.
      // But skip hosts that can never be played without debrid:
      // - premium file hosts (rapidgator, nitroflare, etc.) when debrid failed
      if (isPremiumHost) {
        console.log(`[Plurtasko] Skipping ${s.server} (no playable URL available, debrid failed or not supported)`)
        return []
      }
      const embedHost = (() => { try { return new URL(s.url).origin } catch { return '' } })()
      const headers = embedHost
        ? { Referer: embedHost + '/', Origin: embedHost, 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' }
        : { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' }
      return [{ ...s, streamType: 'embed', lang: s.lang || embedMeta.lang || '', quality: s.quality || embedMeta.quality || '', title: embedMeta.title || s.title, originalUrl: s.url, headers }]
    }

    return []
  }

  // Process embeds in parallel batches, emitting as they arrive
  for (let i = 0; i < embedStreams.length; i += CONCURRENCY) {
    const batch = embedStreams.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(s => resolveOne(s)))
    for (const results of batchResults) {
      expanded.push(...results)
    }
    // Emit progressive update after each batch
    if (onBatch && expanded.length > 0) onBatch(expanded)
  }

  console.log(`[Plurtasko] resolveStreams: ${streams.length} raw → ${expanded.length} expanded (direct: ${directStreams.length}, embed: ${embedStreams.length})`)
  // Normalize all streams to ensure they have quality, lang, and a descriptive name
  return expanded.map(normalizeStream)
}

export { CHANNELS }
export const plurtaskoFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'plurtasko',
    name: config.manifest?.name || 'Plurtasko',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'Canales de películas, series y anime.',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME, CONTENT_TYPES.DORAMA],
    catalogs: buildCatalogs(),
    icon: 'film',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 50 }) {
      try {
        const channel = channelForCatalog(id)
        if (!channel) return []
        return await channel.getCatalog({ id, skip, top })
      } catch (e) {
        logWarn(`[Plurtasko] getCatalog failed for ${id}`, String(e?.message || e))
        return []
      }
    },

    async getMeta({ type, id }) {
      try {
        // Solo resolver meta para IDs propios de canales (ej: "hdfull:https://...")
        // Para IDs externos (TMDB), devolver null y dejar que TMDB maneje los metadatos.
        const channel = channelForId(id)
        if (!channel) return null
        const meta = await channel.getMeta({ type, id })
        return withSeasonsList(meta && type ? { ...meta, type } : meta)
      } catch (e) {
        logWarn(`[Plurtasko] getMeta failed for ${id}`, String(e?.message || e))
        return null
      }
    },

    async getStreams({ type, id, name, genres, season, episode, originalName, originCountry, originalLanguage, seasonsList, englishName, onBatch }) {
      const debridEnabled = isAlldebridEnabled()
      try {
        if (isEpisodicType(type) && (season == null || episode == null)) return []

        // Caso 1: ID propio de un canal (ej: "hdfull:https://...")
        const channel = channelForId(id)
        if (channel) {
          let streamId = id
          if (isEpisodicType(type)) {
            const providerMeta = withSeasonsList(await channel.getMeta({ type, id }))
            const providerEpisode = findProviderEpisode(providerMeta?.episodes, season, episode, seasonsList || providerMeta?.seasonsList)
            if (!providerEpisode?.id) return []
            streamId = providerEpisode.id
          }
          const rawStreams = await channel.getStreams({ type, id: streamId, season, episode, debridEnabled })
          return await resolveStreams(rawStreams, onBatch, { season, episode })
        }

        // Caso 2: ID externo (ej: TMDB) - buscar por nombre en todos los canales
        if (!name) return []

        // Check cache first (avoid re-searching the same title)
        const cacheKey = `${name.toLowerCase()}|${type}|${season || ''}|${episode || ''}`
        const cached = getCachedSearch(cacheKey)
        if (cached) {
          console.log(`[Plurtasko] Cache hit for "${name}" S${season || '?'}E${episode || '?'} (${cached.length} streams)`)
          return cached
        }

        // Extraer TMDB ID y fetch IMDb ID para validación estricta cuando el canal lo permita.
        // El fetch va en paralelo con las búsquedas de canales: solo se necesita
        // para validateById después, así no añade un round-trip extra al arranque.
        const tmdbId = extractTmdbId(id)
        const isMovie = type === CONTENT_TYPES.MOVIE
        const imdbIdPromise = tmdbId ? fetchImdbId(tmdbId, isMovie) : Promise.resolve(null)
        let imdbId = null

        // Detectar anime/dorama por géneros de TMDB + país/idioma de origen.
        // TMDB genre 16 = Animación (anime), genre 10765 = Sci-Fi & Fantasy (anime often).
        // Para dorama: TMDB no tiene género "dorama" — se detecta por país de
        // origen (JP/KR/CN/TH) + género Drama, excluyendo Animación (que es anime).
        const genreStr = Array.isArray(genres) ? genres.join(' ').toLowerCase() : ''
        const isAnime = /anime|animación|animation|animacion/.test(genreStr)
        // País de origen: JP=Japón, KR=Corea, CN=China, TH=Tailandia, TW=Taiwán
        const originStr = Array.isArray(originCountry) ? originCountry.join(' ').toUpperCase() : (originCountry || '').toUpperCase()
        const isAsianOrigin = /JP|KR|CN|TH|TW|HK/.test(originStr)
        const isJapaneseLang = originalLanguage === 'ja' || originalLanguage === 'japanese'
        // Dorama: serie asiática (JP/KR/CN) de género Drama, que NO sea anime
        const isDorama = !isAnime && isAsianOrigin && /drama/.test(genreStr)
        // Anime también se detecta por idioma japonés + animación
        const isAnimeByOrigin = isJapaneseLang && /animación|animation|animacion/.test(genreStr)

        // Determinar el tipo efectivo de búsqueda
        let effectiveType = type
        if (isAnime || isAnimeByOrigin) effectiveType = CONTENT_TYPES.ANIME
        else if (isDorama) effectiveType = CONTENT_TYPES.DORAMA

        console.log(`[Plurtasko] Searching "${name}" type=${type} genres=[${genres?.join(',') || ''}] origin=[${originStr || ''}] lang=${originalLanguage || ''} → effectiveType=${effectiveType}`)

        // Filtrar canales según el tipo detectado:
        // - Anime: solo canales que soportan ANIME
        // - Dorama: canales que soportan DORAMA o SERIES (dorama es serie)
        // - Movie/Series: canales que soportan el tipo exacto (sin canales de anime)
        let candidates
        if (effectiveType === CONTENT_TYPES.ANIME) {
          // Anime: priorizar canales específicos y usar también portales de
          // series/películas como respaldo. Muchos catálogos no declaran
          // ANIME aunque sí publican anime en sus resultados.
          const animeChannels = activeChannels().filter(ch => ch.types.includes(CONTENT_TYPES.ANIME))
          const fallbackChannels = activeChannels().filter(ch =>
            !ch.types.includes(CONTENT_TYPES.ANIME) &&
            (ch.types.includes(CONTENT_TYPES.SERIES) || ch.types.includes(CONTENT_TYPES.MOVIE))
          )
          candidates = [...animeChannels, ...fallbackChannels]
          console.log(`[Plurtasko] Anime search → ${animeChannels.length} anime channels + ${fallbackChannels.length} fallback channels`)
        } else if (effectiveType === CONTENT_TYPES.DORAMA) {
          // Dorama: buscar en canales de series (los dorama son series)
          candidates = activeChannels().filter(ch =>
            ch.types.includes(CONTENT_TYPES.SERIES) && !ch.types.includes(CONTENT_TYPES.ANIME)
          )
          console.log(`[Plurtasko] Dorama search → ${candidates.length} series channels`)
        } else {
          // Movie o Series normal: excluir canales que soportan anime
          candidates = activeChannels().filter(ch =>
            ch.types.includes(type) && !ch.types.includes(CONTENT_TYPES.ANIME)
          )
          console.log(`[Plurtasko] ${type} search → ${candidates.length} channels (anime excluded)`)
        }

        // HDFull primero cuando hay credenciales: sus streams se ordenan delante
        // del resto (el usuario pagó/configuró esa fuente a propósito).
        const hdfullFirst = hasHdfullCredentials()
        if (hdfullFirst) {
          const hd = candidates.findIndex(c => c.id === 'hdfull')
          if (hd > 0) candidates.unshift(candidates.splice(hd, 1)[0])
        }
        const sortHdfull = (list) => hdfullFirst
          ? [...list].sort((a, b) => (b._channelId === 'hdfull') - (a._channelId === 'hdfull'))
          : list

        // Título normalizado para fallback (sin artículos como "The", "El", etc.)
        const strippedName = name.replace(/^(The|El|La|Los|Las|Un|Una|A|An)\s+/i, '')

        // Buscar en todos los canales en paralelo y emitir streams progresivamente
        let allStreams = []
        const channelPromises = candidates.map(async ch => {
          try {
            // Intentar búsqueda con el nombre localizado
            let items = await ch.search({ query: name, type, originalName })

            // Si no hay resultados y el nombre empieza con artículo,
            // reintentar sin el artículo (ej: "The Matrix" -> "Matrix")
            if ((!items || items.length === 0) && strippedName !== name) {
              items = await ch.search({ query: strippedName, type, originalName })
            }

            // Si todavía no hay resultados y tenemos el título original,
            // reintentar con el título original (ej: "Cadena perpetua" -> "The Shawshank Redemption")
            if ((!items || items.length === 0) && originalName && originalName !== name) {
              console.log(`[Plurtasko] Channel ${ch.id}: no results for "${name}", retrying with original "${originalName}"`)
              items = await ch.search({ query: originalName, type, originalName: name })
            }

            // Si todavía no hay resultados y tenemos el título en inglés,
            // reintentar con el título en inglés (ej: "Perros de caza" -> "Bloodhounds")
            // Muchos providers de dorama/anime indexan por el título en inglés.
            if ((!items || items.length === 0) && englishName && englishName !== name && englishName !== originalName) {
              console.log(`[Plurtasko] Channel ${ch.id}: no results for "${name}", retrying with english "${englishName}"`)
              items = await ch.search({ query: englishName, type, originalName: name })
            }

            if (!items || items.length === 0) return

            // Buscar el mejor match:
            // 1. Validación por TMDB/IMDb ID (si el canal lo permite) — estricto
            // 2. Coincidencia exacta de título (normalizada)
            // 3. Coincidencia por contenido (una contiene la otra)
            // 4. Fallback: usar el primer resultado si la búsqueda fue específica
            let match = null

            // Intentar validación por ID para cada resultado.
            // imdbId solo existe si hay tmdbId, así que basta chequear tmdbId.
            if (!match && tmdbId) {
              if (imdbId === null) imdbId = await imdbIdPromise
              for (const it of items) {
                const idCheck = validateById(ch, it.url, tmdbId, imdbId)
                if (idCheck === true) {
                  console.log(`[Plurtasko] Channel ${ch.id}: ID match for "${it.name}" (validated by TMDB/IMDb ID)`)
                  match = it
                  break
                }
                if (idCheck === false) {
                  console.log(`[Plurtasko] Channel ${ch.id}: ID mismatch for "${it.name}" (rejected by TMDB/IMDb ID)`)
                }
              }
            }

            // Fallback a title matching si no hay validación por ID
            if (!match) {
              const titleMatches = items.filter(it =>
                isTitleMatch(it.name, name) || isTitleMatch(it.title, name) ||
                (originalName && (isTitleMatch(it.name, originalName) || isTitleMatch(it.title, originalName))) ||
                (englishName && (isTitleMatch(it.name, englishName) || isTitleMatch(it.title, englishName)))
              )
              match = titleMatches[0]
              // Series por temporada (DonTorrent: una página por temporada):
              // si se pidió una temporada concreta, preferir el resultado que
              // la lleva en el título ("Reacher - 2ª Temporada").
              if (season != null && titleMatches.length > 1) {
                const withSeason = titleMatches.filter(it => it.season != null)
                if (withSeason.length > 0) {
                  match = withSeason.find(it => it.season === season) || match
                }
              }
              if (match) {
                console.log(`[Plurtasko] Channel ${ch.id}: title match found "${match.name}" for "${name}"${originalName ? ` (orig: "${originalName}")` : ''}${englishName ? ` (en: "${englishName}")` : ''}`)
              }
            }

            // Fallback a matching por slug exacto (ej: "Lost" → /serie/lost "Perdidos")
            if (!match) {
              const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim()
              const querySlug = normalize(name)
              const origSlug = normalize(originalName)
              const enSlug = normalize(englishName)
              match = items.find(it => {
                const slug = normalize((it.url || '').split('/').pop())
                return slug === querySlug || slug === origSlug || slug === enSlug
              })
              if (match) {
                console.log(`[Plurtasko] Channel ${ch.id}: slug match found "${match.name}" for "${name}"`)
              }
            }

            // If no exact match, only accept first result if title is similar
            // (at least 3 chars of the query appear in the result name, or vice versa)
            if (!match && items.length > 0) {
              const first = items[0]
              const firstName = (first.name || first.title || '').toLowerCase()
              const queryLower = name.toLowerCase()
              const origLower = (originalName || '').toLowerCase()
              const enLower = (englishName || '').toLowerCase()
              // Check if titles share a significant word (3+ chars).
              // Exact word equality only — substring inclusion caused false
              // positives ("reacher" is a substring of "preacher").
              const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 3)
              const nameWords = firstName.split(/\s+/).filter(w => w.length >= 3)
              const hasCommonWord = queryWords.some(w => nameWords.some(nw => nw === w))
              // Also check against original name
              const origWords = origLower.split(/\s+/).filter(w => w.length >= 3)
              const hasCommonWordOrig = origWords.some(w => nameWords.some(nw => nw === w))
              // Also check against english name
              const enWords = enLower.split(/\s+/).filter(w => w.length >= 3)
              const hasCommonWordEn = enWords.some(w => nameWords.some(nw => nw === w))
              if (hasCommonWord || hasCommonWordOrig || hasCommonWordEn) {
                match = first
              } else if (items.length === 1) {
                // Single result from a specific search - likely the right movie
                // with a different regional title (e.g. "Cadena perpetua" vs "Sueño de fuga")
                console.log(`[Plurtasko] Channel ${ch.id}: accepting single result "${first.name}" for "${name}" (regional title mismatch)`)
                match = first
              } else {
                console.log(`[Plurtasko] Channel ${ch.id}: rejecting first result "${first.name}" for "${name}" (no title match)`)
              }
            }

            if (!match || !match.url) return

            // Para series: si se pasa season/episode, obtener los episodios del canal
            // y buscar el episodio concreto
            let rawStreams = null
            if (type === CONTENT_TYPES.SERIES && season != null && ch._getEpisodes) {
              try {
                const episodes = await ch._getEpisodes(match.url)
                if (episodes && episodes.length > 0) {
                  // Buscar el episodio concreto por season/episode
                  let ep = episodes.find(e =>
                    e.season === season && e.episode === episode
                  )

                  // Anime/dorama: los providers suelen listar todos los episodios
                  // como S1E1..S1E366, pero TMDB los divide en múltiples temporadas.
                  // Si no hay match exacto, calcular el episodio absoluto sumando
                  // los episodios de las temporadas anteriores de TMDB.
                  if (!ep && seasonsList && season > 1) {
                    let absEp = episode || 1
                    for (const s of seasonsList) {
                      if (s.seasonNumber < season) {
                        absEp += (s.episodeCount || 0)
                      }
                    }
                    console.log(`[Plurtasko] Channel ${ch.id}: no S${season}E${episode}, trying absolute ep ${absEp}`)
                    ep = episodes.find(e => e.episode === absEp) ||
                         episodes.find(e => e.episode === absEp - 1) // off-by-one tolerance
                  }

                  // Si todavía no hay match y el provider solo tiene S1,
                  // intentar por número de episodio directo (sin temporada)
                  if (!ep && season > 1 && episodes.every(e => e.season === 1)) {
                    console.log(`[Plurtasko] Channel ${ch.id}: provider only has S1, trying episode ${episode}`)
                    ep = episodes.find(e => e.episode === episode)
                  }

                  if (ep) {
                    rawStreams = await ch.getStreams({ type, id: ep.id, debridEnabled })
                    console.log(`[Plurtasko] Channel ${ch.id}: ${rawStreams?.length || 0} streams for "${name}" S${season}E${episode}`)
                  } else {
                    console.log(`[Plurtasko] Channel ${ch.id}: episode S${season}E${episode} not found (${episodes.length} episodes available), trying direct URL`)
                    // Fall through to direct URL construction below
                  }
                }
              } catch (e) {
                console.warn(`[Plurtasko] Channel ${ch.id}: failed to get episodes:`, e?.message)
              }
            }

            // Obtener streams del item encontrado si no se obtuvieron ya via episodios.
            // Las páginas de serie de muchos proveedores solo contienen el listado
            // de capítulos, no los reproductores. Si no se indicó un capítulo y la
            // página devuelve 0, usar el primer episodio disponible para exponer
            // fuentes desde todas las webs (no solo AnimeFlvOne).
            if (!rawStreams) {
              rawStreams = await ch.getStreams({ type, id: match.id, season, episode, debridEnabled })
            }
            if ((!rawStreams || rawStreams.length === 0) &&
                (type === CONTENT_TYPES.SERIES || type === CONTENT_TYPES.MOVIE) &&
                // Si el match declara otra temporada (páginas por temporada,
                // ej. DonTorrent), no caer al fallback de episodios: cogería
                // un capítulo de la temporada equivocada.
                !(type === CONTENT_TYPES.SERIES && match.season != null && season != null && match.season !== season)) {
              try {
                // getMeta loads the series/anime HTML and lets each channel
                // parse its own episode format. For movies, many anime sites
                // store the player on the episode page, not the anime page.
                const meta = ch.getMeta ? await ch.getMeta({ id: match.id, type }) : null
                const episodes = meta?.episodes || []
                // Si se especificó season/episode, buscar el episodio correcto
                // (con mapeo absoluto para anime). Si no, usar el primero.
                let targetEpisode = episodes[0]
                if (season != null && episodes.length > 0) {
                  let ep = episodes.find(e => e.season === season && e.episode === episode)
                  if (!ep && seasonsList && season > 1) {
                    let absEp = episode || 1
                    for (const s of seasonsList) {
                      if (s.seasonNumber < season) absEp += (s.episodeCount || 0)
                    }
                    ep = episodes.find(e => e.episode === absEp) ||
                         episodes.find(e => e.episode === absEp - 1)
                  }
                  if (!ep && season > 1 && episodes.every(e => e.season === 1)) {
                    ep = episodes.find(e => e.episode === episode)
                  }
                  if (ep) targetEpisode = ep
                }
                if (targetEpisode?.id) {
                  rawStreams = await ch.getStreams({ type, id: targetEpisode.id, debridEnabled })
                  console.log(`[Plurtasko] Channel ${ch.id}: ${rawStreams?.length || 0} streams from episode ${targetEpisode.episode}`)
                }
              } catch (e) {
                console.warn(`[Plurtasko] Channel ${ch.id}: episode fallback failed:`, e?.message)
              }
            }
            console.log(`[Plurtasko] Channel ${ch.id}: ${rawStreams?.length || 0} streams for "${name}"${season ? ` S${season}E${episode || ''}` : ''}`)

            if (!rawStreams || rawStreams.length === 0) return

            // Etiquetar cada stream con el id del canal de origen (interno, no visible)
            const tagStream = (s) => {
              return { ...s, _channelId: ch.id }
            }

            // Resolver y emitir los streams de este canal inmediatamente
            const channelOnBatch = onBatch ? (batch) => {
              // Acumular streams de todos los canales y emitir el conjunto completo
              allStreams = allStreams.filter(s => s._channelId !== ch.id)
              allStreams = allStreams.concat(batch.map(tagStream))
              allStreams = dedupeTorrentStreams(allStreams)
              onBatch(sortHdfull(allStreams))
            } : null
            const resolved = await resolveStreams(rawStreams, channelOnBatch, { season, episode })
            if (resolved && resolved.length > 0) {
              allStreams = allStreams.filter(s => s._channelId !== ch.id)
              allStreams = allStreams.concat(resolved.map(tagStream))
              allStreams = dedupeTorrentStreams(allStreams)
              if (onBatch) onBatch(sortHdfull(allStreams))
            }
          } catch (e) {
            logWarn(`[Plurtasko] Channel ${ch.id} failed:`, String(e?.message || e))
          }
        })

        await Promise.all(channelPromises)

        // Limpiar el marcador interno _channelId antes de devolver
        allStreams = sortHdfull(dedupeTorrentStreams(allStreams))
        allStreams = allStreams.map(s => {
          const { _channelId, ...rest } = s
          return rest
        })
        console.log(`[Plurtasko] Total resolved streams for "${name}": ${allStreams.length}`)
        // No cachear resultados vacíos: un fallo temporal (WARP no listo,
        // timeout, red lenta) no debe bloquear búsquedas posteriores 5 min.
        if (allStreams.length > 0) setCachedSearch(cacheKey, allStreams)
        return allStreams
      } catch (e) {
        logWarn(`[Plurtasko] getStreams failed for ${id} (${name})`, String(e?.message || e))
        return []
      }
    },

    async search({ query, type, signal, genres }) {
      try {
        // Detectar anime/dorama por géneros.
        // Nota: search() no recibe originCountry (viene de la UI de búsqueda,
        // no de Details), así que solo podemos usar géneros aquí.
        const genreStr = Array.isArray(genres) ? genres.join(' ').toLowerCase() : ''
        const isAnime = /anime|animación|animation|animacion/.test(genreStr)
        // Dorama por género: TMDB no tiene género "dorama", pero si el usuario
        // busca desde una categoría de dorama, los géneros incluirán "Drama"
        // y la UI puede pasar "dorama" como género extra.
        const isDorama = /dorama|korean|corean|japanese|japon|chinese|chin|asiatic|asian/.test(genreStr)

        let channelFilter
        if (isAnime) {
          // Buscar solo en canales de anime
          channelFilter = ch => ch.types.includes(CONTENT_TYPES.ANIME)
        } else if (isDorama) {
          // Dorama: buscar en series (no anime)
          channelFilter = ch =>
            ch.types.includes(CONTENT_TYPES.SERIES) && !ch.types.includes(CONTENT_TYPES.ANIME)
        } else if (type) {
          // Tipo específico: excluir canales que soportan anime
          channelFilter = ch =>
            ch.types.includes(type) && !ch.types.includes(CONTENT_TYPES.ANIME)
        } else {
          // Sin tipo ni géneros (búsqueda manual): incluir TODOS los canales.
          // Así al buscar "bleach" aparecen jkanime, animeav1, etc.
          // Los canales de anime devuelven [] si no encuentran el título.
          channelFilter = ch => true
        }
        // Timeout por canal: una fuente lenta no debe retrasar al resto.
        // Cuando no hay type (búsqueda manual), pasamos undefined para que los
        // canales devuelvan tanto series como películas (importante para anime).
        // 20s para dar tiempo a fallbacks (WARP → proxies → jina) en sitios
        // bloqueados por Cloudflare.
        const results = await Promise.all(
          activeChannels().filter(channelFilter)
            .map(ch => withCancelTimeout(
              sig => ch.search({ query, type: type || undefined, signal: sig }),
              20000, signal,
              `channel search timeout`
            ).catch(() => []))
        )
        return results.flat()
      } catch (e) {
        logWarn(`[Plurtasko] search failed for "${query}"`, String(e?.message || e))
        return []
      }
    },
  })
}
