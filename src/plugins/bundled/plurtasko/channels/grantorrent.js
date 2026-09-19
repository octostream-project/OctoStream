// GranTorrent channel — torrent site (Spanish). Ported from Balandro's
// grantorrent.py. Download links are obfuscated: s.php?i=BASE64 where the
// payload is the .torrent URL base64-encoded several times and finally
// ROT13'd (uggcf:// → https://). Emitted as streamType 'torrent'.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, absoluteUrl, decodeEntities, makeHostRotator, makeHtmlFetcher } from '../http.js'
import { findSingleMatch, findMultipleMatches, baseTitle, makeTorrentStream, isSerieUrl } from '../scraper.js'
import { extractQualityFromText } from '../meta.js'

const HOSTS = [
  'https://grantorrent.foo/',
  'https://grantorrent.mov/',
  'https://grantorrent.net/',
  'https://grantorrent.one/',
]
const rotator = makeHostRotator(HOSTS)

const fetchHost = makeHtmlFetcher(rotator, fetchHtml)

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, c =>
    String.fromCharCode((c <= 'Z' ? 65 : 97) + (c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26))
}

// s.php?i=BASE64 → base64 ×N → rot13 → https://…/*.torrent
function decodeProtectedUrl(url) {
  const m = String(url || '').match(/[?&](?:i|urlb64|u)=([A-Za-z0-9+/=_-]+)/)
  if (!m) return null
  let s = m[1]
  for (let i = 0; i < 8; i++) {
    if (/^https?:/i.test(s)) break
    if (/^uggcf:/i.test(s)) { s = rot13(s); break }
    try {
      s = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
    } catch { return null }
  }
  if (!/^https?:/i.test(s)) return null
  // Site params like &st=gtn ride after the real .torrent filename.
  const t = s.indexOf('.torrent')
  if (t > 0) s = s.slice(0, t + 8)
  return s
}

// Any obfuscated/protected href → final .torrent URL (or null).
function torrentFromHref(href) {
  if (!href) return null
  if (/\.torrent(?:[?#]|$)/i.test(href)) return href
  if (/s\.php\?/i.test(href)) return decodeProtectedUrl(href)
  return null
}

export const grantorrent = {
  id: 'grantorrent',
  name: 'GranTorrent',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOSTS[0],

  catalogs: [
    { id: 'grantorrent-movies', name: 'GranTorrent: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'grantorrent-series', name: 'GranTorrent: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const { html, host } = await fetchHost(id === 'grantorrent-series' ? 'series_p/' : 'peliculas/')
    if (!html) return []
    return parseCards(html, host).slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^grantorrent:/, '')
    const html = await fetchHtml(url)
    if (!html) return null
    const isSeries = isSerieUrl(url)

    const title = findSingleMatch(html, /<h1[^>]*>([^<]{3,140})<\/h1>/)
      || findSingleMatch(html, /og:title[^>]*content="([^"]+?)"/)
      || ''
    const poster = findSingleMatch(html, /og:image[^>]*content="([^"]+)"/)

    const meta = {
      id,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: decodeEntities(title).trim(),
      title: decodeEntities(title).trim(),
      poster: poster || null,
      url,
      pluginId: 'plurtasko',
    }

    if (isSeries) {
      meta.episodes = parseEpisodeRows(html, url)
    }
    return meta
  },

  async getStreams({ id, season, episode }) {
    const pageUrl = id.replace(/^grantorrent:/, '')

    // Episode ids carry the row's own protected link: "grantorrent:{s.php url}"
    if (/s\.php\?/i.test(pageUrl)) {
      const torrentUrl = decodeProtectedUrl(pageUrl)
      if (!torrentUrl) return []
      return [makeStream(torrentUrl, 'HD')]
    }

    const html = await fetchHtml(pageUrl)
    if (!html) return []
    const isSeries = isSerieUrl(pageUrl)

    if (isSeries) {
      // Strict: only the requested SxEE row, never another episode.
      const rows = parseEpisodeRows(html, pageUrl)
      const row = (season != null && episode != null)
        ? rows.find(r => r.season === season && r.episode === episode)
        : rows[0]
      if (!row) return []
      const torrentUrl = decodeProtectedUrl(row.link)
      return torrentUrl ? [makeStream(torrentUrl, row.quality || 'HDTV', row.name)] : []
    }

    // Movie page: every <tr> carries a quality cell + a protected download.
    const streams = []
    const seen = new Set()
    const rows = findMultipleMatches(html, /<tr[^>]*>([\s\S]*?)<\/tr>/)
    for (const r of rows) {
      const row = r[1]
      const href = findSingleMatch(row, /href="([^"]*(?:\.torrent|s\.php)[^"]*)"/i)
      const torrentUrl = torrentFromHref(href)
      if (!torrentUrl || seen.has(torrentUrl)) continue
      seen.add(torrentUrl)
      const cells = findMultipleMatches(row, /<td[^>]*>([\s\S]*?)<\/td>/)
      const quality = extractQualityFromText(cells.map(c => c[1].replace(/<[^>]+>/g, '')).join(' ')) || 'HD'
      streams.push(makeStream(torrentUrl, quality))
    }
    return streams
  },

  async search({ query, type }) {
    const wantsSeries = type === CONTENT_TYPES.SERIES || type === CONTENT_TYPES.DORAMA || type === CONTENT_TYPES.ANIME
    const path = `?s=${encodeURIComponent(query).replace(/%20/g, '+')}${wantsSeries ? '&filtro=series' : ''}`
    const { html, host } = await fetchHost(path)
    if (!html) return []

    const items = []
    for (const card of parseCards(html, host)) {
      const isSeries = isSerieUrl(card.url)
      if (type === CONTENT_TYPES.MOVIE && isSeries) continue
      if (wantsSeries && !isSeries) continue
      const { base, season } = baseTitle(card.name)
      items.push({
        id: `grantorrent:${card.url}`,
        type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: card.name + (card.quality ? ` [${card.quality}]` : ''),
        title: base,
        season,
        poster: card.poster,
        url: card.url,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}

// Cards on search/catalog pages: <div class="relative my-5 md:my-4"> … </p></div></div>
function parseCards(html, host) {
  const items = []
  const cards = findMultipleMatches(html,
    /<div class="relative my-5 md:my-4">([\s\S]*?)(?=<div class="relative my-5 md:my-4">|<\/section>)/)
  for (const c of cards) {
    const block = c[1]
    const href = findSingleMatch(block, /<a href="([^"]+)"/)
    const title = findSingleMatch(block, /alt="([^"]+)"/)
    if (!href || !title) continue
    const img = findSingleMatch(block, /src="([^"]+)"/)
    const quality = findSingleMatch(block, /text-center">\s*<span>([^<]*)<\/span>/)
    items.push({
      url: absoluteUrl(href, host),
      name: decodeEntities(title).trim(),
      poster: img || null,
      quality: decodeEntities(quality || '').trim(),
    })
  }
  return items
}

// Serie page episode rows: <tr class="episode-…">…<td>SxE</td>…<a href="s.php">
function parseEpisodeRows(html, pageUrl) {
  const episodes = []
  const rows = findMultipleMatches(html,
    /episode-[\s\S]*?<td[^>]*>\s*(\d+)x(\d+)\s*<\/td>[\s\S]*?<a href="([^"]+)"/)
  for (const m of rows) {
    const season = parseInt(m[1], 10)
    const episode = parseInt(m[2], 10)
    episodes.push({
      id: `grantorrent:${m[3]}`,
      name: `${season}x${String(episode).padStart(2, '0')}`,
      season,
      episode,
      link: m[3],
    })
  }
  return episodes
}

const makeStream = (torrentUrl, quality, title) => makeTorrentStream('GranTorrent', torrentUrl, quality, title)
