// DonTorrent channel — torrent site (Spanish). Ported from Balandro's
// dontorrents.py. The site rotates domains; mirror.pm hosts the current one.
// Downloads are gated behind a SHA-256 proof-of-work (api_validate_pow.php):
// POST {action:'generate', content_id, tabla} → challenge, then find nonce with
// sha256(challenge+nonce) starting with '000', then POST validate → download_url
// pointing at the .torrent file. Streams are emitted as streamType 'torrent'
// (resolved via debrid when configured, or the local P2P engine on Android).

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, postJson, absoluteUrl, decodeEntities, makeHostRotator, makeHtmlFetcher } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectType, baseTitle as baseTitleOf } from '../scraper.js'
import { extractQualityFromText, detectLangFromText } from '../meta.js'

// Working hosts in order of preference. dontorrent.supply is the current
// official domain (may be ISP-blocked); mirror.pm is the fallback mirror and
// its numeric id rotates over time.
const HOSTS = [
  'https://dontorrent.supply/',
  'https://4144-don.mirror.pm/',
  'https://www21.dontorrent.link/',
]
const rotator = makeHostRotator(HOSTS)

// Fetch with host fallback: if the cached host fails, try the rest.
const fetchHost = makeHtmlFetcher(rotator, fetchHtml)

const postToHost = (path, body, signal, isJson) => rotator.rotate(
  h => isJson ? postJson(h + path, body, signal) : postHtml(h + path, body, signal),
  r => !!r && (typeof r !== 'string' || r.length > 200))

// SHA-256 hex digest
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Solve the download proof-of-work and return the .torrent URL.
// Iterates the host list so a rotated domain doesn't kill the stream.
async function solvePowDownload(contentId, tabla, signal) {
  const { res } = await rotator.rotate(async (host) => {
    const gen = await postJson(`${host}api_validate_pow.php/`, {
      action: 'generate', content_id: contentId, tabla,
    }, signal)
    if (!gen?.success || !gen.challenge) return null
    let nonce = -1
    for (let n = 0; n < 500000; n++) {
      if (signal?.aborted) return null
      if ((await sha256hex(gen.challenge + n)).startsWith('000')) { nonce = n; break }
    }
    if (nonce < 0) return null

    const val = await postJson(`${host}api_validate_pow.php/`, {
      action: 'validate', challenge: gen.challenge, nonce: String(nonce), unescape: 'False',
    }, signal)
    return val?.success && val.download_url ? absoluteUrl(val.download_url, host) : null
  })
  return res
}

// content_id/tabla from a detail page, falling back to the numeric id in the URL.
async function contentIdFor(url, signal) {
  const path = url.replace(/^https?:\/\/[^/]+/i, '')
  const isSerie = path.startsWith('/serie/')
  const html = await fetchHtml(url, signal)
  // Pelicula pages carry a single download button; serie pages carry one per
  // episode row — for those the caller passes the row's own content-id.
  const cid = findMultipleMatches(html, /data-content-id="(\d+)" data-tabla="(\w+)"/)[0]
  if (cid) return { contentId: parseInt(cid[1], 10), tabla: cid[2], html }
  const m = path.match(/\/pelicula\/(\d+)\//)
  if (m) return { contentId: parseInt(m[1], 10), tabla: 'peliculas', html }
  const ms = path.match(/\/serie\/\d+\/(\d+)\//)
  if (ms) return { contentId: parseInt(ms[1], 10), tabla: 'series', html }
  return { contentId: 0, tabla: isSerie ? 'series' : 'peliculas', html }
}

export const dontorrent = {
  id: 'dontorrent',
  name: 'DonTorrent',
  defaultLang: 'Esp',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOSTS[0],

  catalogs: [
    { id: 'dontorrent-movies', name: 'DonTorrent: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'dontorrent-movies4k', name: 'DonTorrent: Películas 4K', type: CONTENT_TYPES.MOVIE },
    { id: 'dontorrent-series', name: 'DonTorrent: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'dontorrent-movies4k' ? 'peliculas/4k'
      : id === 'dontorrent-series' ? 'series'
      : 'peliculas'
    const { html, host } = await fetchHost(path)
    if (!html) return []

    const items = []
    const cards = findMultipleMatches(html, /<a href=["'](\/(?:pelicula|serie)\/[^"']+)["'][^>]*><img[^>]*src=["']([^"']+)["']/)
    for (const m of cards.slice(skip, skip + top)) {
      const itemUrl = absoluteUrl(m[1], host)
      const poster = m[2]
      const slug = m[1].split('/').pop() || ''
      const title = decodeEntities(slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim())
      const quality = extractQualityFromText(decodeURIComponent(poster)) || extractQualityFromText(slug)
      const itemType = detectType(itemUrl)
      items.push({
        id: `dontorrent:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title + (quality ? ` [${quality}]` : ''),
        title,
        poster: poster.startsWith('//') ? 'https:' + poster : poster,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async getMeta({ id }) {
    const url = id.replace(/^dontorrent:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, /<h2[^>]*>([^<]{3,120})<\/h2>/)
      || findSingleMatch(html, /og:title[^>]*content="Descargar ([^"]+?) Torrent/i)
      || ''
    const poster = findSingleMatch(html, /og:image[^>]*content="([^"]+)"/)
    const description = findSingleMatch(html, /<p class="text-justify[^>]*>[\s\S]*?Descripci[oó]n:\s*([\s\S]*?)<\/p>/)
    const isSeries = /\/serie\//.test(url)

    const meta = {
      id,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: decodeEntities(title.replace('Descargar Torrents', '').trim()),
      title: decodeEntities(title.replace('Descargar Torrents', '').trim()),
      poster: poster || null,
      description: decodeEntities(description || ''),
      url,
      pluginId: 'plurtasko',
    }

    if (isSeries) {
      // Rows: <td>NxNN</td> <td><a … data-content-id="NNN" data-tabla="series">
      // (no episode titles on this site — just the SxEE cell, the download
      // link in the same row, then air date and password cells).
      const episodes = []
      const rows = findMultipleMatches(html,
        /<td[^>]*>\s*(\d+)x(\d+)\s*<\/td>[\s\S]*?data-content-id="(\d+)"\s+data-tabla="series"/)
      for (const m of rows) {
        const season = parseInt(m[1], 10)
        const episode = parseInt(m[2], 10)
        episodes.push({
          id: `dontorrent:${url}#cid=${m[3]}`,
          name: `${season}x${String(episode).padStart(2, '0')}`,
          season,
          episode,
        })
      }
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id, season, episode }) {
    // Episode ids carry the per-row content-id: "dontorrent:URL#cid=NNN"
    const cidMatch = id.match(/#cid=(\d+)/)
    let contentId, tabla, pageUrl
    if (cidMatch) {
      contentId = parseInt(cidMatch[1], 10)
      tabla = 'series'
      pageUrl = id.replace(/^dontorrent:/, '').replace(/#cid=\d+$/, '')
    } else {
      pageUrl = id.replace(/^dontorrent:/, '')
      const info = await contentIdFor(pageUrl)
      if (!info.contentId) return []
      contentId = info.contentId
      tabla = info.tabla
      // Serie page + requested episode: pick that episode's row instead of
      // the first download link. Strict: if the SxEE row isn't on this page
      // (wrong temporada or missing episode), return nothing rather than
      // playing the wrong episode.
      if (tabla === 'series' && season != null && episode != null) {
        const rows = findMultipleMatches(info.html,
          /<td[^>]*>\s*(\d+)x(\d+)\s*<\/td>[\s\S]*?data-content-id="(\d+)"\s+data-tabla="series"/)
        const row = rows.find(r => parseInt(r[1], 10) === season && parseInt(r[2], 10) === episode)
        if (!row) return []
        contentId = parseInt(row[3], 10)
      }
    }

    const torrentUrl = await solvePowDownload(contentId, tabla)
    if (!torrentUrl) return []

    // Quality hints live in the slug and page title ([4K], [DVDRip], [1080p]…)
    const slug = decodeURIComponent(pageUrl.split('/').pop() || '')
    const quality = extractQualityFromText(slug) || 'HD'
    // El idioma sale del nombre del release (latino/vose/dual/castellano);
    // sin pista en el slug queda sin etiqueta en vez de asumir castellano.
    const lang = detectLangFromText(slug)
    return [{
      name: `DonTorrent${lang ? ` (${lang})` : ''} ${quality}`,
      url: torrentUrl,
      streamType: 'torrent',
      quality,
      server: 'DonTorrent',
      lang,
      title: slug.replace(/-/g, ' '),
      pluginName: 'DonTorrent',
      pluginId: 'plurtasko',
    }]
  },

  async search({ query, type }) {
    const { res: html, host } = await postToHost('buscar', `valor=${encodeURIComponent(query)}`)
    if (!html) return []

    const items = []
    const seen = new Set()
    // The site wraps the matched query term in <span class="text-secondary">…
    // inside the anchor, so capture the whole anchor body and strip tags.
    const matches = findMultipleMatches(html,
      /<a href='(\/(?:pelicula|serie|documental)\/[^']+)'[^>]*class="text-decoration-none"[^>]*>([\s\S]*?)<\/a>/)
    for (const m of matches) {
      const itemUrl = absoluteUrl(m[1], host)
      if (seen.has(itemUrl)) continue
      seen.add(itemUrl)
      const fullTitle = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim())
      if (!fullTitle) continue
      const itemType = detectType(itemUrl)
      if (type === CONTENT_TYPES.MOVIE && itemType !== 'movie') continue
      if ((type === CONTENT_TYPES.SERIES || type === CONTENT_TYPES.DORAMA || type === CONTENT_TYPES.ANIME) && itemType !== 'series') continue
      // Base title for strict matching: strip "- Nª Temporada", "[720p]",
      // "(4K)" and trailing punctuation so "Reacher" != "Preacher".
      const { base, season } = baseTitleOf(fullTitle)
      items.push({
        id: `dontorrent:${itemUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: fullTitle,
        title: base,
        season,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
