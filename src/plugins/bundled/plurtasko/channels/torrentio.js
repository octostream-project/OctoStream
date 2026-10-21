// Torrentio channel — agregador de torrents por IMDb ID
// (torrentio.strem.fun). No busca por nombre ni tiene catálogo: se invoca
// desde index.js cuando el item trae IMDb ID (vía TMDB). Configurado con los
// providers en español del addon: MejorTorrent, Wolfmax4k y Cinecalidad
// (los mismos que aparecen en /configure marcados con 🇪🇸/🇲🇽).
//
// Formato de respuesta:
//   name:  "Torrentio\n{calidad}"
//   title: "{nombre release}\n[{archivo}\n]👤 {seeds} 💾 {size} ⚙️ {Provider}\n{flags}"
//   infoHash / fileIdx

import { CONTENT_TYPES } from '../../../base.js'
import { safeFetchJson, withTimeout } from '../../../utils.js'
import { makeTorrentStream } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'
import { withDefaultTrackers } from '../../../../utils/torrentFile.js'

const BASE = 'https://torrentio.strem.fun'
// Config de /configure: providers españoles + prioridad a audio castellano
// (language=spanish) y exclusión de calidades por encima de 1080p (4k/2160p).
const PROVIDERS = 'mejortorrent,wolfmax4k,cinecalidad'
const CONFIG = `providers=${PROVIDERS}|language=spanish|qualityfilter=4k`

export const torrentio = {
  id: 'torrentio',
  name: 'Torrentio ES',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: BASE,

  // Sin catálogo ni búsqueda por nombre: la API solo responde por IMDb ID.
  async getStreamsByImdb({ imdbId, type, season, episode, signal }) {
    if (!imdbId) return []
    const isSeries = type !== CONTENT_TYPES.MOVIE
    const id = isSeries ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId
    const url = `${BASE}/${CONFIG}/stream/${isSeries ? 'series' : 'movie'}/${id}.json`
    const data = await withTimeout(
      safeFetchJson(url, {}, signal),
      12000,
      'torrentio timeout'
    )
    const list = Array.isArray(data?.streams) ? data.streams : []
    return list.map(s => toStream(s)).filter(Boolean)
  },
}

function toStream(s) {
  const hash = (s.infoHash || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hash)) return null
  const title = String(s.title || '')
  const lines = title.split('\n').map(l => l.trim()).filter(Boolean)
  const release = lines[0] || s.name || hash
  // "⚙️ Wolfmax4k" — proveedor real dentro de Torrentio.
  const provider = (title.match(/⚙️\s*([^\n]+)/) || [])[1]?.trim() || 'Torrentio'
  const seeds = (title.match(/👤\s*(\d+)/) || [])[1] || ''
  const size = (title.match(/💾\s*([\d.,]+\s*(?:KB|MB|GB|TB))/i) || [])[1] || ''
  const quality = extractQualityFromText(title) || extractQualityFromText(s.name || '') || 'HD'
  const lang = detectLangFromText(title) || 'Esp'
  const magnet = withDefaultTrackers(
    `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(release)}`
  )
  const stream = makeTorrentStream(provider, magnet, quality, release)
  stream.lang = lang
  stream.name = `${provider} (${lang}) ${quality}${seeds ? ` 👤${seeds}` : ''}${size ? ` ${size}` : ''}`
  stream.seeds = Number(seeds) || 0
  stream.fileIdx = Number.isInteger(s.fileIdx) ? s.fileIdx : undefined
  stream.pluginName = 'Torrentio'
  return stream
}
