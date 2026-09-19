// SubTorrents channel — torrent site (Spanish). Ported from Balandro's
// subtorrents.py. Episode/movie download anchors carry data-src="BASE64"
// (single-layer base64 of the .torrent URL, sometimes on an old domain —
// rewritten to the current host) next to an obfuscated s.php href.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, absoluteUrl, decodeEntities, makeHostRotator, makeHtmlFetcher } from '../http.js'
import { findSingleMatch, findMultipleMatches, baseTitle, makeTorrentStream, isSerieUrl } from '../scraper.js'
import { extractQualityFromText } from '../meta.js'

const HOSTS = [
  'https://www1.subtorrents.zip/',
  'https://www.subtorrents.nl/',
  'https://www.subtorrents.in/',
]
const rotator = makeHostRotator(HOSTS)

const fetchHost = makeHtmlFetcher(rotator, fetchHtml)

// data-src="BASE64" → .torrent URL. Decoded links may point at a retired
// domain — rewrite them to the host that actually answered.
function decodeDataSrc(b64) {
  try {
    const url = atob(b64)
    if (!/^https?:/i.test(url)) return null
    const path = url.replace(/^https?:\/\/[^/]+/i, '')
    return rotator.working.replace(/\/$/, '') + path
  } catch { return null }
}

export const subtorrents = {
  id: 'subtorrents',
  name: 'SubTorrents',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOSTS[0],

  catalogs: [
    { id: 'subtorrents-movies', name: 'SubTorrents: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'subtorrents-series', name: 'SubTorrents: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const { html, host } = await fetchHost(id === 'subtorrents-series' ? 'series/' : 'peliculas/')
    if (!html) return []
    return parseSearchRows(html, host).slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^subtorrents:/, '')
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

    if (isSeries) meta.episodes = parseEpisodeRows(html, url)
    return meta
  },

  async getStreams({ id, season, episode }) {
    const pageUrl = id.replace(/^subtorrents:/, '')

    // Episode ids embed the decoded torrent: "subtorrents:{.torrent url}"
    if (/\.torrent(?:[?#]|$)/i.test(pageUrl)) {
      return [makeStream(pageUrl, 'HDTV')]
    }

    const html = await fetchHtml(pageUrl)
    if (!html) return []
    const isSeries = isSerieUrl(pageUrl)

    if (isSeries) {
      const rows = parseEpisodeRows(html, pageUrl)
      const row = (season != null && episode != null)
        ? rows.find(r => r.season === season && r.episode === episode)
        : rows[0]
      if (!row) return []
      return [makeStream(row.torrent, 'HDTV', row.name)]
    }

    // Movie page: prefer direct .torrent hrefs, else data-src b64.
    const streams = []
    const seen = new Set()
    const direct = findMultipleMatches(html, /href="([^"]+\.torrent[^"]*)"/i)
    for (const d of direct) {
      const u = d[1]
      if (seen.has(u)) continue
      seen.add(u)
      streams.push(makeStream(u, extractQualityFromText(decodeURIComponent(u)) || 'HD'))
    }
    if (streams.length === 0) {
      const encoded = findMultipleMatches(html, /data-src="([A-Za-z0-9+/=]{40,})"/)
      for (const d of encoded) {
        const u = decodeDataSrc(d[1])
        if (!u || !/\.torrent/i.test(u) || seen.has(u)) continue
        seen.add(u)
        streams.push(makeStream(u, extractQualityFromText(decodeURIComponent(u)) || 'HD'))
      }
    }
    return streams
  },

  async search({ query, type }) {
    const wantsSeries = type === CONTENT_TYPES.SERIES || type === CONTENT_TYPES.DORAMA || type === CONTENT_TYPES.ANIME
    const { html, host } = await fetchHost(`?s=${encodeURIComponent(query).replace(/%20/g, '+')}`)
    if (!html) return []

    const items = []
    for (const card of parseSearchRows(html, host)) {
      const isSeries = isSerieUrl(card.url)
      if (type === CONTENT_TYPES.MOVIE && isSeries) continue
      if (wantsSeries && !isSeries) continue
      const { base, season } = baseTitle(card.name)
      items.push({
        id: `subtorrents:${card.url}`,
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

// Search/catalog rows: <td class="vertThseccion">…<a href="URL" title="T">…
// <td>DATE</td><td> </td><td>QUALITY</td></tr>
function parseSearchRows(html, host) {
  const items = []
  const seen = new Set()
  const rows = findMultipleMatches(html, /<td class="vertThseccion">([\s\S]*?)<\/tr>/)
  for (const r of rows) {
    const block = r[1]
    const link = findMultipleMatches(block, /<a href="([^"]+)"[^>]*title="([^"]+)"/)[0]
    if (!link) continue
    const url = absoluteUrl(link[1], host)
    if (seen.has(url)) continue
    seen.add(url)
    const cells = findMultipleMatches(block, /<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)
    const quality = cells.length ? decodeEntities(cells[cells.length - 1][1].replace(/<[^>]+>/g, '').trim()) : ''
    items.push({
      url,
      name: decodeEntities(link[2]).trim(),
      poster: null,
      quality,
    })
  }
  return items
}

// Serie page episode rows: anchor with data-src="b64" and title="Name SxEE".
function parseEpisodeRows(html, pageUrl) {
  const episodes = []
  const rows = findMultipleMatches(html,
    /data-src="([A-Za-z0-9+/=]{40,})"[^>]*title="([^"]*?(\d+)x(\d+)[^"]*)"/)
  for (const m of rows) {
    const torrent = decodeDataSrc(m[1])
    if (!torrent) continue
    const season = parseInt(m[3], 10)
    const episode = parseInt(m[4], 10)
    episodes.push({
      id: `subtorrents:${torrent}`,
      name: `${decodeEntities(m[2]).trim()}`,
      season,
      episode,
      torrent,
    })
  }
  return episodes
}

const makeStream = (torrentUrl, quality, title) => makeTorrentStream('SubTorrents', torrentUrl, quality, title)
