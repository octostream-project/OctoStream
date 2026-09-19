// SeriesKao channel - ported from Plurtasko's serieskao.py
// Provides series in Spanish (Latino, Castellano, Vose)
// Uses streamwish, filemoon, vidhide, voe, fastream servers

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer } from '../scraper.js'

const HOST = 'https://serieskao.top/'

export const serieskao = {
  id: 'serieskao',
  name: 'SeriesKao',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE],
  host: HOST,

  catalogs: [
    { id: 'serieskao-series', name: 'SeriesKao: Series', type: CONTENT_TYPES.SERIES },
    { id: 'serieskao-movies', name: 'SeriesKao: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'serieskao-series') url = `${HOST}series`
    else if (id === 'serieskao-movies') url = `${HOST}peliculas`
    else return []

    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, '<article[^>]*class="[^"]*card[^"]*"[^>]*>(.*?)</article>')
    for (const m of matches) {
      const block = m[1]
      const itemUrl = absoluteUrl(findSingleMatch(block, '<a[^>]*href="([^"]+)"'), HOST)
      if (!itemUrl.includes('/serie/') && !itemUrl.includes('/pelicula/')) continue
      const poster = findSingleMatch(block, '<img[^>]*src="([^"]+)"')
      const title = decodeEntities(findSingleMatch(block, '<img[^>]*alt="([^"]+)"').trim())
      if (!itemUrl || !title) continue

      const itemType = detectType(itemUrl)
      items.push({
        id: `serieskao:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: absoluteUrl(poster, HOST),
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^serieskao:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''
    const poster = findSingleMatch(html, '<img[^>]*class="[^"]*poster[^"]*"[^>]*src="([^"]*)"')
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
      episodes.push({
        id: `serieskao:${epUrl}`,
        name: `S${season}E${episode}`,
        season,
        episode,
        url: epUrl,
      })
    }
    for (const m of findMultipleMatches(html, 'href=["\']([^"\']*/temporada/(\\d+)/capitulo/(\\d+)[^"\']*)["\']')) {
      addEpisode(m[1], parseInt(m[2], 10), parseInt(m[3], 10))
    }
    // Compatibilidad con el formato antiguo 1x1 mostrado en el texto.
    if (episodes.length === 0) {
      for (const m of findMultipleMatches(html, 'href=["\']([^"\']+)["\'][^>]*>[\\s\\S]*?(\\d+)x(\\d+)')) {
        addEpisode(m[1], parseInt(m[2], 10), parseInt(m[3], 10))
      }
    }
    return episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
  },

  async getStreams({ id, debridEnabled }) {
    const url = id.replace(/^serieskao:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const streams = []

    // Find player iframe
    let embedUrl = findSingleMatch(html, '<iframe[^>]*id="player-iframe"[^>]*src="(.*?)"')
    if (!embedUrl) embedUrl = findSingleMatch(html, '<iframe[^>]*src="(.*?)"')
    if (!embedUrl) return []

    embedUrl = absoluteUrl(embedUrl, HOST)
    if (!embedUrl || /youtube\.com\/embed|trailer/i.test(embedUrl)) return []

    // If it's embed69, pass it to the resolver
    if (/embed69\.|vidurl\//.test(embedUrl)) {
      streams.push({
        name: 'Embed69 [SeriesKao]',
        url: embedUrl,
        streamType: 'embed',
        quality: '',
        server: 'embed69',
        pluginName: 'SeriesKao',
        pluginId: 'plurtasko',
      })
      return streams
    }

    // Fetch the embed page
    const embedHtml = await fetchHtml(embedUrl)
    if (!embedHtml) return []

    // Extract go_to_player links
    const goToMatches = findMultipleMatches(embedHtml, 'onclick="go_to_player.*?\'(.*?)\'')
    for (const m of goToMatches) {
      let link = m
      if (!link || link === '#') continue
      // Try base64 decode
      try {
        const decoded = atob(link)
        if (decoded.startsWith('http')) link = decoded
      } catch {}

      if (/1fichier\.|short\.|plustream\.|player-cdn\.|embedsito|disable|xupalace|uploadfox/i.test(link)) continue

      const server = this._detectServer(link)
      if (server) {
        streams.push({
          name: `${server} (?)`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          pluginName: 'SeriesKao',
          pluginId: 'plurtasko',
        })
      }
    }

    // Extract dataLink JSON - has video_language and sortedEmbeds
    const dataLink = findSingleMatch(embedHtml, 'const dataLink =(.*?);') || findSingleMatch(embedHtml, 'let dataLink =(.*?);')
    if (dataLink) {
      try {
        const data = JSON.parse(dataLink)
        for (const entry of data) {
          const lang = entry.video_language || ''
          const embeds = entry.sortedEmbeds || []
          for (const embed of embeds) {
            const srv = (embed.servername || '').toLowerCase().trim()
            const link = embed.link || ''
            if (!srv || !link) continue
            if (/1fichier|plustream|embedsito|disable|xupalace|uploadfox|download|up2box/i.test(srv)) { if (!debridEnabled) continue; if (!/1fichier/i.test(srv)) continue; }

            const server = this._corregirServer(srv)
            if (server) {
              streams.push({
                name: `${server} (${lang})`,
                url: link,
                streamType: normalizeServer(server),
                quality: '',
                server,
                lang,
                pluginName: 'SeriesKao',
                pluginId: 'plurtasko',
              })
            }
          }
        }
      } catch {
        // Fallback to regex if JSON parse fails
        const links = findMultipleMatches(dataLink, '"servername":"(.*?)","link":"(.*?)"')
        for (const m of links) {
          const srv = m[1].toLowerCase().trim()
          const link = m[2]
          if (!srv || !link) continue
          if (/1fichier|plustream|embedsito|disable|xupalace|uploadfox|download|up2box/i.test(srv)) { if (!debridEnabled) continue; if (!/1fichier/i.test(srv)) continue; }

          const server = this._corregirServer(srv)
          if (server) {
            streams.push({
              name: `${server} (?)`,
              url: link,
              streamType: normalizeServer(server),
              quality: '',
              server,
              pluginName: 'SeriesKao',
              pluginId: 'plurtasko',
            })
          }
        }
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

  _corregirServer(srv) {
    const s = srv.toLowerCase().trim()
    if (/streamwish|streamsss|wish/.test(s)) return 'streamwish'
    if (/filemoon|fmoon/.test(s)) return 'filemoon'
    if (/filelions|lions/.test(s)) return 'filelions'
    if (/vidhide|hide/.test(s)) return 'vidhide'
    if (/voe|voex/.test(s)) return 'voe'
    if (/fastream/.test(s)) return 'fastream'
    if (/streamtape|tape/.test(s)) return 'streamtape'
    if (/doodstream|dood/.test(s)) return 'doodstream'
    if (/upstream/.test(s)) return 'upstream'
    if (/mixdrop/.test(s)) return 'mixdrop'
    if (/uqload/.test(s)) return 'uqload'
    if (/mp4upload/.test(s)) return 'mp4upload'
    if (/yourupload/.test(s)) return 'yourupload'
    if (/ok\.ru|okru|ok-ru/.test(s)) return 'okru'
    if (/kwik/.test(s)) return 'kwik'
    if (/vidmoly/.test(s)) return 'vidmoly'
    if (/vidoza/.test(s)) return 'vidoza'
    if (/supervideo/.test(s)) return 'supervideo'
    if (/fastplay/.test(s)) return 'fastplay'
    if (/lulustream|lulu/.test(s)) return 'lulustream'
    if (/maxstream/.test(s)) return 'maxstream'
    if (/sendvid/.test(s)) return 'sendvid'
    if (/turbovid/.test(s)) return 'turbovid'
    if (/mega/.test(s)) return 'mega'
    if (/vimeo/.test(s)) return 'vimeo'
    if (/dailymotion/.test(s)) return 'dailymotion'
    if (/rumble/.test(s)) return 'rumble'
    if (/vk/.test(s)) return 'vk'
    return ''
  },

  async search({ query, type }) {
    const url = `${HOST}search?s=${encodeURIComponent(query).replace(/%20/g, '+')}`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    // Parse <article class="card"><a href="URL"><img src="POSTER" alt="TITLE"/></a></article>
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
        id: `serieskao:${itemUrl}`,
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
