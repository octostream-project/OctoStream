// TioAnime channel - ported from Plurtasko's tioanime.py
// Anime in Spanish (Vose/Lat/Esp) - movies and series
// Uses JS arrays in HTML for episodes and videos

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://tioanime.com'

export const tioanime = {
  id: 'tioanime',
  name: 'TioAnime',
  defaultLang: 'VOSE',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST + '/',

  catalogs: [
    { id: 'tioanime-series', name: 'TioAnime: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const url = `${HOST}/directorio?q=`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<article(.*?)</article>')
    for (const m of matches.slice(skip, skip + top)) {
      const itemUrl = findSingleMatch(m, '<a href="(.*?)"')
      let title = findSingleMatch(m, '<h3 class="title">(.*?)</h3>')
      const thumb = findSingleMatch(m, 'src="(.*?)"')
      if (!itemUrl || !title) continue

      title = decodeEntities(title.replace(/&#039;/g, "'").trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const isMovie = fullUrl.includes('-movie-')
      const fullThumb = absoluteUrl(thumb, HOST)

      items.push({
        id: `tioanime:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: fullThumb,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async getMeta({ id }) {
    const url = id.replace(/^tioanime:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<p[^>]*>(.*?)</p>') || ''

    const isMovie = url.includes('-movie-')
    const meta = {
      id,
      type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
      name: decodeEntities(title.trim()),
      title: decodeEntities(title.trim()),
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
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
    // TioAnime stores episodes in JS arrays
    const infoMatch = findSingleMatch(html, 'var anime_info = (\\[.*?\\])')
    const episMatch = findSingleMatch(html, 'var episodes = (\\[.*?\\])')
    if (!infoMatch || !episMatch) return []

    let info, epis
    try {
      info = JSON.parse(infoMatch.replace(/'/g, '"'))
      epis = JSON.parse(episMatch)
    } catch { return [] }

    if (!info || !info[1] || !epis) return []

    // Episodes are in reverse order
    const sortedEpis = [...epis].reverse()
    for (const ep of sortedEpis) {
      const epUrl = `${HOST}/ver/${info[1]}-${ep}`
      episodes.push({
        id: `tioanime:${epUrl}`,
        name: `S1E${ep}`,
        season: 1,
        episode: parseInt(ep, 10),
        url: epUrl,
      })
    }
    return episodes
  },

  async getStreams({ id }) {
    let url = id.replace(/^tioanime:/, '')
    let html = await fetchHtml(url)
    if (!html) return []

    // Si es una página /anime/ (no /ver/), no tiene player.
    // Obtener el primer episodio y usar esa URL.
    if (/\/anime\//.test(url) && !/var videos/.test(html)) {
      const eps = await this._getEpisodes(url, html)
      if (eps.length > 0 && eps[0].url) {
        url = eps[0].url
        html = await fetchHtml(url)
        if (!html) return []
      }
    }

    const streams = []
    // El idioma del episodio es propiedad de la página: el <title> suele
    // llevar "Sub Español"/"Latino"/"Castellano". Sin pista → sin etiqueta.
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')

    // TioAnime stores videos in a JS array: var videos = [...];
    const videosMatch = findSingleMatch(html, 'var videos = (\\[[\\s\\S]*?\\]);')
    if (!videosMatch) return []

    let videos
    try {
      // The array contains tuples like ['server', 'url']
      // Replace single quotes with double quotes for JSON parsing
      const cleaned = videosMatch.replace(/'/g, '"').replace(/\\/g, '')
      videos = JSON.parse(cleaned)
    } catch {
      // Fallback: manual regex extraction
      const serverMatches = findMultipleMatches(videosMatch, '\\["([^"]+)","([^"]+)"\\]')
      for (const m of serverMatches) {
        const srv = m[1]
        const link = m[2]
        const serverName = srv.toLowerCase()
        if (['streamium', 'amus', 'mepu', 'streamsb'].includes(serverName)) continue
        const cleanUrl = link.replace(/\\\//g, '/')
        const server = this._detectServer(cleanUrl)
        if (server) {
          streams.push({
            name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
            url: cleanUrl,
            streamType: normalizeServer(server),
            quality: '',
            server,
            lang: pageLang,
            pluginName: 'TioAnime',
            pluginId: 'plurtasko',
          })
        }
      }
      return streams
    }

    for (const datos of videos) {
      if (!Array.isArray(datos) || datos.length < 2) continue
      const serverName = String(datos[0]).toLowerCase()
      let link = String(datos[1]).replace(/\\\//g, '/')

      if (['streamium', 'amus', 'mepu', 'streamsb'].includes(serverName)) continue

      // UMI server: needs extra fetch
      if (serverName === 'umi') {
        try {
          link = link.replace('gocdn.html#', 'gocdn.php?v=')
          const umiHtml = await fetchHtml(link)
          if (umiHtml) {
            const fileUrl = findSingleMatch(umiHtml, '"file":"(.*?)"')
            if (fileUrl) link = fileUrl.replace(/\\\//g, '/')
          }
        } catch {}
      }

      const server = this._detectServer(link)
      if (server) {
        streams.push({
          name: `${server}${pageLang ? ` (${pageLang})` : ''}`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          lang: pageLang,
          pluginName: 'TioAnime',
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

  async search({ query, type, signal }) {
    const url = `${HOST}/directorio?q=${encodeURIComponent(query).replace(/%20/g, '+')}`
    const html = await fetchHtml(url, signal)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<article(.*?)</article>')
    for (const m of matches) {
      const itemUrl = findSingleMatch(m, '<a href="(.*?)"')
      let title = findSingleMatch(m, '<h3 class="title">(.*?)</h3>')
      const thumb = findSingleMatch(m, 'src="(.*?)"')
      if (!itemUrl || !title) continue

      title = decodeEntities(title.replace(/&#039;/g, "'").trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const isMovie = fullUrl.includes('-movie-')

      if (type === CONTENT_TYPES.MOVIE && !isMovie) continue
      if (type === CONTENT_TYPES.SERIES && isMovie) continue

      items.push({
        id: `tioanime:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: absoluteUrl(thumb, HOST),
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
