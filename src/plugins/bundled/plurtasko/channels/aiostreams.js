// AIOStreams channel — agregador de fuentes por IMDb ID.
//
// Dos modos soportados:
//
// A) URL de manifest (RECOMENDADO — funciona en instancias públicas como
//    aiostreams.elfhosted.com, sin contraseña). Es la URL que da el botón
//    "Copy manifest URL" de /stremio/configure:
//      {instancia}/stremio/<uuid>/<config>/manifest.json
//    Los streams van por el protocolo Stremio estándar:
//      GET {…}/stream/<movie|series>/<imdb[:s:e]>.json → {streams:[…]}
//
// B) Search API (misma que usa el addon POV de Kodi — solo instancias
//    self-hosted que la tengan activada; elfhosted la tiene desactivada):
//      GET {instancia}/api/v1/search?type=…&id=…  Basic auth uuid:password
//      data.results[]: {url, infoHash, parsedFile{…}, addon, seeders, size}
//
// Respuesta Stremio streams[]: {name, title|description, url, infoHash,
// fileIdx, sources[tracker:…], behaviorHints{proxyHeaders{request|response}}}

import { CONTENT_TYPES } from '../../../base.js'
import { safeFetchJson, withTimeout } from '../../../utils.js'
import { makeTorrentStream } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'
import { withDefaultTrackers } from '../../../../utils/torrentFile.js'
import { inferStreamType } from '../../../../utils/streamType.js'
import { getItemSync } from '../../../../utils/storage.js'

const DEFAULT_INSTANCE = 'https://aiostreams.elfhosted.com'
const TIMEOUT_MS = 25000

export const AIO_KEYS = {
  instance: 'octostream_aiostreams_instance',
  uuid: 'octostream_aiostreams_uuid',
  password: 'octostream_aiostreams_password',
  manifest: 'octostream_aiostreams_manifest',
}

// Acepta la URL de manifest completa (…/manifest.json) o la base
// (…/stremio/<uuid>/<config>) y devuelve la base de streams.
export function manifestStreamBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  const base = u.replace(/\/manifest\.json(\?.*)?$/i, '')
  return /\/stremio\//i.test(base) ? base : ''
}

export function aiostreamsConfig() {
  const instance = (getItemSync(AIO_KEYS.instance) || DEFAULT_INSTANCE).trim().replace(/\/+$/, '')
  const uuid = (getItemSync(AIO_KEYS.uuid) || '').trim()
  const password = getItemSync(AIO_KEYS.password) || ''
  const manifest = manifestStreamBase(getItemSync(AIO_KEYS.manifest))
  // El manifest tiene prioridad: no exige auth y funciona en instancias
  // públicas. La Search API queda como fallback para self-hosted.
  return { instance, uuid, password, manifest, enabled: Boolean(manifest || (uuid && password)) }
}

// Comprobador de conexión para Ajustes → Debrid → AIOStreams.
// Con manifest: GET …/stream/movie/tt0137523.json y cuenta streams.
// Con uuid+password: GET /api/v1/search (Fight Club, siempre indexada).
export async function testAiostreamsConnection({ instance, uuid, password, manifest } = {}) {
  const cfg = aiostreamsConfig()
  const man = manifestStreamBase(manifest ?? getItemSync(AIO_KEYS.manifest))
  const inst = ((instance ?? cfg.instance) || DEFAULT_INSTANCE).trim().replace(/\/+$/, '')
  const u = (uuid ?? cfg.uuid).trim()
  const p = password ?? cfg.password
  const { httpGetText } = await import('../../../../utils/httpClient.js')

  if (man) {
    try {
      const text = await withTimeout(
        httpGetText(`${man}/stream/movie/tt0137523.json`),
        TIMEOUT_MS,
        'aiostreams timeout'
      )
      let results = 0
      try { results = JSON.parse(text)?.streams?.length ?? 0 } catch { /* no-JSON */ }
      return { ok: true, results }
    } catch (e) {
      return { ok: false, error: diagError(e) }
    }
  }

  if (!/^https?:\/\//i.test(inst)) {
    return { ok: false, error: 'Instancia inválida: debe empezar por http(s)://' }
  }
  if (!u || !p) {
    return { ok: false, error: 'Falta la URL de manifest o el par UUID + contraseña' }
  }
  const url = `${inst}/api/v1/search?type=movie&id=tt0137523&requiredFields=parsedFile`
  try {
    const text = await withTimeout(
      httpGetText(url, { Authorization: `Basic ${btoa(`${u}:${p}`)}` }),
      TIMEOUT_MS,
      'aiostreams timeout'
    )
    let results = 0
    try {
      const json = JSON.parse(text)
      if (json?.success === false && /search api is disabled/i.test(String(json?.error))) {
        return { ok: false, error: 'La instancia tiene la Search API desactivada — usa la URL de manifest' }
      }
      results = json?.data?.results?.length ?? 0
    } catch { /* HTML/no-JSON */ }
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: diagError(e) }
  }
}

function diagError(e) {
  const msg = String(e?.message || e)
  if (/HTTP 401/.test(msg)) return 'UUID o contraseña incorrectos (401)'
  if (/HTTP 403/.test(msg)) return 'Acceso denegado (403) — la instancia puede tener la Search API desactivada'
  if (/HTTP 404/.test(msg)) return 'Endpoint no encontrado (404) — revisa la URL de manifest/instancia'
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'La instancia no responde (timeout)'
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME/i.test(msg)) return 'Dominio de la instancia no resuelve'
  return `No se pudo conectar: ${msg}`
}

export const aiostreams = {
  id: 'aiostreams',
  name: 'AIOStreams',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: DEFAULT_INSTANCE,

  // Sin catálogo ni búsqueda por nombre: solo responde por IMDb ID.
  async getStreamsByImdb({ imdbId, type, season, episode, signal }) {
    const cfg = aiostreamsConfig()
    if (!imdbId || !cfg.enabled) return []
    const isSeries = type !== CONTENT_TYPES.MOVIE
    const stremioType = isSeries ? 'series' : 'movie'
    const id = isSeries ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId

    if (cfg.manifest) {
      const data = await withTimeout(
        safeFetchJson(`${cfg.manifest}/stream/${stremioType}/${encodeURIComponent(id)}.json`, {}, signal),
        TIMEOUT_MS,
        'aiostreams timeout'
      )
      const list = Array.isArray(data?.streams) ? data.streams : []
      return list.map(stremioToStream).filter(Boolean)
    }

    const url = `${cfg.instance}/api/v1/search?type=${stremioType}&id=${encodeURIComponent(id)}&requiredFields=parsedFile`
    const headers = { Authorization: `Basic ${btoa(`${cfg.uuid}:${cfg.password}`)}` }
    const data = await withTimeout(
      safeFetchJson(url, headers, signal),
      TIMEOUT_MS,
      'aiostreams timeout'
    )
    const list = Array.isArray(data?.data?.results) ? data.data.results : []
    return list.map(searchToStream).filter(Boolean)
  },
}

// ── Respuesta protocolo Stremio ────────────────────────────────────────────
// streams[]: {name, title|description, url?, infoHash?, fileIdx?,
//             sources["tracker:…"|"dht:…"], behaviorHints{proxyHeaders}}
function stremioToStream(s) {
  const name = String(s.name || 'AIOStreams')
  const label = String(s.title || s.description || '').split('\n')[0].trim()
  const info = `${name} ${label}`
  const lang = detectLangFromText(info)
  const quality = extractQualityFromText(info) || 'HD'
  const headers = s.behaviorHints?.proxyHeaders?.request
    || s.behaviorHints?.proxyHeaders?.response
    || undefined

  const hash = (s.infoHash || '').toLowerCase()
  if (hash) {
    if (!/^[0-9a-f]{32,40}$/.test(hash)) return null
    let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(label || name)}`
    for (const src of s.sources || []) {
      const tr = String(src).replace(/^tracker:/, '')
      if (/^https?:|^udp:/.test(tr)) magnet += `&tr=${encodeURIComponent(tr)}`
    }
    if (s.fileIdx != null) magnet += `&so=${s.fileIdx}`
    const stream = makeTorrentStream(name, withDefaultTrackers(magnet), quality, label)
    stream.name = `${name}${lang ? ` (${lang})` : ''} ${quality}`
    stream.lang = lang
    stream.title = label
    stream.headers = headers
    stream.pluginName = 'AIOStreams'
    stream.channelName = 'AIOStreams'
    return stream
  }

  const url = String(s.url || s.externalUrl || '')
  if (!/^https?:/i.test(url)) return null
  return {
    name: `${name}${lang ? ` (${lang})` : ''} ${quality}${label ? ` · ${label}` : ''}`,
    url,
    streamType: inferStreamType(url, 'mp4'),
    quality,
    server: name,
    lang,
    title: label,
    headers,
    cached: Boolean(s.behaviorHints?.cached) || undefined,
    pluginName: 'AIOStreams',
    channelName: 'AIOStreams',
    pluginId: 'plurtasko',
  }
}

// ── Respuesta Search API (self-hosted) ─────────────────────────────────────
function searchToStream(item) {
  const parsed = item.parsedFile || {}
  const release = item.filename || item.folderName || ''
  const service = (item.service || 'direct').toLowerCase()
  const addon = item.addon || item.indexer || 'AIOStreams'
  const label = service !== 'direct' ? `${service} · ${addon}` : addon
  const seeders = Number(item.seeders) || 0
  const bytes = Number(item.size) || 0
  const sizeLabel = bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)} GB`
    : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1048576))} MB` : ''
  const quality = extractQualityFromText(
    `${parsed.resolution || ''} ${parsed.quality || ''} ${release}`
  ) || 'HD'
  const lang = detectLangFromText(
    `${(parsed.languages || []).join(' ')} ${release}`
  )

  // P2P: OctoStream sí reproduce torrents locales (POV los descartaba porque
  // Kodi solo juega debrid) — magnet por infoHash con trackers por defecto.
  const hash = (item.infoHash || '').toLowerCase()
  if (item.type === 'p2p' || (!item.url && hash)) {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null
    const magnet = withDefaultTrackers(
      `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release || addon)}`
    )
    const stream = makeTorrentStream(label, magnet, quality, release)
    stream.name = `${label}${lang ? ` (${lang})` : ''} ${quality}${seeders ? ` 👤${seeders}` : ''}${sizeLabel ? ` ${sizeLabel}` : ''}`
    stream.lang = lang
    stream.seeds = seeders
    stream.seasonPack = Boolean(parsed.seasonPack) || undefined
    stream.pluginName = 'AIOStreams'
    stream.channelName = 'AIOStreams'
    return stream
  }

  // debrid/http: URL directa ya desbloqueada por la instancia.
  const url = String(item.url || '')
  if (!/^https?:/i.test(url)) return null
  return {
    name: `${label}${lang ? ` (${lang})` : ''} ${quality}${sizeLabel ? ` ${sizeLabel}` : ''}`,
    url,
    streamType: inferStreamType(url, 'mp4'),
    quality,
    server: label,
    lang,
    title: release,
    headers: item.type === 'http' && item.requestHeaders ? item.requestHeaders : undefined,
    viaDebrid: service !== 'direct',
    cached: Boolean(item.cached) || undefined,
    pluginName: 'AIOStreams',
    channelName: 'AIOStreams',
    pluginId: 'plurtasko',
  }
}
