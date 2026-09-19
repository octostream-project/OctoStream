// DoramaExpress channel - ported from Plurtasko's doramaexpress.py
// Doramas (Korean/Japanese/Chinese dramas) and movies in Spanish

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://doramaexpress.com/'

export const doramaexpress = {
  id: 'doramaexpress',
  name: 'DoramaExpress',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.DORAMA],
  host: HOST,

  catalogs: [
    { id: 'doramaexpress-series', name: 'DoramaExpress: Doramas', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const url = HOST
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<div class="hero-slide[^"]*">(.*?)(?=<div class="hero-slide|</section>)')
    const seen = new Set()
    for (const m of matches) {
      const block = m[1]
      const thumb = findSingleMatch(block, '<img[^>]*class="[^"]*hero-backdrop[^"]*"[^>]*src="([^"]+)"')
      const title = decodeEntities(findSingleMatch(block, '<h3[^>]*class="[^"]*hero-title[^"]*"[^>]*>(.*?)</h3>').trim())
      const fullUrl = absoluteUrl(findSingleMatch(block, '<a[^>]*href="([^"]*\/serie\/[^"]+)"'), HOST)
      if (!title || !fullUrl || seen.has(fullUrl)) continue
      seen.add(fullUrl)

      items.push({
        id: `doramaexpress:${fullUrl}`,
        type: CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^doramaexpress:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>')
      || findSingleMatch(html, '<meta[^>]*property="og:title"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<title>(.*?)</title>')
      || ''
    const poster = findSingleMatch(html, '<meta[^>]*property="og:image"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<meta[^>]*property="og:description"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<p[^>]*>(.*?)</p>')
      || ''
    const year = findSingleMatch(html, '(\\d{4})')

    const isMovie = /\/(?:movies|pelicula)\//.test(url)
    const cleanTitle = decodeEntities(title)
      .replace(/^Ver\s+/i, '')
      .replace(/\s+En Español.*$/i, '')
      .replace(/\s*[|·].*$/, '')
      .trim()
    const meta = {
      id,
      type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
      name: cleanTitle,
      title: cleanTitle,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (!isMovie) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  async _getEpisodes(url, html) {
    const episodes = []
    // DoramaExpress usa YanPlayerApp: los episodios están en div.ypp-ep-card
    // con data-ep-num y onclick="window.location.href='URL'"
    const epCards = findMultipleMatches(html, 'data-ep-num="(\\d+)"[^>]*onclick="window\\.location\\.href=\'([^\']+)\'')
    for (const m of epCards) {
      const epNum = parseInt(m[1], 10)
      const epUrl = absoluteUrl(m[2], HOST)
      // Extraer SxE del título de la página o del número de temporada del div
      const seasonMatch = m[2].match(/(\d+)x(\d+)/) || [null, 1, epNum]
      const season = parseInt(seasonMatch[1], 10) || 1
      episodes.push({
        id: `doramaexpress:${epUrl}`,
        name: `S${season}E${epNum}`,
        season,
        episode: epNum,
        url: epUrl,
      })
    }

    // Fallback: buscar enlaces con patrón SxE
    if (episodes.length === 0) {
      const epMatches = findMultipleMatches(html, '<a[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)</a>')
      for (const m of epMatches) {
        const epUrl = m[1]
        const text = m[2]
        const sxe = text.match(/(\d+)x(\d+)/) || epUrl.match(/(\d+)x(\d+)/)
        if (!sxe || !epUrl) continue
        const fullUrl = absoluteUrl(epUrl, HOST)
        episodes.push({
          id: `doramaexpress:${fullUrl}`,
          name: `S${sxe[1]}E${sxe[2]}`,
          season: parseInt(sxe[1], 10),
          episode: parseInt(sxe[2], 10),
          url: fullUrl,
        })
      }
    }
    return episodes
  },

  async getStreams({ id, debridEnabled }) {
    const url = id.replace(/^doramaexpress:/, '')
    const html = await fetchHtml(url)
    if (!html) return []
    // Idioma de la página (el <title> lleva "Sub Español"/"Latino"…);
    // sin pista el stream queda sin etiqueta en vez de asumir VOSE.
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')

    const streams = []

    // DoramaExpress usa YanPlayerApp: los servidores están en div.ypp-card-play
    // con data-type="iframe" data-url="URL" data-locked="0"
    const serverCards = findMultipleMatches(html, 'data-type="([^"]*)"[^>]*data-url="([^"]*)"[^>]*data-locked="([^"]*)"')
    // También buscar el orden inverso de atributos
    const serverCards2 = findMultipleMatches(html, 'data-url="([^"]*)"[^>]*data-type="([^"]*)"')
    
    const seen = new Set()
    // Extraer nombre del servidor del texto cercano
    for (const m of [...serverCards, ...serverCards2]) {
      let serverType, streamUrl
      if (m.length === 4) {
        serverType = m[1]
        streamUrl = m[2]
      } else {
        streamUrl = m[1]
        serverType = m[2]
      }
      if (!streamUrl || seen.has(streamUrl)) continue
      seen.add(streamUrl)
      
      // Buscar el nombre del servidor en el contexto cercano
      const idx = html.indexOf(streamUrl)
      const context = html.substring(Math.max(0, idx - 200), idx + streamUrl.length + 200)
      const serverName = findSingleMatch(context, 'ypp-card-title">([^<]+)<') || ''
      
      const server = this._detectServer(streamUrl) || serverName.trim().toLowerCase() || 'embed'
      const fullUrl = absoluteUrl(streamUrl, HOST)
      
      streams.push({
        name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
        url: fullUrl,
        streamType: normalizeServer(server),
        quality: '',
        server,
        lang: pageLang,
        pluginName: 'DoramaExpress',
        pluginId: 'plurtasko',
      })
    }

    if (streams.length > 0) return streams

    // Fallback: Find iframe embed (formato anterior)
    let embedUrl = findSingleMatch(html, '<iframe[^>]*src="(.*?)"')
    if (!embedUrl || embedUrl.includes('YanPlayerApp')) embedUrl = null
    if (!embedUrl) embedUrl = findSingleMatch(html, 'data-src="(.*?)"')
    if (!embedUrl) return []

    embedUrl = absoluteUrl(embedUrl, HOST)
    if (!embedUrl || /youtube\.com\/embed|trailer/i.test(embedUrl)) return []

    // embed69 / vidurl
    if (/embed69\.|\/vidurl\//.test(embedUrl)) {
      const embedHtml = await fetchHtml(embedUrl)
      if (!embedHtml) return []
      return this._parseEmbed69(embedHtml, debridEnabled)
    }

    // Other embeds
    const server = this._detectServer(embedUrl)
    if (server) {
      return [{
        name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
        url: embedUrl,
        streamType: normalizeServer(server),
        quality: '',
        server,
        lang: pageLang,
        pluginName: 'DoramaExpress',
        pluginId: 'plurtasko',
      }]
    }

    // Fetch embed page for server links
    const embedHtml = await fetchHtml(embedUrl)
    if (!embedHtml) return []

    const optMatches = findMultipleMatches(embedHtml, '<li[^>]*onclick="go_to_player.*?\'(.*?)\'')
    for (const m of optMatches) {
      let link = m[1]
      if (!link || link === '#') continue
      try {
        const decoded = atob(link)
        if (decoded.startsWith('http')) link = decoded
      } catch {}

      const server = this._detectServer(link)
      if (server) {
        streams.push({
          name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          lang: pageLang,
          pluginName: 'DoramaExpress',
          pluginId: 'plurtasko',
        })
      }
    }

    return streams
  },

  _parseEmbed69(html, debridEnabled = false) {
    const streams = []
    let dataLink = findSingleMatch(html, 'const dataLink =(.*?);')
    if (!dataLink) dataLink = findSingleMatch(html, 'dataLink(.*?);')
    if (!dataLink) return []

    const eLinks = dataLink.replace(']},', '"type":"file"').replace(']}]', '"type":"file"')
    const langs = findMultipleMatches(eLinks, '"video_language":(.*?)"type":"file"')

    for (let langBlock of langs) {
      let lang = ''
      if (/SUB/.test(langBlock)) lang = 'Vose'
      else if (/LAT/.test(langBlock)) lang = 'Lat'
      else if (/ESP/.test(langBlock)) lang = 'Esp'

      langBlock = langBlock + '"type":"video"'
      const links = findMultipleMatches(langBlock, '"servername":"(.*?)","link":"(.*?)".*?"type":"video"')

      for (const m of links) {
        const srv = m[1]
        const link = m[2]
        const serverName = srv.toLowerCase().trim()
        if (!serverName) continue
        if (/1fichier|plustream|embedsito|disable|xupalace|uploadfox|streamsito/.test(serverName)) { if (!debridEnabled) continue; if (!/1fichier/i.test(serverName)) continue; }

        const server = this._detectServer(link)
        if (!server) continue

        streams.push({
          name: `${server}${lang ? ` (${lang})` : ''}`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          lang,
          pluginName: 'DoramaExpress',
          pluginId: 'plurtasko',
        })
      }
    }
    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/voe|voex/.test(u)) return 'voe'
    if (/fastream/.test(u)) return 'fastream'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/upstream/.test(u)) return 'upstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/ok\.ru|odnoklassniki/.test(u)) return 'okru'
    if (/kwik/.test(u)) return 'kwik'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/fastplay/.test(u)) return 'fastplay'
    if (/lulustream/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    return ''
  },

  async search({ query, type }) {
    const url = `${HOST}?s=${encodeURIComponent(query).replace(/%20/g, '+')}`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const seen = new Set()
    // DoramaExpress no usa <article>; los resultados son enlaces a /serie/ y /pelicula/
    const linkMatches = findMultipleMatches(html, 'href="([^"]*(?:/(?:serie|pelicula)/[^"]+))"')
    for (const m of linkMatches) {
      const fullUrl = absoluteUrl(m[1], HOST)
      if (seen.has(fullUrl)) continue
      seen.add(fullUrl)
      const isMovie = fullUrl.includes('/pelicula/')
      if (type === CONTENT_TYPES.MOVIE && !isMovie) continue
      if (type === CONTENT_TYPES.SERIES && isMovie) continue

      // Buscar título y thumbnail cerca del enlace
      const idx = html.indexOf(fullUrl)
      const context = html.substring(Math.max(0, idx - 500), idx + 500)
      let title = findSingleMatch(context, 'alt="(.*?)"')
               || findSingleMatch(context, '<h[1-6][^>]*>(.*?)</h[1-6]')
               || findSingleMatch(context, 'title="(.*?)"')
      if (!title) title = fullUrl.split('/').filter(Boolean).pop().replace(/-/g, ' ')
      // Filtrar títulos con HTML o "Search results"
      if (/<[^>]+>/.test(title) || /search results/i.test(title)) {
        title = fullUrl.split('/').filter(Boolean).pop().replace(/-/g, ' ')
      }
      const thumb = findSingleMatch(context, '<img[^>]*src="([^"]+)"')

      title = decodeEntities(title.trim())
      items.push({
        id: `doramaexpress:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }

    // Fallback: si la búsqueda no devuelve resultados, intentar slug directo.
    // DoramaExpress no indexa bien todos los títulos en su buscador.
    if (items.length === 0 && query) {
      const slug = query.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (slug) {
        const isMovie = type === CONTENT_TYPES.MOVIE
        const directUrl = `${HOST}${isMovie ? 'pelicula' : 'serie'}/${slug}/`
        try {
          const directHtml = await fetchHtml(directUrl)
          if (directHtml && directHtml.length > 1000 && !/not found|404/i.test(directHtml.substring(0, 500))) {
            const title = decodeEntities(findSingleMatch(directHtml, '<h1[^>]*>(.*?)</h1>') || query).replace(/\s*[|·].*$/, '').trim()
            items.push({
              id: `doramaexpress:${directUrl}`,
              type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
              name: title,
              title,
              url: directUrl,
              pluginId: 'plurtasko',
            })
          }
        } catch { /* ignore */ }
      }
    }
    return items
  },
}
