// GnulaTV channel - ported from Plurtasko's gnulatv.py
// Movies and series in Spanish (Castilian, Latin, Vose)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer } from '../scraper.js'

const HOST = 'https://www2.gnula.one/'

export const gnulatv = {
  id: 'gnulatv',
  name: 'Gnula',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'gnulatv-movies', name: 'Gnula: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'gnulatv-series', name: 'Gnula: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url = id === 'gnulatv-movies' ? `${HOST}peliculas`
      : id === 'gnulatv-series' ? `${HOST}series`
      : null
    if (!url) return []

    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<article(.*?)</article>')
    for (const m of matches.slice(skip, skip + top)) {
      let title = findSingleMatch(m, 'alt="(.*?)"')
      if (!title) title = findSingleMatch(m, '<h2[^>]*>(.*?)</h2>')
      const itemUrl = findSingleMatch(m, 'href="(.*?)"')
      const thumb = findSingleMatch(m, '<img[^>]*src="([^"]+)"')
      if (!title || !itemUrl) continue

      title = decodeEntities(title.trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const itemType = detectType(fullUrl)

      items.push({
        id: `gnulatv:${fullUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async getMeta({ id }) {
    const url = id.replace(/^gnulatv:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const pageTitle = findSingleMatch(html, '<title>(.*?)</title>') || ''
    const heading = findSingleMatch(html, '<h1(?![^>]*report-post-ip)[^>]*>(.*?)</h1>') || ''
    const title = heading || pageTitle.replace(/\s*(?:&#8211;|–|-)\s*G\s*Nula.*$/i, '')
    const poster = findSingleMatch(html, '<meta[^>]*property="og:image"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<img[^>]*src="([^"]*)"[^>]*alt="[^"]*poster')
    const description = findSingleMatch(html, '<meta[^>]*property="og:description"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<p[^>]*>(.*?)</p>')
      || ''
    const year = findSingleMatch(html, '(\\d{4})')

    const isSeries = url.includes('/serie/')
    const meta = {
      id,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: decodeEntities(title.replace(/\s*\|.*$/, '').trim()),
      title: decodeEntities(title.replace(/\s*\|.*$/, '').trim()),
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (isSeries) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  async _getEpisodes(url, html) {
    const episodes = []
    const seen = new Set()
    const addEpisode = (rawUrl, season, episode) => {
      const epUrl = absoluteUrl(rawUrl, HOST)
      const key = `${season}x${episode}`
      if (!epUrl || seen.has(key)) return
      seen.add(key)
      episodes.push({ id: `gnulatv:${epUrl}`, name: `S${season}E${episode}`, season, episode, url: epUrl })
    }
    for (const m of findMultipleMatches(html, 'href=["\']([^"\']*/temporada/(\\d+)/capitulo/(\\d+)[^"\']*)["\']')) {
      addEpisode(m[1], parseInt(m[2], 10), parseInt(m[3], 10))
    }
    return episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
  },

  async getStreams({ id, debridEnabled }) {
    const url = id.replace(/^gnulatv:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const embeds = [
      ...findMultipleMatches(html, '<iframe[^>]*data-lazy-src="([^"]+)"'),
      ...findMultipleMatches(html, '<iframe[^>]*src="([^"]+)"'),
      ...findMultipleMatches(html, '<iframe[^>]*data-src="([^"]+)"'),
    ]
    const directStreams = []
    const seen = new Set()
    let embedUrl = ''
    for (const match of embeds) {
      const candidate = absoluteUrl(match[1], HOST)
      if (!candidate || seen.has(candidate) || /about:blank|youtube\.com\/embed|trailer|facebook\.com/i.test(candidate)) continue
      seen.add(candidate)
      if (/embed69\.|\/vidurl\//.test(candidate)) {
        embedUrl ||= candidate
        continue
      }
      const server = this._detectServer(candidate)
      if (!server) continue
      directStreams.push({
        name: `${server} (?)`,
        url: candidate,
        streamType: normalizeServer(server),
        quality: '',
        server,
        pluginName: 'Gnula',
        pluginId: 'plurtasko',
      })
    }
    if (directStreams.length) return directStreams
    if (!embedUrl) return []

    const embedHtml = await fetchHtml(embedUrl)
    return embedHtml ? this._parseEmbed69(embedHtml, debridEnabled) : []
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
          pluginName: 'Gnula',
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
    if (/yourupload/.test(u)) return 'yourupload'
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

    // Los resultados de búsqueda están en un <table> después del título
    // "Resultados de la búsqueda". El resto de la página tiene sidebar/related.
    const searchStart = html.indexOf('Resultados de la búsqueda')
    let searchHtml = html
    if (searchStart > 0) {
      const tableStart = html.indexOf('<table', searchStart)
      const tableEnd = tableStart > 0 ? html.indexOf('</table>', tableStart) : -1
      if (tableStart > 0 && tableEnd > 0) {
        searchHtml = html.substring(tableStart, tableEnd + 10)
      }
    }

    const items = []
    // gnula uses <a href="/movie/SLUG"><img alt="TITLE" data-lazyload="POSTER"/></a>
    const matches = findMultipleMatches(searchHtml, 'href="([^"]*(?:/movie/|/serie/|/series/)[^"]*)"[^>]*>[\\s\\S]*?<img[^>]*alt="([^"]*)"[^>]*>')
    for (const m of matches) {
      const itemUrl = absoluteUrl(m[1], HOST)
      const title = decodeEntities((m[2] || '').trim())
      if (!itemUrl || !title) continue
      const thumb = findSingleMatch(m[0], '(?:data-lazyload|src)="([^"]+)"')

      const itemType = detectType(itemUrl)
      if (type === CONTENT_TYPES.MOVIE && itemType !== 'movie') continue
      if (type === CONTENT_TYPES.SERIES && itemType !== 'series') continue

      items.push({
        id: `gnulatv:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
