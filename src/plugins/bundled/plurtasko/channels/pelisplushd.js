// PelisPlusHD channel - ported from Plurtasko's pelisplushdnz.py
// Provides movies, series and anime in Spanish (Latino, Castellano, Vose)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer, detectServerFromUrl } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://pelisplushd.bz/'

export const pelisplushd = {
  id: 'pelisplushd',
  name: 'PelisPlusHD',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'pelisplushd-movies', name: 'PelisPlusHD: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'pelisplushd-series', name: 'PelisPlusHD: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'pelisplushd-movies') url = `${HOST}peliculas/populares`
    else if (id === 'pelisplushd-series') url = `${HOST}series/populares`
    else return []

    const html = await fetchHtml(url)
    const items = []
    const bloque = findSingleMatch(html, '<div class="Posters">(.*?)<div class="copyright">')
    const matches = findMultipleMatches(bloque, '<a(.*?)</a>')
    for (const m of matches) {
      const block = m[1]
      const itemUrl = findSingleMatch(block, ' href="(.*?)"')
      let title = findSingleMatch(block, '<p>(.*?)</p>')
      if (!itemUrl || !title) continue
      title = title.replace(/\n|\r|\t|\s{2}|&nbsp;/g, '').trim()
      const thumb = findSingleMatch(block, 'src="(.*?)"')
      let year = findSingleMatch(title, '\\((\\d{4})\\)') || findSingleMatch(title, '\\[(\\d{4})\\]')
      const fullUrl = itemUrl.startsWith('/') ? HOST.slice(0, -1) + itemUrl : itemUrl
      const itemType = detectType(fullUrl)
      items.push({
        id: `pelisplushd:${fullUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: thumb || null,
        year: year ? parseInt(year, 10) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^pelisplushd:/, '')
    const html = await fetchHtml(url)
    let title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>')
    title = decodeEntities(title).replace(/\s*\|.*$/, '').trim()
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"[^>]*class="[^"]*poster[^"]*"')
    const description = findSingleMatch(html, '<p[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</p>') || findSingleMatch(html, '<div[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</div>')
    const year = findSingleMatch(html, /(\d{4})/)

    const meta = {
      id,
      type: detectType(url) === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster || null,
      backdrop: poster || null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (meta.type === CONTENT_TYPES.SERIES) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  async _getEpisodes(url, html = null) {
    // Reutiliza el HTML ya descargado por getMeta en vez de refetchear
    html = html || await fetchHtml(url)
    const episodes = []
    const matches = findMultipleMatches(html, 'href="(https?://[^"]*temporada[^"]*capitulo[^"]*)"')
    let epNum = 0
    for (const m of matches) {
      const epUrl = m[1]
      const seasonMatch = epUrl.match(/temporada\/(\d+)\/capitulo\/(\d+)/i)
      epNum++
      episodes.push({
        id: `pelisplushd:${epUrl}`,
        name: `T${seasonMatch ? seasonMatch[1] : 1}E${seasonMatch ? seasonMatch[2] : epNum}`,
        season: seasonMatch ? parseInt(seasonMatch[1], 10) : 1,
        episode: seasonMatch ? parseInt(seasonMatch[2], 10) : epNum,
        url: epUrl,
      })
    }
    return episodes
  },

  async getStreams({ id }) {
    const url = id.replace(/^pelisplushd:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const streams = []
    // Idioma de la página (el <title> suele llevar "Latino"/"Castellano"/
    // "Subtitulado"); sin pista el stream queda sin etiqueta.
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')

    // Find embed69 iframe
    const embedMatch = findSingleMatch(html, '<iframe[^>]*src="(https?://embed69\\.org/[^"]*)"')
    if (embedMatch) {
      // embed69 will be resolved by the resolveStreams function in index.js
      streams.push({
        name: `Embed69 [PelisPlusHD]${pageLang ? ` (${pageLang})` : ''}`,
        lang: pageLang,
        url: embedMatch,
        streamType: 'embed',
        quality: '',
        server: 'embed69',
        pluginName: 'PelisPlusHD',
        pluginId: 'plurtasko',
      })
    }

    // Find other video options
    const opts = findMultipleMatches(html, '<a href="#option(.*?)"[^>]*>([\\s\\S]*?)</a>')
    for (const m of opts) {
      const optId = m[1]
      const serverName = m[2].replace(/<[^>]*>/g, '').toLowerCase().trim()
      if (!serverName || serverName === 'embed69') continue

      // Find video URL for this option: video[N] = 'https://...'
      let videoUrl = findSingleMatch(html, "video\\[" + optId + "\\]\\s*=\\s*'([^']+)'" )
      if (!videoUrl) videoUrl = findSingleMatch(html, 'video\\[' + optId + '\\]\\s*=\\s*"([^"]+)"')
      if (!videoUrl) videoUrl = findSingleMatch(html, 'video' + optId + '\\s*=\\s*"([^"]+)"')
      if (!videoUrl) videoUrl = findSingleMatch(html, 'video' + optId + "\\s*=\\s*'([^']+)'")
      if (videoUrl) {
        const fullUrl = videoUrl.startsWith('//') ? 'https:' + videoUrl
          : videoUrl.startsWith('/') ? HOST.slice(0, -1) + videoUrl
          : videoUrl
        streams.push({
          name: `${serverName}${pageLang ? ` (${pageLang})` : ''}`,
          lang: pageLang,
          url: fullUrl,
          streamType: normalizeServer(serverName),
          quality: '',
          server: serverName,
          pluginName: 'PelisPlusHD',
          pluginId: 'plurtasko',
        })
      }
    }

    // Fallback: any iframe with a real URL (skip JS expressions like '+video[1]+')
    if (streams.length === 0) {
      const iframeMatches = findMultipleMatches(html, '<iframe[^>]*src="(.*?)"')
      for (const m of iframeMatches) {
        const embedUrl = absoluteUrl(m[1], HOST)
        if (!embedUrl || embedUrl.includes('youtube.com/embed') || embedUrl.includes('trailer')) continue
        // Skip JavaScript expressions that weren't evaluated
        if (embedUrl.includes("'+") || embedUrl.includes('+"') || embedUrl.includes('video[')) continue
        const server = detectServerFromUrl(embedUrl)
        streams.push({
          name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
          lang: pageLang,
          url: embedUrl,
          streamType: normalizeServer(server),
          quality: '',
          server,
          pluginName: 'PelisPlusHD',
          pluginId: 'plurtasko',
        })
      }
    }

    return streams
  },

  async search({ query, type }) {
    const url = `${HOST}search?s=${encodeURIComponent(query)}&page=1`
    const html = await fetchHtml(url)
    const items = []

    // Extract content links with their data-title
    const linkMatches = findMultipleMatches(html, 'href="(https?://pelisplushd\\.bz/(?:pelicula|serie|anime)/[^"]*)"[^>]*data-title="([^"]*)"')
    for (const m of linkMatches) {
      const itemUrl = m[1]
      let title = m[2] || ''
      title = title.replace(/^VER\s+/i, '').replace(/\s+Online.*$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim()
      const itemType = detectType(itemUrl)
      if (type === CONTENT_TYPES.MOVIE && itemType === 'series') continue
      if (type === CONTENT_TYPES.SERIES && itemType === 'movie') continue

      items.push({
        id: `pelisplushd:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    // Deduplicate
    const seen = new Set()
    return items.filter(item => {
      if (seen.has(item.url)) return false
      seen.add(item.url)
      return true
    })
  },
}

