// FlizzMovies channel - películas en español (Castellano, Latino, Vose)
// Estructura: /pelicula/slug, streams vía POST ajax=1&idF=ID → JSON {link}

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'

const HOST = 'https://flizzmovies.org/'

export const flizzmovies = {
  id: 'flizzmovies',
  name: 'FlizzMovies',
  types: [CONTENT_TYPES.MOVIE],
  host: HOST,

  catalogs: [
    { id: 'flizzmovies-movies', name: 'FlizzMovies: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    if (id !== 'flizzmovies-movies') return []
    const url = `${HOST}peliculas`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    // Cards: <a href="URL"><img data-src="POSTER"></a> ... <h3>TITLE</h3>
    const matches = findMultipleMatches(html, 'href="(https://flizzmovies\\.org/pelicula/[^"]+)"')
    const seen = new Set()
    for (const m of matches) {
      const itemUrl = m[1]
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)

      // Find poster near the link
      const thumbMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,300}?data-src="([^"]+)"`)
                   || findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,300}?src="([^"]+)"`)
      const poster = thumbMatch ? absoluteUrl(thumbMatch, HOST) : null

      // Title from slug
      const slug = itemUrl.split('/pelicula/')[1].replace(/_/g, ' ')
      const title = decodeEntities(slug.trim())

      items.push({
        id: `flizzmovies:${itemUrl}`,
        type: CONTENT_TYPES.MOVIE,
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
    const url = id.replace(/^flizzmovies:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>') || ''
    const cleanTitle = decodeEntities(title.replace(/\s*[|·].*$/, '').replace(/\s*Sub.*$/i, '').trim())
    const poster = findSingleMatch(html, '<img[^>]*data-src="([^"]*image\\.tmdb[^"]*)"')
                   || findSingleMatch(html, '<img[^>]*src="([^"]*image\\.tmdb[^"]*)"')
    const description = findSingleMatch(html, '<p[^>]*>(.*?)</p>') || ''
    const year = findSingleMatch(html, '(\\d{4})')

    return {
      id,
      type: CONTENT_TYPES.MOVIE,
      name: cleanTitle,
      title: cleanTitle,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }
  },

  async getStreams({ id }) {
    const url = id.replace(/^flizzmovies:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const streams = []
    // Find server options: <a class="option" data-id="ID"> ... data-server="NAME" data-lang="LANG"
    const serverMatches = findMultipleMatches(html, 'data-id="(\\d+)"[^>]*data-type="Reproductor"[^>]*data-lang="([^"]+)"[^>]*data-num="(\\d+)"[^>]*data-server="([^"]+)"')
    const seen = new Set()
    for (const m of serverMatches) {
      const dataId = m[1]
      const lang = m[2]
      const serverName = m[4].toLowerCase().trim()
      if (!dataId || seen.has(dataId)) continue
      seen.add(dataId)

      // Skip download-only/debrid servers
      if (/multiup|abyss|krakenfiles|rpmvid/.test(serverName)) continue

      try {
        // POST to get the actual link
        const resp = await postHtml(url, `ajax=1&idF=${dataId}`, null, {
          'Referer': url,
          'X-Requested-With': 'XMLHttpRequest',
        })
        if (!resp) continue

        let link = findSingleMatch(resp, '"link":"(.*?)"')
        if (!link) continue
        link = link.replace(/\\\//g, '/')
        if (!link || /\.esplay\./.test(link)) continue

        const server = this._detectServer(link) || serverName
        if (server) {
          let langLabel = ''
          if (/castellano|esp/i.test(lang)) langLabel = 'Esp'
          else if (/latino|lat/i.test(lang)) langLabel = 'Lat'
          else if (/sub|vose/i.test(lang)) langLabel = 'Vose'

          streams.push({
            name: `${server}${langLabel ? ` (${langLabel})` : ''}`,
            url: link,
            streamType: normalizeServer(server),
            quality: '',
            server,
            lang: langLabel,
            pluginName: 'FlizzMovies',
            pluginId: 'plurtasko',
          })
        }
      } catch {}
    }

    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/voe|voex/.test(u)) return 'voe'
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/upstream/.test(u)) return 'upstream'
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
    if (/turbovid|turboviplay/.test(u)) return 'turbovid'
    if (/vidara/.test(u)) return 'vidara'
    if (/byse/.test(u)) return 'byse'
    if (/fastream/.test(u)) return 'fastream'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    return ''
  },

  async search({ query, type }) {
    if (type !== CONTENT_TYPES.MOVIE) return []
    // FlizzMovies search: POST AJAX to home page with {s: query}
    const html = await postHtml(`${HOST}`, `s=${encodeURIComponent(query)}`, null, {
      'Referer': HOST,
      'X-Requested-With': 'XMLHttpRequest',
    })
    if (!html) return []

    const items = []
    const matches = findMultipleMatches(html, 'href="(https://flizzmovies\\.org/pelicula/[^"]+)"')
    const seen = new Set()
    for (const m of matches) {
      const itemUrl = m[1]
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)
      // Find title near the link
      const titleMatch = findSingleMatch(html, `href="${itemUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,200}?<h[1-6][^>]*>(.*?)</h`)
      const slug = itemUrl.split('/pelicula/')[1].replace(/_/g, ' ')
      const title = titleMatch ? decodeEntities(titleMatch.trim()) : decodeEntities(slug)
      items.push({
        id: `flizzmovies:${itemUrl}`,
        type: CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
