// SoloLatino channel — películas y series en castellano/latino/VOSE.
// Portado de Balandro sololatino.py:
//   cards     : <div class="card">…</div></div></a> con href + img
//   episodios : bloques data-season-panel="{S}" → <a href> + <p class="ep-num">E{n}</p>
//   player    : data-player-id / data-server-url / data-player-token →
//               POST /api/player-url {t: token} → URL player →
//               /player.pelisserieshoy.com/ ≡ embed69.org (PoW) → resolveEmbed69All.
//   langs     : data-lang 0=LAT 1=ESP 2=VOSE 3=JAP

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postJson, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'
import { resolveEmbed69All } from '../resolver.js'

const HOST = 'https://sololatino.net/'

const LANG_BY_ID = { 0: 'LAT', 1: 'ESP', 2: 'VOSE', 3: 'JAP' }

function pushItem(items, seen, url, title, poster, typeFilter) {
  if (!url || !title || seen.has(url)) return
  const isSeries = /\/serie\//.test(url) || /\/anime\//.test(url)
  if (typeFilter === CONTENT_TYPES.MOVIE && isSeries) return
  if (typeFilter === CONTENT_TYPES.SERIES && !isSeries) return
  seen.add(url)
  items.push({
    id: `sololatino:${url}`,
    type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
    name: title.trim(),
    title: title.trim(),
    poster: poster ? absoluteUrl(poster, HOST) : null,
    url,
    pluginId: 'plurtasko',
  })
}

function parseCards(html, typeFilter) {
  const items = []
  const seen = new Set()
  // 1. JSON-LD ItemList (catálogo y listados SSR):
  //    itemListElement [{url,name,image}]
  for (const m of findMultipleMatches(html, '"url":"(https?:[^"]*sololatino\\.net/(?:pelicula|serie|anime)/[^"]+)"[\\s\\S]*?"name":"([^"]+)"[\\s\\S]*?"image":"([^"]*)"')) {
    const url = m[1].replace(/\\\//g, '/')
    pushItem(items, seen, url, decodeEntities(m[2]), m[3].replace(/\\\//g, '/'), typeFilter)
  }
  // 2. Anchors a fichas (búsqueda y páginas sin JSON-LD)
  for (const m of findMultipleMatches(html, 'href="(https?:\\/\\/sololatino\\.net\\/(?:pelicula|serie|anime)\\/[a-z0-9-]+)"([\\s\\S]{0,600}?)</a>')) {
    const url = m[1]
    if (seen.has(url)) continue
    const near = m[2] || ''
    const title = decodeEntities(
      findSingleMatch(near, 'alt="([^"]+)"') ||
      findSingleMatch(near, '<h[23][^>]*>([\\s\\S]*?)</h[23]>') || ''
    ).replace(/<[^>]+>/g, '').trim()
    const poster = findSingleMatch(near, 'src="([^"]+)"') || findSingleMatch(near, 'data-src="([^"]+)"')
    const slug = url.replace(/^.*\/(?:pelicula|serie|anime)\//, '').replace(/\/+$/, '')
    pushItem(items, seen, url, title || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), poster, typeFilter)
  }
  return items
}

async function playerUrlsFrom(html, referer, signal) {
  const urls = new Set()
  // iframes directos
  for (const m of findMultipleMatches(html, '<iframe[^>]*src="([^"]+)"')) {
    const u = m[1]
    if (/youtube|googletagmanager|facebook/i.test(u)) continue
    urls.add(absoluteUrl(u, HOST))
  }
  // tokens de player → POST api/player-url (puede fallar por CSRF; abajo
  // va el fallback de Balandro: embed69.org/f/tt{imdbId} directo).
  const tokens = []
  for (const m of findMultipleMatches(html, 'data-(?:player-id|server-url|player-token)="([^"]+)"')) {
    if (!tokens.includes(m[1])) tokens.push(m[1])
  }
  for (const t of tokens.slice(0, 3)) {
    if (/iframe|player|embed/i.test(t)) { urls.add(absoluteUrl(t, HOST)); continue }
    try {
      const res = await postJson(`${HOST}api/player-url`, { t }, signal, { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' })
      const u = typeof res === 'string' ? res : (res?.url || res?.player_url || res?.data || '')
      if (u) urls.add(absoluteUrl(u.replace(/\\\//g, '/'), HOST))
    } catch { /* CSRF/token caído → fallback imdb */ }
  }
  // Fallback: la página lleva el imdbId en /title/ttNNN → embed69 directo
  const imdb = findSingleMatch(html, '/title/tt(\\d+)')
  if (imdb) urls.add(`https://embed69.org/f/tt${imdb}`)
  return [...urls]
}

const emitEmbed69 = async (urls, signal) => {
  const streams = []
  const seen = new Set()
  for (let u of urls) {
    if (/\/player\.pelisserieshoy\.com\//i.test(u)) u = u.replace('/player.pelisserieshoy.com/', '/embed69.org/')
    try {
      const servers = await resolveEmbed69All(u)
      for (const s of servers || []) {
        if (!s?.url || seen.has(s.url)) continue
        seen.add(s.url)
        const server = s.server || (s.url.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)/i) || [])[1] || 'embed'
        const raw = (s.lang || '').toUpperCase()
        const lang = raw.startsWith('LAT') ? 'LAT' : raw.startsWith('ESP') || raw.startsWith('CAS') ? 'ESP' : raw.startsWith('SUB') ? 'VOSE' : ''
        streams.push({
          name: `${server} (${lang || 'embed69'})`,
          url: s.url,
          streamType: normalizeServer('embed'),
          quality: 'HD',
          server,
          lang,
          pluginName: 'SoloLatino',
          pluginId: 'plurtasko',
        })
      }
    } catch { /* player caído */ }
  }
  return streams
}

export const sololatino = {
  id: 'sololatino',
  name: 'SoloLatino',
  defaultLang: 'LAT',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'sololatino-movies', name: 'SoloLatino: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'sololatino-series', name: 'SoloLatino: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'sololatino-series' ? 'series' : 'peliculas'
    const page = Math.floor(skip / 24) + 1
    const html = await fetchHtml(`${HOST}${path}${page > 1 ? `?page=${page}` : ''}`)
    const typeFilter = id === 'sololatino-series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
    return parseCards(html, typeFilter).slice(skip % 24, skip % 24 + top)
  },

  async search({ query, type, signal }) {
    const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query).replace(/%20/g, '+')}`, signal)
    return parseCards(html, type)
  },

  async getMeta({ id }) {
    const url = id.replace(/^sololatino:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>([\\s\\S]*?)</h1>') ||
      findSingleMatch(html, 'property="og:title"[^>]*content="([^"]+)"') || ''
    ).replace(/\s*[-–|].*$/,'').trim() || url
    const poster = findSingleMatch(html, 'property="og:image"[^>]*content="([^"]+)"') ||
      findSingleMatch(html, 'data-image="([^"]+)"') ||
      findSingleMatch(html, '<img[^>]*src="([^"]+)"')
    const isSeries = /\/serie\//.test(url) || /\/anime\//.test(url)
    const meta = {
      id, type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title, title, url,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      pluginId: 'plurtasko',
    }
    if (isSeries) {
      const episodes = []
      const seen = new Set()
      for (const sm of findMultipleMatches(html, 'data-season-panel="(\\d+)"([\\s\\S]*?)(?:data-season-panel="\\d+"|$)')) {
        const s = parseInt(sm[1], 10) || 1
        for (const em of findMultipleMatches(sm[2], '<a href="([^"]+)"[\\s\\S]*?ep-num">E(\\d+)</p>')) {
          const e = parseInt(em[2], 10)
          const key = `${s}x${e}`
          if (!e || seen.has(key)) continue
          seen.add(key)
          const epUrl = absoluteUrl(em[1], HOST)
          episodes.push({ id: `sololatino:${epUrl}`, name: `Episodio ${e}`, season: s, episode: e, url: epUrl })
        }
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id, signal }) {
    const url = id.replace(/^sololatino:/, '')
    const html = cleanHtml(await fetchHtml(url, signal))
    if (!html) return []
    const urls = await playerUrlsFrom(html, url, signal)
    return emitEmbed69(urls, signal)
  },
}
