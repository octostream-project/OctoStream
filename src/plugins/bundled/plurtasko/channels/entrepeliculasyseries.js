// EntrePeliculasYSeries channel - ported from Plurtasko's entrepeliculasyseries.py
// Provides movies and series in Spanish (Latino, Castellano, Vose)
// Uses embed69 (cuevana) + direct server links (streamwish, filemoon, vidhide, etc.)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, normalizeServer } from '../scraper.js'

const HOST = 'https://entrepeliculasyseries.nz/'

export const entrepeliculasyseries = {
  id: 'entrepeliculasyseries',
  name: 'EntrePeliculasYSeries',
  defaultLang: 'Lat',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'entrepeliculasyseries-movies', name: 'EntrePeliculasYSeries: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'entrepeliculasyseries-series', name: 'EntrePeliculasYSeries: Series', type: CONTENT_TYPES.SERIES },
  ],

  // Parse a list page (catalog or search results) for movie/series articles.
  // Each <article> contains an <a href> link, an <img src> poster and an alt title.
  // Returns array of items with id/type/name/title/poster/url.
  _parseList(html, { skip = 0, top = 50 } = {}) {
    if (!html) return []
    const items = []
    const matches = findMultipleMatches(html, '<article[^>]*>[\\s\\S]*?<a[^>]*href="([^"]*)"[^>]*>[\\s\\S]*?<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>')
    for (const m of matches.slice(skip, skip + top)) {
      const itemUrl = absoluteUrl(m[1], HOST)
      const poster = m[2]
      const title = decodeEntities(m[3].trim())
      if (!itemUrl || !title) continue

      const itemType = detectType(itemUrl)
      items.push({
        id: `entrepeliculasyseries:${itemUrl}`,
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

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'entrepeliculasyseries-movies') url = `${HOST}peliculas`
    else if (id === 'entrepeliculasyseries-series') url = `${HOST}series`
    else return []

    const html = await fetchHtml(url)
    if (!html) return []

    return this._parseList(html, { skip, top })
  },

  async getMeta({ id }) {
    const url = id.replace(/^entrepeliculasyseries:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''
    const poster = findSingleMatch(html, '<img[^>]*class="[^"]*poster[^"]*"[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<p[^>]*itemprop="description"[^>]*>(.*?)</p>') || findSingleMatch(html, '<div[^>]*class="[^"]*sinopsis[^"]*"[^>]*>(.*?)</div>')
    const year = findSingleMatch(html, '/year/(\\d{4})') || findSingleMatch(html, '(\\d{4})')

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
    for (const m of findMultipleMatches(html, 'href=["\']([^"\']*/temporada/(\\d+)/capitulo/(\\d+)[^"\']*)["\']')) {
      const epUrl = absoluteUrl(m[1], HOST)
      if (!epUrl || seen.has(epUrl)) continue
      seen.add(epUrl)
      episodes.push({
        id: `entrepeliculasyseries:${epUrl}`,
        name: `S${m[2]}E${m[3]}`,
        season: parseInt(m[2], 10),
        episode: parseInt(m[3], 10),
        url: epUrl,
      })
    }
    const seasonMatches = findMultipleMatches(html, 'data-season="(\\d+)"[^>]*data-id="([^"]*)"')
    for (const m of seasonMatches) {
      const season = parseInt(m[1], 10)
      const seasonId = m[2]
      // Fetch episodes for this season
      const epHtml = await fetchHtml(`${HOST}wp-admin/admin-ajax.php?action=season&season=${seasonId}`)
      if (!epHtml) continue
      const epMatches = findMultipleMatches(epHtml, '<a[^>]*href="([^"]*)"[^>]*>.*?Episodio\\s*(\\d+)')
      for (const em of epMatches) {
        episodes.push({
          id: `entrepeliculasyseries:${em[1]}`,
          name: `Episodio ${em[2]}`,
          season,
          episode: parseInt(em[2], 10),
          url: em[1],
        })
      }
    }
    return episodes
  },

  async getStreams({ id, debridEnabled }) {
    const url = id.replace(/^entrepeliculasyseries:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const streams = []

    // Find iframe embed
    let embedUrl = findSingleMatch(html, '<iframe[^>]*src="(.*?)"')
    if (!embedUrl) embedUrl = findSingleMatch(html, 'data-src="(.*?)"')
    if (!embedUrl) return []

    embedUrl = embedUrl.replace(/&#038;/g, '&').replace(/&#038;/g, '&').replace(/&/g, '&')
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl
    else if (embedUrl.startsWith('/')) embedUrl = HOST.slice(0, -1) + embedUrl
    if (!embedUrl.startsWith('http')) return []

    // If it's embed69, pass it to the resolver
    if (/embed69\.|vidurl\//.test(embedUrl)) {
      streams.push({
        name: 'Embed69 [EntrePeliculasYSeries]',
        url: embedUrl,
        streamType: 'embed',
        quality: '',
        server: 'embed69',
        pluginName: 'EntrePeliculasYSeries',
        pluginId: 'plurtasko',
      })
      return streams
    }

    // Fetch the embed page
    const embedHtml = await fetchHtml(embedUrl)
    if (!embedHtml) return []

    // Extract go_to_player links (direct server URLs)
    const goToMatches = findMultipleMatches(embedHtml, 'onclick="go_to_player.*?\'(.*?)\'')
    for (const m of goToMatches) {
      let link = m
      if (!link || link === '#') continue
      // Try base64 decode
      try {
        const decoded = atob(link)
        if (decoded.startsWith('http')) link = decoded
      } catch {}

      if (/1fichier\.|short\.|plustream\.|player-cdn\.|embedsito|disable|xupalace|uploadfox/i.test(link)) {
        if (!debridEnabled) continue
        // When debrid is enabled, keep 1fichier links (debrid can unlock them)
        if (!/1fichier/i.test(link)) continue
      }

      // Detect server from URL
      const server = this._detectServer(link)
      if (server) {
        streams.push({
          name: `${server} (?)`,
          url: link,
          streamType: normalizeServer(server),
          quality: '',
          server,
          pluginName: 'EntrePeliculasYSeries',
          pluginId: 'plurtasko',
        })
      }
    }

    // Extract dataLink JSON (embed69 style)
    const dataLink = findSingleMatch(embedHtml, 'const dataLink =(.*?);') || findSingleMatch(embedHtml, 'let dataLink =(.*?);')
    if (dataLink) {
      const links = findMultipleMatches(dataLink, '"servername":"(.*?)","link":"(.*?)"')
      for (const m of links) {
        const srv = m[1].toLowerCase().trim()
        const link = m[2]
        if (!srv || !link) continue
        if (/1fichier|plustream|embedsito|disable|xupalace|uploadfox|download|up2box/i.test(srv)) {
          if (!debridEnabled) continue
          if (!/1fichier/i.test(srv)) continue
        }

        const server = this._corregirServer(srv)
        if (server) {
          streams.push({
            name: `${server} (?)`,
            url: link,
            streamType: normalizeServer(server),
            quality: '',
            server,
            pluginName: 'EntrePeliculasYSeries',
            pluginId: 'plurtasko',
          })
        }
      }
    }

    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon|moonplayer/.test(u)) return 'filemoon'
    if (/vidhide|vidhide|hidemv|hidejav|hidevod/.test(u)) return 'vidhide'
    if (/voe|voex/.test(u)) return 'voe'
    if (/fastream/.test(u)) return 'fastream'
    if (/streamtape|stape|tape|stremtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\.|doodso|doodpm|doodws|doodto|doodli/.test(u)) return 'doodstream'
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
    if (/lulustream|lulu/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/vidfast/.test(u)) return 'vidfast'
    if (/streamoupload/.test(u)) return 'streamoupload'
    if (/embedrise/.test(u)) return 'embedrise'
    if (/anonstream/.test(u)) return 'anonstream'
    if (/highstream/.test(u)) return 'highstream'
    if (/streamruby/.test(u)) return 'streamruby'
    if (/gostream/.test(u)) return 'gostream'
    if (/mega\.nz/.test(u)) return 'mega'
    if (/vimeo/.test(u)) return 'vimeo'
    if (/dailymotion|dai\.ly/.test(u)) return 'dailymotion'
    if (/rumble/.test(u)) return 'rumble'
    if (/vk\.com|vkontakte/.test(u)) return 'vk'
    if (/embedgram/.test(u)) return 'embedgram'
    if (/streamable/.test(u)) return 'streamable'
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
    if (/vidfast/.test(s)) return 'vidfast'
    if (/mega/.test(s)) return 'mega'
    if (/vimeo/.test(s)) return 'vimeo'
    if (/dailymotion/.test(s)) return 'dailymotion'
    if (/rumble/.test(s)) return 'rumble'
    if (/vk/.test(s)) return 'vk'
    if (/embedgram/.test(s)) return 'embedgram'
    if (/streamable/.test(s)) return 'streamable'
    return ''
  },

  async search({ query, type }) {
    // Balandro uses a simple search URL: host + 'search?s=' + texto.replace(" ", "+")
    // Cloudflare may 403 the internal search; we add a desktop User-Agent and
    // Referer to look like a real browser request.
    const searchQuery = query.trim().replace(/\s+/g, '+')
    const searchUrl = `${HOST}search?s=${encodeURIComponent(searchQuery).replace(/%2B/g, '+')}`

    const desktopHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': HOST,
    }

    let items = []
    try {
      const html = await fetchHtml(searchUrl, undefined, desktopHeaders)
      if (html) {
        items = this._parseList(html)
        // Filter by requested type when one is specified.
        if (type && items.length) {
          const wantSeries = type === CONTENT_TYPES.SERIES
          items = items.filter(it =>
            wantSeries ? it.type === CONTENT_TYPES.SERIES : it.type === CONTENT_TYPES.MOVIE
          )
        }
      }
    } catch (e) {
      console.warn('[EntrePeliculasYSeries] search failed:', e?.message || e)
    }

    if (items.length) return items

    // Fallback: guess common slug patterns when the search returns no results or 403.
    return this._searchBySlug(query, type)
  },

  // Fallback slug-guessing search (used when the internal search is blocked).
  async _searchBySlug(query, type) {
    const slug = query.toLowerCase()
      .replace(/^(the|el|la|los|las|un|una)\s+/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

    const items = []
    const typePath = type === CONTENT_TYPES.SERIES ? 'serie' : 'pelicula'
    const urls = [
      `${HOST}${typePath}/${slug}`,
      `${HOST}${typePath}/${query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    ]

    for (const url of urls) {
      const html = await fetchHtml(url)
      if (!html || html.length < 500) continue

      const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || query
      const poster = findSingleMatch(html, '<img[^>]*src="(https://image\\.tmdb\\.org/[^"]*)"')

      items.push({
        id: `entrepeliculasyseries:${url}`,
        type: type === CONTENT_TYPES.SERIES ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title.replace(/\s*\|.*$/, '').trim()) || query,
        title: decodeEntities(title.replace(/\s*\|.*$/, '').trim()) || query,
        poster: poster || null,
        url,
        pluginId: 'plurtasko',
      })
      break
    }
    return items
  },
}
