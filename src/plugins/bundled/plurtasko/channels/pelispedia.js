// Pelispedia channel - ported from Plurtasko's pelispediais.py
// Provides movies and series in Spanish (Latino, Castellano, Vose)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer, detectServerFromUrl } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://pelispedia.is/'

export const pelispedia = {
  id: 'pelispedia',
  name: 'PelisPedia',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'pelispedia-movies', name: 'PelisPedia: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'pelispedia-series', name: 'PelisPedia: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'pelispedia-movies') url = `${HOST}cartelera-peliculas/`
    else if (id === 'pelispedia-series') url = `${HOST}cartelera-series/`
    else return []

    const html = cleanHtml(await fetchHtml(url))
    const items = []
    // Pelispedia uses <article> with links
    const matches = findMultipleMatches(html, '<article[^>]*>(.*?)</article>')
    for (const m of matches) {
      const block = m[1]
      const itemUrl = findSingleMatch(block, 'href="(https?://[^"]*(?:pelicula|serie)/[^"]*)"')
      if (!itemUrl) continue
      let title = findSingleMatch(block, 'alt="([^"]*)"') || findSingleMatch(block, '<h2[^>]*>(.*?)</h2>')
      title = decodeEntities(title).replace(/^(?:Image|Ver)\s+/i, '').replace(/\s+online.*$/i, '').trim()
      const thumb = findSingleMatch(block, 'src="([^"]*)"')
      const itemType = detectType(itemUrl)
      items.push({
        id: `pelispedia:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: thumb || null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^pelispedia:/, '')
    const html = cleanHtml(await fetchHtml(url))
    let title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>')
    title = decodeEntities(title).replace(/\s*\|.*$/, '').trim()
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"[^>]*class="[^"]*poster[^"]*"') || findSingleMatch(html, 'poster[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<div[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</div>') || findSingleMatch(html, '<p>(.*?)</p>')
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
      meta.episodes = await this._getEpisodes(url)
    }
    return meta
  },

  async _getEpisodes(url) {
    const html = cleanHtml(await fetchHtml(url))
    const episodes = []
    // Pelispedia series have season/episode links
    const matches = findMultipleMatches(html, 'href="(https?://[^"]*temporada[^"]*)"[^>]*>(.*?)</a>')
    let epNum = 0
    for (const m of matches) {
      const epUrl = m[1]
      const epTitle = decodeEntities(m[2]).replace(/<[^>]*>/g, '').trim()
      const seasonMatch = epTitle.match(/T(\d+)\s*E(\d+)/i) || epUrl.match(/temporada\/(\d+)\/capitulo\/(\d+)/i)
      epNum++
      episodes.push({
        id: `pelispedia:${epUrl}`,
        name: epTitle,
        season: seasonMatch ? parseInt(seasonMatch[1], 10) : 1,
        episode: seasonMatch ? parseInt(seasonMatch[2], 10) : epNum,
        url: epUrl,
      })
    }
    return episodes
  },

  async getStreams({ id }) {
    const url = id.replace(/^pelispedia:/, '')
    const rawHtml = await fetchHtml(url)
    if (!rawHtml) return []

    const streams = []

    // Find all option sections with their language
    const optMatches = findMultipleMatches(rawHtml, 'id="options-(\\d+)"[^>]*>([\\s\\S]*?)(?=id="options-\\d+"|$)')
    for (const m of optMatches) {
      const block = m[2]
      // Extract language
      let lang = findSingleMatch(block, '<span class="server">\\s*(.*?)\\s*</span>').trim()
      if (lang.includes('Latino')) lang = 'LAT'
      else if (lang.includes('Castellano') || lang.includes('Español')) lang = 'ESP'
      else if (lang.includes('Subtitulado') || lang.includes('VOSE')) lang = 'VOSE'
      else lang = ''

      // Extract iframe src (embed page)
      const iframeSrc = findSingleMatch(block, 'src="(https?://[^"]*trembed=[^"]*)"')
      if (!iframeSrc) continue

      const embedUrl = iframeSrc.replace(/&#038;/g, '&').replace(/&/g, '&')
      // Fetch the embed page to get the actual video iframe
      try {
        const embedHtml = await fetchHtml(embedUrl)
        let videoUrl = findSingleMatch(embedHtml, '<IFRAME SRC="(.*?)"') || findSingleMatch(embedHtml, '<iframe src="(.*?)"')
        if (videoUrl) {
          videoUrl = videoUrl.replace(/&/g, '&')
          const server = detectServerFromUrl(videoUrl)
          streams.push({
            name: `${server}${lang ? ` (${lang})` : ""}`,
            lang,
            url: videoUrl,
            streamType: normalizeServer(server),
            quality: '',
            server,
            pluginName: 'PelisPedia',
            pluginId: 'plurtasko',
          })
        }
      } catch (e) {
        // If embed fetch fails, use the embed URL directly
        const server = detectServerFromUrl(embedUrl)
        streams.push({
          name: `${server}${lang ? ` (${lang})` : ""}`,
          lang,
          url: embedUrl,
          streamType: normalizeServer(server),
          quality: '',
          server,
          pluginName: 'PelisPedia',
          pluginId: 'plurtasko',
        })
      }
    }

    // Fallback: direct iframe extraction
    if (streams.length === 0) {
      const pageLang = detectLangFromText(findSingleMatch(rawHtml, '<title[^>]*>(.*?)</title>') || '')
      const iframeMatches = findMultipleMatches(rawHtml, '<iframe[^>]*src="(https?://[^"]*trembed=[^"]*)"')
      for (const m of iframeMatches) {
        const embedUrl = m[1].replace(/&#038;/g, '&').replace(/&/g, '&')
        try {
          const embedHtml = await fetchHtml(embedUrl)
          const videoUrl = findSingleMatch(embedHtml, '<IFRAME SRC="(.*?)"') || findSingleMatch(embedHtml, '<iframe src="(.*?)"')
          if (videoUrl) {
            const server = detectServerFromUrl(videoUrl)
            streams.push({
              name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
              lang: pageLang,
              url: videoUrl.replace(/&/g, '&'),
              streamType: normalizeServer(server),
              quality: '',
              server,
              pluginName: 'PelisPedia',
              pluginId: 'plurtasko',
            })
          }
        } catch (e) {
          // skip
        }
      }
    }

    return streams
  },

  async search({ query, type }) {
    const url = `${HOST}?s=${encodeURIComponent(query)}`
    const rawHtml = await fetchHtml(url)
    const items = []

    // Extract articles (each contains a content link with title)
    const articles = findMultipleMatches(rawHtml, '<article[^>]*>([\\s\\S]*?)</article>')
    for (const m of articles) {
      const block = m[1]
      const itemUrl = findSingleMatch(block, 'href="(https?://[^"]*(?:pelicula|serie)/[^"]*)"')
      if (!itemUrl) continue
      if (itemUrl.endsWith('/cartelera-peliculas/') || itemUrl.endsWith('/cartelera-series/')) continue

      let title = findSingleMatch(block, '<h2[^>]*>(.*?)</h2>')
      if (!title) title = findSingleMatch(block, 'alt="([^"]*)"')
      title = title.replace(/^Image\s+/i, '').replace(/^Ver\s+/i, '').replace(/\s+online.*$/i, '').trim()
      title = decodeEntities(title)
      if (!title) title = itemUrl.split('/').filter(Boolean).pop().replace(/-/g, ' ')

      const itemType = detectType(itemUrl)
      if (type === CONTENT_TYPES.MOVIE && itemType === 'series') continue
      if (type === CONTENT_TYPES.SERIES && itemType === 'movie') continue

      items.push({
        id: `pelispedia:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
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

