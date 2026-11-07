// Repelis28 channel — películas, series y anime en castellano/latino/VOSE.
// Estructura verificada en vivo (tema nfx-*):
//   catálogo  : /peliculas, /series → <div class="nfx-grid"> <a>cards</a>
//   búsqueda  : /?s=query → mismas cards
//   episodios : la ficha de serie enlaza /serie/slug#s{S}-e{E}; el player
//               carga GET /api/episodio/serie/{slug}/{S}/{E} → {html} con
//               <button data-url="/vidurl/…"> + iframe vidurl
//   películas : data-src="/vidurl/ttNNNN/" directo en la ficha
//   vidurl    : página del player Embed69 (PoW inline) — la resuelve
//               resolveEmbed69All() del resolver.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { resolveEmbed69All } from '../resolver.js'

const HOST = 'https://repelis28.org/'

function parseCards(html, typeFilter) {
  const grid = findSingleMatch(html, '<div class="nfx-grid">([\\s\\S]*?)</main>') || html
  const items = []
  const seen = new Set()
  for (const m of findMultipleMatches(grid, '<a([\\s\\S]*?)</a>')) {
    const block = m[1]
    const href = findSingleMatch(block, 'href="([^"]+)"')
    if (!href || seen.has(href)) continue
    let title = decodeEntities(
      findSingleMatch(block, '<h2 class="entry-title">([\\s\\S]*?)</h2>') ||
      findSingleMatch(block, 'alt="([^"]+)"') || ''
    ).replace(/Ver\s+/i, '').replace(/\s*-\s*(Pel[ií]cula|Serie|Anime)\s*completa.*$/i, '')
      .replace(/online en HD/i, '').trim()
    if (!title) continue
    const url = absoluteUrl(href, HOST)
    const isSeries = /\/serie\//.test(url) || /\/anime\//.test(url)
    if (typeFilter === CONTENT_TYPES.MOVIE && isSeries) continue
    if ((typeFilter === CONTENT_TYPES.SERIES || typeFilter === CONTENT_TYPES.ANIME) && !isSeries) continue
    const poster = findSingleMatch(block, 'src="([^"]+)"')
    const year = findSingleMatch(block, '<span class="(?:year|Year|Date)">([^<]+)</span>') ||
      findSingleMatch(block, '<small>(\\d{4})</small>')
    seen.add(href)
    items.push({
      id: `repelis28:${url}`,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      year: year ? parseInt(year, 10) || undefined : undefined,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      url,
      pluginId: 'plurtasko',
    })
  }
  return items
}

const emitFromVidurls = async (vidurls, signal) => {
  const streams = []
  const seen = new Set()
  for (const vurl of [...new Set(vidurls)].slice(0, 4)) {
    try {
      const servers = await resolveEmbed69All(vurl)
      for (const s of servers || []) {
        if (!s?.url || seen.has(s.url)) continue
        seen.add(s.url)
        const server = s.server || (s.url.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)/i) || [])[1] || 'embed'
        const lang = (s.lang || '').toUpperCase().startsWith('LAT') ? 'LAT'
          : (s.lang || '').toUpperCase().startsWith('ESP') || (s.lang || '').toUpperCase().startsWith('CAS') ? 'ESP'
          : (s.lang || '').toUpperCase().startsWith('SUB') ? 'VOSE' : ''
        streams.push({
          name: `${server} (${lang || 'embed69'})`,
          url: s.url,
          streamType: normalizeServer('embed'),
          quality: 'HD',
          server,
          lang,
          pluginName: 'Repelis28',
          pluginId: 'plurtasko',
        })
      }
    } catch { /* vidurl caído */ }
  }
  return streams
}

export const repelis28 = {
  id: 'repelis28',
  name: 'Repelis28',
  defaultLang: 'ESP',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'repelis28-movies', name: 'Repelis28: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'repelis28-series', name: 'Repelis28: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'repelis28-series' ? 'series' : 'peliculas'
    const page = Math.floor(skip / 30) + 1
    const html = await fetchHtml(`${HOST}${path}${page > 1 ? `?page=${page}` : ''}`)
    const typeFilter = id === 'repelis28-series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
    return parseCards(html, typeFilter).slice(skip % 30, skip % 30 + top)
  },

  async search({ query, type, signal }) {
    const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query).replace(/%20/g, '+')}`, signal)
    return parseCards(html, type)
  },

  async getMeta({ id }) {
    const url = id.replace(/^repelis28:/, '').split('#')[0]
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>([\\s\\S]*?)</h1>') ||
      findSingleMatch(html, 'property="og:title"[^>]*content="([^"]+)"') || ''
    ).replace(/\s*[-–|].*(Repelis|repelis).*$/i, '').trim() || url
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
      // Episodios: anchors /serie/slug#s{S}-e{E} con nfx-ep-num / nfx-ep-title
      const episodes = []
      const seen = new Set()
      for (const m of findMultipleMatches(html, 'href="([^"#]*#s(\\d+)-e(\\d+))"')) {
        const s = parseInt(m[2], 10)
        const e = parseInt(m[3], 10)
        const key = `${s}x${e}`
        if (!s || !e || seen.has(key)) continue
        seen.add(key)
        const epUrl = absoluteUrl(m[1], HOST)
        episodes.push({
          id: `repelis28:${epUrl}`,
          name: `Episodio ${e}`,
          season: s,
          episode: e,
          url: epUrl,
        })
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id, signal }) {
    const raw = id.replace(/^repelis28:/, '')
    const hash = raw.match(/#s(\d+)-e(\d+)/)
    const vidurls = []
    if (hash) {
      // Serie: pedir el html del episodio por la API interna
      const pageUrl = raw.split('#')[0]
      const slug = pageUrl.replace(/^https?:\/\/[^/]+\/(?:serie|anime)\//i, '').replace(/\/+$/, '')
      const type = /\/anime\//i.test(pageUrl) ? 'anime' : 'serie'
      try {
        const res = await fetchHtml(`${HOST}api/episodio/${type}/${slug}/${hash[1]}/${hash[2]}`, signal)
        const data = JSON.parse(res)
        const epHtml = data?.html || ''
        for (const m of findMultipleMatches(epHtml, 'data-url="(/vidurl/[^"]+)"')) vidurls.push(absoluteUrl(m[1], HOST))
        for (const m of findMultipleMatches(epHtml, 'src="(/vidurl/[^"]+)"')) vidurls.push(absoluteUrl(m[1], HOST))
      } catch { /* api caída */ }
    } else {
      // Película: data-src="/vidurl/…" en la propia ficha
      const html = cleanHtml(await fetchHtml(raw, signal))
      if (!html) return []
      for (const m of findMultipleMatches(html, 'data-src="(/vidurl/[^"]+)"')) vidurls.push(absoluteUrl(m[1], HOST))
    }
    return emitFromVidurls(vidurls, signal)
  },
}
