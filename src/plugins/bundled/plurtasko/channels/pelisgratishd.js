// PelisGratishD channel - ported from Plurtasko's pelisgratishd.py
// Movies and series in Spanish (Castilian, Latin, Vose)
// Uses embed69/vidurl like SeriesKao

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer } from '../scraper.js'
import { resolveEmbed69All } from '../resolver.js'

const HOST = 'https://pelisgratishd.zip/'

export const pelisgratishd = {
  id: 'pelisgratishd',
  name: 'PelisGratishD',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'pelisgratishd-movies', name: 'PelisGratishD: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'pelisgratishd-series', name: 'PelisGratishD: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url = id === 'pelisgratishd-movies' ? `${HOST}peliculas`
      : id === 'pelisgratishd-series' ? `${HOST}series`
      : null
    if (!url) return []

    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<article(.*?)</article>')
    for (const m of matches.slice(skip, skip + top)) {
      let title = findSingleMatch(m, 'alt="(.*?)"')
      if (!title) title = findSingleMatch(m, '<h2 class="title">(.*?)</h2>')
      const itemUrl = findSingleMatch(m, 'href="(.*?)"')
      const thumb = findSingleMatch(m, '<img src="([^"]+)"')
      if (!title || !itemUrl) continue

      title = decodeEntities(title.replace('Ver ', '').replace('online en HD', '').trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const itemType = detectType(fullUrl)

      items.push({
        id: `pelisgratishd:${fullUrl}`,
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
    const url = id.replace(/^pelisgratishd:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"[^>]*alt="[^"]*poster')
    const description = findSingleMatch(html, '<p[^>]*>(.*?)</p>') || ''
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
      episodes.push({ id: `pelisgratishd:${epUrl}`, name: `S${season}E${episode}`, season, episode, url: epUrl })
    }
    for (const m of findMultipleMatches(html, 'href=["\']([^"\']*/temporada/(\\d+)/capitulo/(\\d+)[^"\']*)["\']')) {
      addEpisode(m[1], parseInt(m[2], 10), parseInt(m[3], 10))
    }
    if (episodes.length === 0) {
      for (const m of findMultipleMatches(html, 'href=["\']([^"\']*)["\'][^>]*>([\\s\\S]*?)</a>')) {
        const sm = m[2].match(/(\\d+)x(\\d+)/)
        if (sm) addEpisode(m[1], parseInt(sm[1], 10), parseInt(sm[2], 10))
      }
    }
    return episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
  },

  async getStreams({ id, debridEnabled }) {
    const url = id.replace(/^pelisgratishd:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    // Find iframe embed
    let embedUrl = findSingleMatch(html, '<iframe[^>]*src="(.*?)"')
    if (!embedUrl) embedUrl = findSingleMatch(html, 'data-src="(.*?)"')
    if (!embedUrl) return []

    embedUrl = absoluteUrl(embedUrl, HOST)
    if (!embedUrl || /youtube\.com\/embed|trailer/i.test(embedUrl)) return []

    // embed69 / vidurl — use shared resolver (handles POW + AES decryption)
    if (/embed69\.|\/vidurl\//.test(embedUrl)) {
      const resolved = await resolveEmbed69All(embedUrl)
      return resolved.map(r => ({
        name: `${r.server}${r.lang ? ` (${r.lang})` : ''}`,
        url: r.url,
        streamType: normalizeServer(r.server),
        quality: '',
        server: r.server,
        lang: r.lang,
        pluginName: 'PelisGratishD',
        pluginId: 'plurtasko',
      }))
    }

    // Other embeds - try resolver
    const server = this._detectServer(embedUrl)
    if (server) {
      return [{
        name: `${server} (?)`,
        url: embedUrl,
        streamType: normalizeServer(server),
        quality: '',
        server,
        pluginName: 'PelisGratishD',
        pluginId: 'plurtasko',
      }]
    }

    return []
  },

  _parseEmbed69(html, embedUrl, debridEnabled = false) {
    const streams = []
    let dataLink = findSingleMatch(html, 'const dataLink =(.*?);')
    if (!dataLink) dataLink = findSingleMatch(html, 'dataLink(.*?);')
    if (!dataLink) return []

    // Parse language blocks
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
        if (serverName === 'download' || serverName === 'up2box') continue

        const server = this._detectServer(link)
        if (!server) continue

        streams.push({
          name: `${server}${lang ? ` (${lang})` : ''}`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          lang,
          pluginName: 'PelisGratishD',
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
    const url = `${HOST}search?s=${encodeURIComponent(query).replace(/%20/g, '+')}`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    // Parse <a href="URL"><img src="POSTER" alt="TITLE"/></a>
    const matches = findMultipleMatches(html, '<a[^>]*href="([^"]*(?:/serie/|/pelicula/|/movie/)[^"]*)"[^>]*>[\\s\\S]*?<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>')
    for (const m of matches) {
      const itemUrl = absoluteUrl(m[1], HOST)
      const poster = m[2]
      const title = decodeEntities(m[3].trim())
      if (!itemUrl || !title) continue

      const itemType = detectType(itemUrl)
      if (type === CONTENT_TYPES.MOVIE && itemType !== 'movie') continue
      if (type === CONTENT_TYPES.SERIES && itemType !== 'series') continue

      items.push({
        id: `pelisgratishd:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: absoluteUrl(poster, HOST),
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
