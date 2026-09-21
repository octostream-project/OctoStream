// DoramasYT channel - doramas, películas y series en español
// Estructura: /dorama/slug, /ver/slug-episodio-N, /peliculas
// Streams: data-player (base64 cifrado) → /reproductor?video=...&player=... → iframe real

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://www.doramasyt.com/'

export const doramasyt = {
  id: 'doramasyt',
  name: 'DoramasYT',
  defaultLang: 'Lat',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.DORAMA],
  host: HOST,

  catalogs: [
    { id: 'doramasyt-doramas', name: 'DoramasYT: Doramas', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'doramasyt-movies' ? 'peliculas' : 'doramas'
    const url = `${HOST}${path}`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    // Find dorama/movie links with titles
    const type = id === 'doramasyt-movies' ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES
    const linkPattern = id === 'doramasyt-movies'
      ? 'href="(https://www\\.doramasyt\\.com/pelicula/[^"]+)"'
      : 'href="(https://www\\.doramasyt\\.com/dorama/[^"]+)"'

    const matches = findMultipleMatches(html, linkPattern)
    const seen = new Set()
    for (const m of matches) {
      const itemUrl = m[1]
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)

      // Find title near the link
      const titleMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?<h[1-6][^>]*>(.*?)</h`)
                   || findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?title="([^"]+)"`)
      let title = titleMatch ? decodeEntities(titleMatch.trim()) : itemUrl.split('/').pop().replace(/-/g, ' ')

      // Find poster
      const thumbMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,500}?src="([^"]+)"`)
      const poster = thumbMatch ? absoluteUrl(thumbMatch, HOST) : null

      items.push({
        id: `doramasyt:${itemUrl}`,
        type,
        name: title,
        title,
        poster,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^doramasyt:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>') || ''
    const cleanTitle = decodeEntities(title.replace(/\s*[|·].*$/, '').replace(/\s*Sub.*$/i, '').trim())
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<p[^>]*>(.*?)</p>') || ''

    const isMovie = url.includes('/pelicula/')
    const meta = {
      id,
      type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
      name: cleanTitle,
      title: cleanTitle,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      url,
      pluginId: 'plurtasko',
    }

    if (!isMovie) {
      meta.episodes = this._parseEpisodes(html)
    }
    return meta
  },

  _parseEpisodes(html) {
    const episodes = []
    // Episode URLs: /ver/slug-episodio-N
    const matches = findMultipleMatches(html, 'href="(https://www\\.doramasyt\\.com/ver/[^"]+)"')
    const seen = new Set()
    for (const m of matches) {
      const epUrl = m[1]
      if (seen.has(epUrl)) continue
      seen.add(epUrl)
      // Extract episode number from URL
      const epMatch = epUrl.match(/episodio-(\d+)/)
      const epNum = epMatch ? parseInt(epMatch[1], 10) : 0
      if (!epNum) continue
      episodes.push({
        id: `doramasyt:${epUrl}`,
        name: `Episodio ${epNum}`,
        season: 1,
        episode: epNum,
        url: epUrl,
      })
    }
    episodes.sort((a, b) => a.episode - b.episode)
    return episodes
  },

  async getStreams({ id }) {
    const url = id.replace(/^doramasyt:/, '')
    const html = await fetchHtml(url)
    if (!html) return []
    // Idioma de la página (el <title> lleva "Sub Español"/"Latino"…);
    // sin pista el stream queda sin etiqueta en vez de asumir VOSE.
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')

    const streams = []
    // Find the player key (reproductor endpoint)
    const playerKey = findSingleMatch(html, 'data-key="([^"]+)"')
    if (!playerKey) return []

    // Find all server buttons: <button data-player="BASE64" data-usa-api="1">SERVER_NAME</button>
    const matches = findMultipleMatches(html, 'data-player="([^"]+)"[^>]*data-usa-api="([^"]*)"[^>]*>\\s*([^<]+)</button>')
    const seen = new Set()
    for (const m of matches) {
      const playerData = m[1]
      const serverName = m[3].trim().toLowerCase()
      if (seen.has(playerData)) continue
      seen.add(playerData)

      try {
        // Build the reproductor URL
        const reproUrl = `${playerKey}${playerData}&player=${encodeURIComponent(serverName)}&token=`
        const reproHtml = await fetchHtml(reproUrl, null, { 'Referer': url })
        if (!reproHtml) continue

        // Extract the real iframe URL
        const iframeUrl = findSingleMatch(reproHtml, '<iframe[^>]*src="([^"]+)"')
        if (!iframeUrl) continue

        const fullUrl = absoluteUrl(iframeUrl, HOST)
        const server = this._detectServer(fullUrl)
        if (server) {
          streams.push({
            name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
            url: fullUrl,
            streamType: normalizeServer(server),
            quality: '',
            server,
            lang: pageLang,
            pluginName: 'DoramasYT',
            pluginId: 'plurtasko',
          })
        }
      } catch {}
    }

    // Fallback: direct download links on page
    if (streams.length === 0) {
      const dlMatches = findMultipleMatches(html, 'href="(https://(?:filemoon|mixdrop|voe|streamwish|doodstream)[^"]+)"')
      for (const m of dlMatches) {
        const server = this._detectServer(m[1])
        if (server) {
          streams.push({
            name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
            url: m[1],
            streamType: normalizeServer(server),
            quality: '',
            server,
            lang: pageLang,
            pluginName: 'DoramasYT',
            pluginId: 'plurtasko',
          })
        }
      }
    }

    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/voe|voex|voe\.sx/.test(u)) return 'voe'
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo|flaswish/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/upstream/.test(u)) return 'upstream'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/ok\.ru|odnoklassniki/.test(u)) return 'okru'
    if (/kwik/.test(u)) return 'kwik'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/fastplay/.test(u)) return 'fastplay'
    if (/lulustream|luluvdo/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/fastream/.test(u)) return 'fastream'
    if (/embedv/.test(u)) return 'embedv'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    return ''
  },

  async search({ query, type }) {
    // Balandro-style search: host + 'buscar?q=' + query with spaces as '+'
    const searchUrl = `${HOST}buscar?q=${encodeURIComponent(query).replace(/%20/g, '+')}`
    const html = await fetchHtml(searchUrl)
    if (!html) return []

    const items = []
    const seen = new Set()

    // Collect dorama links (series)
    const doramaMatches = findMultipleMatches(html, 'href="(https://www\\.doramasyt\\.com/dorama/[^"]+)"')
    for (const m of doramaMatches) {
      const itemUrl = m[1]
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)

      // Extract title near the link
      const titleMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?<h[1-6][^>]*>(.*?)</h`)
                   || findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?title="([^"]+)"`)
      let title = titleMatch ? decodeEntities(titleMatch.trim()) : itemUrl.split('/').pop().replace(/-/g, ' ')

      // Extract poster near the link
      const thumbMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,500}?src="([^"]+)"`)
      const poster = thumbMatch ? absoluteUrl(thumbMatch, HOST) : null

      items.push({
        id: `doramasyt:${itemUrl}`,
        type: CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    // Collect movie links (pelicula)
    const movieMatches = findMultipleMatches(html, 'href="(https://www\\.doramasyt\\.com/pelicula/[^"]+)"')
    for (const m of movieMatches) {
      const itemUrl = m[1]
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)

      const titleMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?<h[1-6][^>]*>(.*?)</h`)
                   || findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,800}?title="([^"]+)"`)
      let title = titleMatch ? decodeEntities(titleMatch.trim()) : itemUrl.split('/').pop().replace(/-/g, ' ')

      const thumbMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,500}?src="([^"]+)"`)
      const poster = thumbMatch ? absoluteUrl(thumbMatch, HOST) : null

      items.push({
        id: `doramasyt:${itemUrl}`,
        type: CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    // Filter by requested type if specified
    let results = items
    if (type) {
      results = items.filter(item => item.type === type)
    }

    // Fallback: if search returned nothing usable, filter the catalog
    if (results.length === 0) {
      const cat = type === CONTENT_TYPES.MOVIE ? 'doramasyt-movies' : 'doramasyt-doramas'
      const all = await this.getCatalog({ id: cat, skip: 0, top: 200 })
      const q = query.toLowerCase()
      return all.filter(item => item.name.toLowerCase().includes(q))
    }

    return results
  },
}
