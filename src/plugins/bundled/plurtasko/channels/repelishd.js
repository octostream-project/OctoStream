// RepelisHD channel — el sitio se trasladó a CineHDPlus (DLE,
// cinehdplus.work). Estructura verificada en vivo:
//   tarjetas : <div class="card"> … <a href="/peliculas/NNN-slug.html">
//              <img data-src="…" alt="Título"> + <img class="idioma" alt="Castellano|Latino|Subtitulado">
//   ficha    : var imdb = 'ttNNN';  player #movie_iframe | #serial_iframe
//   player   : playlatinsrc.co/movie|serial/<imdb> → token:"<b64>.<sig>"
//              POST /api/embed-links {type:'movie'|'tv', id, token} →
//              movie: sources[{name,url,version:latino|castellano|subtitulado}]
//              tv:    tv.seasons[].episodes[]{episode_number,title,sources[]}

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postJson, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer, detectServerFromUrl } from '../scraper.js'

const HOST = 'https://cinehdplus.work/'
const PLAYER = 'https://playlatinsrc.co'

const VERSION_LANG = { castellano: 'ESP', latino: 'LAT', subtitulado: 'VOSE' }

function parseCards(html, typeFilter) {
  const items = []
  // Cada ficha enlaza /peliculas/NNN-slug.html dos veces (portada y título);
  // la primera ocurrencia (card__cover) lleva el <img alt> con el nombre y el
  // data-src del póster. Las banderas de idioma (card__langs) van tras el
  // anchor — se capturan en la ventana posterior para informar la tarjeta.
  for (const m of findMultipleMatches(html, '<a href="([^"]*peliculas/[^"]+\\.html)"[^>]*>([\\s\\S]*?)</a>([\\s\\S]{0,900})')) {
    const itemUrl = absoluteUrl(m[1], HOST)
    const inner = m[2]
    const tail = m[3]
    const title = decodeEntities(
      findSingleMatch(inner, 'alt="([^"]+)"') || inner.replace(/<[^>]*>/g, '')).trim()
    if (!itemUrl || !title) continue
    const poster = findSingleMatch(inner, '(?:data-src|src)="([^"]+\\.(?:webp|jpe?g|png)[^"]*)"')
    const langs = findMultipleMatches(tail, 'idioma"[^>]*alt="([^"]+)"').map(x => VERSION_LANG[(x[1] || '').toLowerCase()]).filter(Boolean)
    items.push({
      id: `repelishd:${itemUrl}`,
      type: typeFilter || CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      url: itemUrl,
      cardLangs: [...new Set(langs)],
      pluginId: 'plurtasko',
    })
  }
  const seen = new Set()
  return items.filter(it => (seen.has(it.url) ? false : seen.add(it.url)))
}

function pageIds(html) {
  return {
    imdb: findSingleMatch(html, "imdb\\s*=\\s*'(tt\\d+)'"),
    isSerial: /id=["']serial_iframe["']/.test(html),
    isMovie: /id=["']movie_iframe["']/.test(html),
  }
}

async function playerApi(kind, imdb, signal) {
  const page = await fetchHtml(`${PLAYER}/${kind === 'tv' ? 'serial' : 'movie'}/${imdb}`, signal)
  const token = findSingleMatch(page, 'token:\\s*"([^"]+)"')
  if (!token) return null
  const data = await postJson(`${PLAYER}/api/embed-links`, { type: kind, id: imdb, token }, signal,
    { Referer: `${PLAYER}/${kind === 'tv' ? 'serial' : 'movie'}/${imdb}` })
  return data?.ok ? data : null
}

function sourcesToStreams(sources, lang, pluginName) {
  const streams = []
  const seen = new Set()
  for (const s of sources || []) {
    const url = String(s.url || '')
    if (!/^https?:/i.test(url) || seen.has(url)) continue
    seen.add(url)
    const sLang = VERSION_LANG[(s.version || lang || '').toLowerCase()] || ''
    const server = detectServerFromUrl(url) !== 'embed'
      ? detectServerFromUrl(url)
      : (s.name || 'embed').split('.')[0].toLowerCase()
    streams.push({
      name: `${server}${sLang ? ` (${sLang})` : ''}`,
      lang: sLang,
      url,
      streamType: normalizeServer(server),
      quality: '',
      server,
      pluginName,
      pluginId: 'plurtasko',
    })
  }
  return streams
}

export const repelishd = {
  id: 'repelishd',
  name: 'CineHDPlus',
  defaultLang: 'Esp',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'repelishd-movies', name: 'CineHDPlus: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'repelishd-series', name: 'CineHDPlus: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50, signal }) {
    const path = id === 'repelishd-movies' ? 'cine/' : id === 'repelishd-series' ? 'series/' : null
    if (!path) return []
    const page = Math.floor(skip / 24) + 1
    const html = await fetchHtml(`${HOST}${path}${page > 1 ? `page/${page}/` : ''}`, signal)
    const type = id === 'repelishd-series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
    return parseCards(html, type).slice(page > 1 ? 0 : skip % 24, (page > 1 ? 0 : skip % 24) + top)
  },

  async getMeta({ id, signal }) {
    const url = id.replace(/^repelishd:/, '').split('?')[0]
    const html = await fetchHtml(url, signal)
    if (!html) return null
    const { imdb, isSerial } = pageIds(html)
    const title = decodeEntities(
      findSingleMatch(html, '<meta[^>]*property="og:title"[^>]*content="([^"]+)"') ||
      findSingleMatch(html, '<h1[^>]*>([\\s\\S]*?)</h1>') ||
      findSingleMatch(html, '<title>([\\s\\S]*?)</title>')
    ).replace(/\s*\|.*$/, '').replace(/\s*[-–]\s*CineHDPlus.*$/i, '').trim()
    const poster = findSingleMatch(html, '<meta[^>]*property="og:image"[^>]*content="([^"]+)"') ||
      findSingleMatch(html, '<img[^>]*(?:data-src|src)="([^"]+)"[^>]*class="[^"]*poster')
    const description = decodeEntities(
      findSingleMatch(html, '<meta[^>]*name="description"[^>]*content="([^"]+)"') || '')
    const year = findSingleMatch(html, 'xfsearch/year/(\\d{4})') || findSingleMatch(html, '(\\d{4})')

    const meta = {
      id,
      type: isSerial ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      backdrop: null,
      description,
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (isSerial && imdb) {
      const data = await playerApi('tv', imdb, signal)
      const episodes = []
      for (const season of data?.tv?.seasons || []) {
        for (const ep of season.episodes || []) {
          if (!(ep.sources || []).length) continue
          episodes.push({
            id: `repelishd:${url}?se=${season.season_number}&ep=${ep.episode_number}`,
            name: ep.title || `Episodio ${ep.episode_number}`,
            season: season.season_number,
            episode: ep.episode_number,
            url: `${url}?se=${season.season_number}&ep=${ep.episode_number}`,
          })
        }
      }
      meta.episodes = episodes
      meta.lang = VERSION_LANG[(data?.tv?.version || '').toLowerCase()] || ''
    }
    return meta
  },

  async getStreams({ id, signal }) {
    const full = id.replace(/^repelishd:/, '')
    const se = parseInt((full.match(/[?&]se=(\d+)/) || [])[1] || '0', 10)
    const ep = parseInt((full.match(/[?&]ep=(\d+)/) || [])[1] || '0', 10)
    const url = full.split('?')[0]
    const html = await fetchHtml(url, signal)
    if (!html) return []
    const { imdb, isSerial } = pageIds(html)
    if (!imdb) return []

    if (isSerial) {
      const data = await playerApi('tv', imdb, signal)
      const season = (data?.tv?.seasons || []).find(s => s.season_number === se)
      const episode = (season?.episodes || []).find(e => e.episode_number === ep)
      return sourcesToStreams(episode?.sources, data?.tv?.version, 'CineHDPlus')
    }
    const data = await playerApi('movie', imdb, signal)
    return sourcesToStreams(data?.sources, '', 'CineHDPlus')
  },

  async search({ query, type, signal }) {
    const html = await fetchHtml(
      `${HOST}?story=${encodeURIComponent(query)}&do=search&subaction=search`, signal)
    // Las URLs /peliculas/ valen para ambos tipos — el tipo real lo fija
    // getMeta por el player de la ficha; aquí solo filtramos lo obvio.
    return parseCards(html, type === CONTENT_TYPES.SERIES ? CONTENT_TYPES.SERIES : null)
  },
}
