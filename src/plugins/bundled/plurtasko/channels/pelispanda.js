// PelisPanda channel — torrents en Castellano. API REST propia
// (wp-json/wpreact/v1/*): sin scraping de tarjetas, downloads ya son
// magnets firmados con trackers. Portado de Balandro channels/pelispanda.py.
//
//   GET /wp-json/wpreact/v1/{movies|series|animes}?posts_per_page=N&page=P
//   GET /wp-json/wpreact/v1/search?query=<q>            → {results:[…]}
//   GET /wp-json/wpreact/v1/movie/<slug>                → {downloads:[…]}
//   GET /wp-json/wpreact/v1/serie/<slug>/related/       → {downloads,embeds}
//   GET /wp-json/wpreact/v1/anime/<slug>/related/       → idem
//
// downloads[]: {season,episode,quality,size,download_link(magnet),language}
// embeds[]   : {season,episode,url,quality,lang}  (Latino — se emiten igual)

import { CONTENT_TYPES } from '../../../base.js'
import { httpGetJson } from '../../../../utils/httpClient.js'
import { makeTorrentStream, normalizeServer, detectServerFromUrl } from '../scraper.js'
import { extractQualityFromText, detectLangFromText } from '../meta.js'

const HOST = 'https://pelispanda.org/'
const API = `${HOST}wp-json/wpreact/v1/`
const PER_PAGE = 24

const TYPE_MAP = {
  pelicula: CONTENT_TYPES.MOVIE,
  serie: CONTENT_TYPES.SERIES,
  anime: CONTENT_TYPES.ANIME,
}

const LANG_MAP = {
  'castellano': 'Esp',
  'español': 'Esp',
  'latino': 'Lat',
  'subtitulado': 'Vose',
  'vose': 'Vose',
  'latino/ingles': 'Lat',
  'castellano/ingles': 'Esp',
  'latino/japones': 'Vos',
  'version original': 'VO',
}

const apiUrl = (p) => `${API}${p}`
const fetchApi = (path, signal) => httpGetJson(apiUrl(path), {}, signal).catch(() => null)

// "Castellano/Ingles" → 'Esp' via LANG_MAP; fallback al detector genérico.
function mapLang(raw) {
  const l = String(raw || '').trim().toLowerCase().replace(/\\/g, '')
  if (!l) return ''
  if (LANG_MAP[l]) return LANG_MAP[l]
  for (const [k, v] of Object.entries(LANG_MAP)) if (l.includes(k.split('/')[0])) return v
  return detectLangFromText(raw) || ''
}

function itemFromResult(r, typeOverride) {
  const slug = r.slug
  if (!slug) return null
  const type = typeOverride || TYPE_MAP[r.type] || CONTENT_TYPES.MOVIE
  const id = type === CONTENT_TYPES.MOVIE
    ? `pelispanda:movie:${slug}`
    : `pelispanda:${r.type === 'anime' ? 'anime' : 'serie'}:${slug}`
  const title = String(r.title || '').trim()
  if (!title) return null
  return {
    id,
    type,
    name: title,
    title,
    poster: r.featured ? r.featured.replace(/\\\//g, '/') : null,
    backdrop: r.background_image ? r.background_image.replace(/\\\//g, '/') : null,
    year: r.year ? parseInt(r.year, 10) : null,
    url: `${HOST}${r.type === 'serie' || r.type === 'anime' ? 'serie' : 'pelicula'}/${slug}/`,
    pluginId: 'plurtasko',
  }
}

// Descarga → stream torrent (magnet directo del API).
function downloadToStream(d, fallbackSeasonEp) {
  const link = String(d.download_link || '').replace(/\\\//g, '/')
  if (!/^magnet:|^https?:.*\.torrent/i.test(link)) return null
  const quality = extractQualityFromText(d.quality || '') || 'HD'
  const stream = makeTorrentStream('PelisPanda', link, quality, '')
  const lang = mapLang(d.language)
  if (lang) { stream.lang = lang; stream.name = `PelisPanda (${lang}) ${quality}` }
  if (d.size) stream.name += ` ${d.size}`
  return stream
}

export const pelispanda = {
  id: 'pelispanda',
  name: 'PelisPanda',
  defaultLang: 'Esp',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME],
  host: HOST,

  catalogs: [
    { id: 'pelispanda-movies', name: 'PelisPanda: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'pelispanda-series', name: 'PelisPanda: Series', type: CONTENT_TYPES.SERIES },
    { id: 'pelispanda-animes', name: 'PelisPanda: Animes', type: CONTENT_TYPES.ANIME },
  ],

  async getCatalog({ id, skip = 0, top = 50, signal }) {
    const kind = id === 'pelispanda-series' ? 'series' : id === 'pelispanda-animes' ? 'animes' : 'movies'
    const page = Math.floor(skip / PER_PAGE) + 1
    const data = await fetchApi(`${kind}?posts_per_page=${PER_PAGE}&page=${page}`, signal)
    const list = data?.[kind] || data?.results || []
    const type = kind === 'movies' ? CONTENT_TYPES.MOVIE : kind === 'animes' ? CONTENT_TYPES.ANIME : CONTENT_TYPES.SERIES
    return list.map(r => itemFromResult(r, type)).filter(Boolean).slice(0, top)
  },

  async getMeta({ id, signal }) {
    const m = String(id).match(/^pelispanda:(movie|serie|anime):(.+)$/)
    if (!m) return null
    const [, kind, slug] = m
    // Serie/anime: /<kind>/<slug> trae la ficha (title/overview/poster) y
    // /<kind>/<slug>/related/ los downloads por episodio — dos llamadas.
    const [data, related] = kind === 'movie'
      ? [await fetchApi(`movie/${slug}`, signal)]
      : await Promise.all([
          fetchApi(`${kind}/${slug}`, signal),
          fetchApi(`${kind}/${slug}/related/`, signal),
        ])
    if (!data?.title) return null
    if (related?.downloads) data.downloads = related.downloads

    const meta = {
      id,
      type: kind === 'movie' ? CONTENT_TYPES.MOVIE : kind === 'anime' ? CONTENT_TYPES.ANIME : CONTENT_TYPES.SERIES,
      name: data.title,
      title: data.title,
      poster: data.featured ? data.featured.replace(/\\\//g, '/') : null,
      backdrop: data.background_image ? data.background_image.replace(/\\\//g, '/') : null,
      description: data.overview || '',
      year: data.year ? parseInt(data.year, 10) : null,
      url: `${HOST}${kind === 'movie' ? 'pelicula' : 'serie'}/${slug}/`,
      pluginId: 'plurtasko',
    }

    if (kind !== 'movie') {
      // Episodios únicos por (season, episode) — downloads repite el mismo
      // episodio por cada calidad disponible.
      const seen = new Set()
      meta.episodes = (data.downloads || [])
        .filter(d => d.season != null && d.episode != null)
        .filter(d => {
          const k = `${d.season}x${d.episode}`
          return seen.has(k) ? false : seen.add(k)
        })
        .map(d => ({
          id: `pelispanda:${kind}:${slug}`,
          name: `${data.title} ${d.season}x${String(d.episode).padStart(2, '0')}`,
          season: Number(d.season),
          episode: Number(d.episode),
          url: meta.url,
        }))
    }
    return meta
  },

  async getStreams({ id, season, episode, signal }) {
    const m = String(id).match(/^pelispanda:(movie|serie|anime):(.+)$/)
    if (!m) return []
    const [, kind, slug] = m
    const data = await fetchApi(kind === 'movie' ? `movie/${slug}` : `${kind}/${slug}/related/`, signal)
    if (!data) return []

    const streams = []
    for (const d of data.downloads || []) {
      if (kind !== 'movie') {
        if (season != null && Number(d.season) !== Number(season)) continue
        if (episode != null && Number(d.episode) !== Number(episode)) continue
      }
      const s = downloadToStream(d)
      if (s) streams.push(s)
    }
    // Embebidos latino/vose como respaldo a los magnets.
    for (const e of data.embeds || []) {
      if (kind !== 'movie') {
        if (season != null && Number(e.season) !== Number(season)) continue
        if (episode != null && Number(e.episode) !== Number(episode)) continue
      }
      const url = String(e.url || '').replace(/\\\//g, '/')
      if (!/^https?:/i.test(url)) continue
      const server = detectServerFromUrl(url)
      const lang = mapLang(e.lang)
      streams.push({
        name: `${server}${lang ? ` (${lang})` : ''} ${e.quality || ''}`.trim(),
        url,
        streamType: normalizeServer(server),
        quality: extractQualityFromText(e.quality || '') || 'HD',
        server,
        lang,
        pluginName: 'PelisPanda',
        pluginId: 'plurtasko',
      })
    }
    return streams
  },

  async search({ query, signal }) {
    const data = await fetchApi(`search?query=${encodeURIComponent(query)}`, signal)
    const list = data?.results || []
    return list.map(r => itemFromResult(r)).filter(Boolean)
  },
}
