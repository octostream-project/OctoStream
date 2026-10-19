// TorBox Search — índice Orion dentro de la API de búsqueda de TorBox
// (search-api.torbox.app, misma Bearer key). Devuelve torrents y NZBs de
// usenet por IMDb/TMDB ID con flag `cached` (ya listo en TorBox). No busca
// por nombre ni tiene catálogo: se invoca desde index.js en paralelo a
// Torrentio cuando hay key de TorBox y el ajuste está activo.
//
// Los torrents salen como magnets (van por debridResolveMagnet → TorBox);
// los NZBs salen con streamType 'usenet' y los resuelve resolveUsenet en
// index.js. `cached:true` se etiqueta "(⚡)" — descarga instantánea.

import { CONTENT_TYPES } from '../../../base.js'
import { makeTorrentStream } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'
import { withDefaultTrackers } from '../../../../utils/torrentFile.js'
import { isTorboxSearchEnabled, torboxSearch } from '../../torbox.js'

export const torboxsearch = {
  id: 'torboxsearch',
  name: 'TorBox Search',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: 'https://torbox.app',

  async getStreamsById({ imdbId, tmdbId, type, season, episode }) {
    if (!isTorboxSearchEnabled()) return []
    if (!imdbId && !tmdbId) return []
    const isSeries = type !== CONTENT_TYPES.MOVIE
    const data = await torboxSearch({
      imdbId,
      tmdbId,
      season: isSeries ? season : undefined,
      episode: isSeries ? episode : undefined,
    })
    if (!data) return []
    return [
      ...(data.torrents || []).map(t => torrentToStream(t)).filter(Boolean),
      ...(data.nzbs || []).map(n => nzbToStream(n)).filter(Boolean),
    ]
  },
}

function fmtSize(bytes) {
  const n = Number(bytes)
  if (!n || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0; let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function torrentToStream(t) {
  const hash = String(t?.hash || '').toLowerCase()
  const magnet = t?.magnet
    || (/^[0-9a-f]{40}$/.test(hash) ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.raw_title || t.title || '')}` : null)
  if (!magnet) return null
  const title = String(t.raw_title || t.title || hash)
  const parsed = t.title_parsed_data || {}
  const quality = extractQualityFromText(title)
    || (parsed.resolution ? String(parsed.resolution).toUpperCase() : '')
    || 'HD'
  const lang = detectLangFromText(`${title} ${parsed.audio || ''}`)
  const seeds = Number(t.last_known_seeders) || 0
  const size = fmtSize(t.size)
  const stream = makeTorrentStream('TorBox', withDefaultTrackers(magnet), quality, title)
  stream.lang = lang
  stream.server = 'TorBox'
  stream.pluginName = 'TorBox Search'
  stream.name = `TorBox${lang ? ` (${lang})` : ''} ${quality}${t.cached ? ' ⚡' : ''}${seeds ? ` 👤${seeds}` : ''}${size ? ` ${size}` : ''}`
  if (seeds) stream.seeds = seeds
  return stream
}

function nzbToStream(n) {
  const link = n?.nzb || n?.link
  if (!link || !/^https?:/i.test(String(link))) return null
  const title = String(n.raw_title || n.title || 'usenet')
  const parsed = n.title_parsed_data || {}
  const quality = extractQualityFromText(title)
    || (parsed.resolution ? String(parsed.resolution).toUpperCase() : '')
    || 'HD'
  const lang = detectLangFromText(`${title} ${parsed.audio || ''}`)
  const size = fmtSize(n.size)
  return {
    name: `TorBox Usenet${lang ? ` (${lang})` : ''} ${quality}${n.cached ? ' ⚡' : ''}${size ? ` ${size}` : ''}`,
    url: String(link),
    streamType: 'usenet',
    quality,
    server: 'TorBox Usenet',
    lang,
    title,
    pluginName: 'TorBox Search',
    pluginId: 'plurtasko',
  }
}
