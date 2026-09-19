import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { httpGetText } from '../../../../utils/httpClient.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://doramedplay.com/'
const DESKTOP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36',
}

// `pageLang` viene del <title> de la página; sin pista queda sin etiqueta.
function stream(rawUrl, pageLang = '') {
  const url = absoluteUrl(String(rawUrl || '').replace(/&amp;/g, '&'), HOST)
  if (!/^https?:/i.test(url) || /youtube\.com\/embed|trailer/i.test(url)) return null
  return { name: `${/peertube/i.test(url) ? 'Peertube' : 'Player'}${pageLang ? ` (${pageLang})` : ''}`, url, streamType: normalizeServer('embed'), quality: '720', server: 'embed', lang: pageLang, pluginName: 'DoramedPlay', pluginId: 'plurtasko' }
}

export const doramedplay = {
  id: 'doramedplay',
  name: 'DoramedPlay',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.DORAMA],
  host: HOST,
  catalogs: [
    { id: 'doramedplay-series', name: 'DoramedPlay: Doramas', type: CONTENT_TYPES.DORAMA },
    { id: 'doramedplay-movies', name: 'DoramedPlay: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async _parseSearch(html) {
    html = cleanHtml(html)
    const items = []
    const seen = new Set()
    const matches = findMultipleMatches(html, '<a[^>]*href=["\'](https?://doramedplay\\.com/(?:tvshows|movies)/[^"\']+)["\'][^>]*>([\\s\\S]*?)</a>')
    for (const m of matches) {
      const url = m[1]
      if (seen.has(url)) continue
      const body = m[2] || ''
      const title = decodeEntities(
        findSingleMatch(body, '<img[^>]*(?:alt|title)=["\']([^"\']+)["\']')
        || findSingleMatch(body, '<h[1-6][^>]*>(.*?)</h[1-6]>')
        || body.replace(/<[^>]+>/g, ' ')
      ).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!title) continue
      seen.add(url)
      const isMovie = /\/movies\//.test(url)
      items.push({ id: `doramedplay:${url}`, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, url, pluginId: 'plurtasko' })
    }
    return items
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'doramedplay-movies' ? 'movies/' : 'tvshows/'
    return (await this._parseSearch(await fetchHtml(`${HOST}${path}`, undefined, DESKTOP_HEADERS))).slice(skip, skip + top)
  },

  async search({ query, type }) {
    // La búsqueda ?s= no renderiza server-side; el tema dooplay expone un
    // endpoint REST (wp-json/dooplay/search/) protegido por un nonce que va
    // embebido en el HTML de cualquier página (objeto dtGonza).
    let items = []
    const home = await fetchHtml(HOST, undefined, DESKTOP_HEADERS)
    const nonce = findSingleMatch(home || '', '"nonce":"([a-f0-9]+)"')
    if (nonce) {
      // httpGetText directo: fetchHtml clasifica un JSON corto ({} o error)
      // como 'down' y marcaría el dominio caído durante 2 min.
      let results = null
      try {
        const raw = await httpGetText(
          `${HOST}wp-json/dooplay/search/?keyword=${encodeURIComponent(query)}&nonce=${nonce}`,
          DESKTOP_HEADERS
        )
        results = JSON.parse(raw)
      } catch { results = null }
      if (results && typeof results === 'object' && !results.error) {
        for (const r of Object.values(results)) {
          const url = String(r?.url || '')
          const title = decodeEntities(String(r?.title || '').trim())
          if (!url || !title) continue
          const isMovie = /\/movies\//.test(url)
          items.push({
            id: `doramedplay:${url}`,
            type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
            name: title,
            title,
            poster: r?.img || null,
            url,
            pluginId: 'plurtasko',
          })
        }
      }
    }
    items = type ? items.filter(item => item.type === type || (type === CONTENT_TYPES.DORAMA && item.type === CONTENT_TYPES.SERIES)) : items

    // Fallback: si la búsqueda no devuelve resultados, intentar slug directo.
    // Muchos sites de dorama no indexan bien todos los títulos; el dorama
    // puede estar en /tvshows/slug/ aunque la búsqueda no lo encuentre.
    if (items.length === 0 && query) {
      const slug = query.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
        .replace(/[^a-z0-9]+/g, '-')                     // no alfanum → guión
        .replace(/^-+|-+$/g, '')                          // sin guiones extremos
      if (slug) {
        const directUrl = `${HOST}tvshows/${slug}/`
        try {
          const directHtml = await fetchHtml(directUrl, undefined, DESKTOP_HEADERS)
          if (directHtml && directHtml.length > 1000 && !/not found|404/i.test(directHtml.substring(0, 500))) {
            const title = decodeEntities(findSingleMatch(directHtml, '<h1[^>]*>(.*?)</h1>') || query).replace(/\s*[|·].*$/, '').trim()
            items = [{
              id: `doramedplay:${directUrl}`,
              type: CONTENT_TYPES.SERIES,
              name: title,
              title,
              url: directUrl,
              pluginId: 'plurtasko',
            }]
          }
        } catch { /* ignore */ }
      }
    }
    return items
  },

  async getMeta({ id }) {
    const url = id.replace(/^doramedplay:/, '')
    const html = cleanHtml(await fetchHtml(url, undefined, DESKTOP_HEADERS))
    if (!html) return null
    const isMovie = /\/movies\//.test(url)
    const title = decodeEntities(findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>') || url).replace(/\s*[|·].*$/, '').trim()
    const meta = { id, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, url, pluginId: 'plurtasko' }
    if (!isMovie) {
      const episodes = []
      const seen = new Set()
      for (const m of findMultipleMatches(html, 'href=["\'](https?://doramedplay\\.com/episodes/[^"\']+-(\\d+)x(\\d+)/?)["\']')) {
        const epUrl = m[1]
        if (seen.has(epUrl)) continue
        seen.add(epUrl)
        episodes.push({ id: `doramedplay:${epUrl}`, name: `S${m[2]}E${m[3]}`, season: parseInt(m[2], 10), episode: parseInt(m[3], 10), url: epUrl })
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id }) {
    const url = id.replace(/^doramedplay:/, '')
    const html = cleanHtml(await fetchHtml(url, undefined, DESKTOP_HEADERS))
    if (!html) return []
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')
    const streams = []
    const seen = new Set()
    const matches = findMultipleMatches(html, '<iframe[^>]*(?:src|data-src)=["\']([^"\']+)["\']')
    for (const m of matches) {
      const item = stream(m[1], pageLang)
      if (item && !seen.has(item.url)) { seen.add(item.url); streams.push(item) }
    }
    return streams
  },
}
