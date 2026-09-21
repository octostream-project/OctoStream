import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://animeyt.cc/'

// `pageLang` viene del <title> de la página del episodio ("Sub Español",
// "Latino"…); sin pista el stream queda sin etiqueta.
function streamFromUrl(rawUrl, pageLang = '') {
  const url = absoluteUrl(String(rawUrl || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\s+/g, ''), HOST)
  if (!/^https?:/i.test(url) || /youtube\.com\/embed|trailer/i.test(url) || /^https?:\/\/(?:i0\.wp\.com|animeyt\.cc\/wp-content)/i.test(url)) return null
  const server = /mytsumi/i.test(url) ? 'embed' : 'embed'
  return {
    name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
    url,
    streamType: normalizeServer(server),
    quality: '720',
    server,
    lang: pageLang,
    pluginName: 'AnimeYT',
    pluginId: 'plurtasko',
  }
}

export const animeyt = {
  id: 'animeyt',
  name: 'AnimeYT',
  defaultLang: 'VOSE',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'animeyt-series', name: 'AnimeYT: Series', type: CONTENT_TYPES.ANIME },
    { id: 'animeyt-movies', name: 'AnimeYT: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const url = id === 'animeyt-movies' ? `${HOST}pelicula/` : `${HOST}tv/`
    return (await this._parseSearch(await fetchHtml(url))).slice(skip, skip + top)
  },

  async _parseSearch(html) {
    html = cleanHtml(html)
    if (!html) return []
    const items = []
    const seen = new Set()
    const matches = findMultipleMatches(html, '<article[^>]*>[\\s\\S]*?<a[^>]*href="([^"]+(?:/tv/|/pelicula/)[^"]*)"[^>]*>[\\s\\S]*?<img[^>]*alt="([^"]*)"[^>]*>')
    for (const m of matches) {
      const url = absoluteUrl(m[1], HOST)
      if (seen.has(url)) continue
      seen.add(url)
      const isMovie = /\/pelicula\//.test(url)
      const title = decodeEntities(m[2].trim())
      if (!title) continue
      items.push({
        id: `animeyt:${url}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: null,
        url,
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async search({ query, type }) {
    // La página /search/ carga resultados por AJAX; el endpoint REST público
    // devuelve JSON directamente.
    const raw = await fetchHtml(`${HOST}wp-json/aniyt/v1/catalog/search?q=${encodeURIComponent(query)}&limit=10`)
    let results = []
    try { results = JSON.parse(raw)?.results || [] } catch { results = [] }
    const items = []
    const seen = new Set()
    for (const r of results) {
      const url = String(r?.url || '')
      if (!url || seen.has(url)) continue
      seen.add(url)
      const title = decodeEntities(String(r?.title || '').trim())
      if (!title) continue
      items.push({
        id: `animeyt:${url}`,
        type: /\/pelicula\//.test(url) ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: r?.image || null,
        url,
        pluginId: 'plurtasko',
      })
    }
    return type && type !== CONTENT_TYPES.ANIME ? items.filter(item => item.type === type) : items
  },

  async getMeta({ id }) {
    const url = id.replace(/^animeyt:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') ||
      findSingleMatch(html, 'og:title"[^>]*content="([^"]*)"') ||
      findSingleMatch(html, '<title>(.*?)</title>') || url
    ).replace(/<[^>]+>/g, ' ').replace(/\s+Capitulo\s+\d+.*$/i, '').replace(/\s+/g, ' ').trim()
    const isMovie = /\/pelicula\//.test(url)
    const meta = { id, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, url, pluginId: 'plurtasko' }
    if (!isMovie) {
      const episodes = []
      const seen = new Set()
      const matches = findMultipleMatches(html, 'href="([^"]*/(?:anime|tv)/[^" ]*capitulo[-_]\\d+[^" ]*)"')
      for (const m of matches) {
        const epUrl = absoluteUrl(m[1], HOST)
        if (seen.has(epUrl)) continue
        seen.add(epUrl)
        const season = parseInt(epUrl.match(/(?:temporada|season)[-_]?(\d+)/i)?.[1] || '1', 10)
        const episode = parseInt(epUrl.match(/capitulo[-_](\d+)/i)?.[1] || '0', 10)
        if (!episode) continue
        episodes.push({ id: `animeyt:${epUrl}`, name: `S${season}E${episode}`, season, episode, url: epUrl })
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id }) {
    let url = id.replace(/^animeyt:/, '')
    let html = cleanHtml(await fetchHtml(url))
    if (!html) return []
    // Las películas enlazan a una página /anime/... que contiene el player.
    if (/\/pelicula\//.test(url) && !/mytsumi|data-aniyt-player/i.test(html)) {
      const episodeUrl = findSingleMatch(html, 'href="(https?://animeyt\\.cc/[^" ]*/anime/[^" ]+)"')
      if (episodeUrl) {
        url = episodeUrl
        html = cleanHtml(await fetchHtml(url))
      }
    }
    const urls = [
      ...findMultipleMatches(html, '<iframe[^>]*data-src=["\']([^"\']+)["\']'),
      ...findMultipleMatches(html, '<iframe[^>]*src=["\']([^"\']+)["\']'),
      ...findMultipleMatches(html, '(?:data-player|data-video)=["\']([^"\']+)["\']'),
    ]
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')
    const streams = []
    const seen = new Set()
    for (const match of urls) {
      const stream = streamFromUrl(match[1], pageLang)
      if (stream && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream) }
    }
    return streams
  },
}
