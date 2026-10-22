// AIOStreams channel — agregador de fuentes por IMDb ID (misma API que usa
// el addon POV de Kodi): GET {instance}/api/v1/search?type=movie&id=tt… o
// type=series&id=tt…:s:e con HTTP Basic auth (uuid:password). La instancia
// agrega los providers/debrid que el usuario configuró en /configure —
// ahí se activan las webs en español (Torrentio ES, MediaFusion, etc.).
//
//   type:    'p2p'      → torrent por infoHash (reproduce el motor local)
//            'debrid'   → URL desbloqueada por el debrid de la instancia
//            'http'     → descarga directa (+requestHeaders si vienen)
//            'usenet'   → no soportado, se omite
//   data.results[]: { url, requestHeaders, infoHash, parsedFile{resolution,
//     quality, languages[], seasonPack}, addon, indexer, service, seeders,
//     size(bytes), filename, folderName, cached }

import { CONTENT_TYPES } from '../../../base.js'
import { safeFetchJson, withTimeout } from '../../../utils.js'
import { makeTorrentStream } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'
import { withDefaultTrackers } from '../../../../utils/torrentFile.js'
import { inferStreamType } from '../../../../utils/streamType.js'
import { getItemSync } from '../../../../utils/storage.js'

const DEFAULT_INSTANCE = 'https://aiostreams.elfhosted.com'
const TIMEOUT_MS = 25000 // POV usa 30s; la instancia puede tardar tanto

export const AIO_KEYS = {
  instance: 'octostream_aiostreams_instance',
  uuid: 'octostream_aiostreams_uuid',
  password: 'octostream_aiostreams_password',
}

export function aiostreamsConfig() {
  const instance = (getItemSync(AIO_KEYS.instance) || DEFAULT_INSTANCE).trim().replace(/\/+$/, '')
  const uuid = (getItemSync(AIO_KEYS.uuid) || '').trim()
  const password = getItemSync(AIO_KEYS.password) || ''
  return { instance, uuid, password, enabled: Boolean(uuid && password) }
}

export const aiostreams = {
  id: 'aiostreams',
  name: 'AIOStreams',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: DEFAULT_INSTANCE,

  // Sin catálogo ni búsqueda por nombre: la API solo responde por IMDb ID.
  async getStreamsByImdb({ imdbId, type, season, episode, signal }) {
    const cfg = aiostreamsConfig()
    if (!imdbId || !cfg.enabled) return []
    const isSeries = type !== CONTENT_TYPES.MOVIE
    const id = isSeries ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId
    const url = `${cfg.instance}/api/v1/search?type=${isSeries ? 'series' : 'movie'}&id=${encodeURIComponent(id)}&requiredFields=parsedFile`
    const headers = { Authorization: `Basic ${btoa(`${cfg.uuid}:${cfg.password}`)}` }
    const data = await withTimeout(
      safeFetchJson(url, headers, signal),
      TIMEOUT_MS,
      'aiostreams timeout'
    )
    const list = Array.isArray(data?.data?.results) ? data.data.results : []
    return list.map(toStream).filter(Boolean)
  },
}

function toStream(item) {
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
    pluginId: 'plurtasko',
  }
}
