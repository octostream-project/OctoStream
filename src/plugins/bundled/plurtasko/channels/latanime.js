// LatAnime channel — anime en castellano/latino/VOSE.
// Estructura verificada en vivo:
//   catalogo : /animes → cards <a href="/anime/slug"><div class="series">…<img>
//   busqueda : /buscar?q=query → mismas cards
//   episodios: /anime/slug → anchors /ver/slug-episodio-N
//   player   : /ver/…-episodio-N → <li|button data-player="BASE64(embedUrl)">
// El idioma va en el slug: -castellano, -latino, -subtitulado (sin sufijo = VOSE).

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'

const HOST = 'https://latanime.org/'

function decodePlayer(value) {
  try { return atob(value.replace(/\s/g, '')) } catch { return '' }
}

function langFromSlug(url) {
  if (/-castellano\b/i.test(url)) return 'ESP'
  if (/-latino\b/i.test(url)) return 'LAT'
  if (/-subtitulado\b/i.test(url) || /-vose\b/i.test(url)) return 'VOSE'
  return ''
}

export const latanime = {
  id: 'latanime',
  name: 'LatAnime',
  defaultLang: 'VOSE',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'latanime-series', name: 'LatAnime: Series', type: CONTENT_TYPES.ANIME },
  ],

  _parseItems(html) {
    html = cleanHtml(html)
    const items = []
    const seen = new Set()
    for (const m of findMultipleMatches(html, '<a href="([^"]+/anime/[^" ]*)"[^>]*>([\\s\\S]*?)</a>')) {
      const url = absoluteUrl(m[1], HOST)
      if (seen.has(url)) continue
      const block = m[2]
      let title = decodeEntities(
        findSingleMatch(block, '<h2[^>]*>(.*?)</h2>') ||
        findSingleMatch(block, '<h3[^>]*>(.*?)</h3>') ||
        findSingleMatch(block, 'title="([^"]+)"') ||
        findSingleMatch(block, 'alt="([^"]+)"')
      ).trim()
      const poster = findSingleMatch(block, 'src="([^"]+)"')
      if (!title) {
        const slug = url.replace(/^.*\/anime\//, '').replace(/-(castellano|latino|subtitulado|vose)$/, '')
        title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      }
      if (!title) continue
      seen.add(url)
      const isMovie = /-la-pelicula|-pelicula|-movie-|-ova\b/i.test(url)
      items.push({
        id: `latanime:${url}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.ANIME,
        name: title,
        title,
        poster: poster ? absoluteUrl(poster, HOST) : null,
        url,
        lang: langFromSlug(url),
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async getCatalog({ skip = 0, top = 50 }) {
    const html = await fetchHtml(`${HOST}animes`)
    return this._parseItems(html).slice(skip, skip + top)
  },

  async search({ query, type }) {
    const html = await fetchHtml(`${HOST}buscar?q=${encodeURIComponent(query).replace(/%20/g, '+')}`)
    const items = this._parseItems(html)
    return type && type !== CONTENT_TYPES.ANIME ? items.filter(i => i.type === type) : items
  },

  async getMeta({ id }) {
    const url = id.replace(/^latanime:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') ||
      findSingleMatch(html, '<title>(.*?)</title>') ||
      ''
    ).replace(/\s*[-–|].*Lat.?Anime.*$/i, '').trim() || url
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*thumbs[^"]*)"') || findSingleMatch(html, '<img[^>]*src="([^"]+)"')
    const isMovie = /-la-pelicula|-pelicula|-movie-/i.test(url)
    const meta = {
      id, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.ANIME,
      name: title, title, url,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      lang: langFromSlug(url),
      pluginId: 'plurtasko',
    }
    if (!isMovie) {
      const episodes = []
      const seen = new Set()
      for (const m of findMultipleMatches(html, 'href="([^"]*/ver/[^" ]*-episodio-(\\d+)[^" ]*)"')) {
        const epUrl = absoluteUrl(m[1], HOST)
        const episode = parseInt(m[2], 10)
        if (!episode || seen.has(episode)) continue
        seen.add(episode)
        episodes.push({ id: `latanime:${epUrl}`, name: `Episodio ${episode}`, season: 1, episode, url: epUrl })
      }
      episodes.sort((a, b) => a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id }) {
    let url = id.replace(/^latanime:/, '')
    let html = cleanHtml(await fetchHtml(url))
    if (!html) return []
    // Las películas enlazan el player desde la ficha; si la página no trae
    // data-player propio, seguir el primer enlace /ver/ del listado.
    if (!/data-player=/.test(html) && /\/anime\//.test(url)) {
      const ver = findSingleMatch(html, 'href="([^" ]*/ver/[^" ]*)"')
      if (ver) {
        url = absoluteUrl(ver, HOST)
        html = cleanHtml(await fetchHtml(url))
      }
    }
    const lang = langFromSlug(url) || 'VOSE'
    const streams = []
    const seen = new Set()
    for (const m of findMultipleMatches(html, 'data-player="([^"]+)"')) {
      const playerUrl = decodePlayer(m[1])
      if (!/^https?:/i.test(playerUrl) || seen.has(playerUrl)) continue
      seen.add(playerUrl)
      const server = (playerUrl.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)/i) || [])[1] || 'embed'
      streams.push({
        name: `${server} (${lang})`,
        url: playerUrl,
        streamType: normalizeServer('embed'),
        quality: '720',
        server,
        lang,
        pluginName: 'LatAnime',
        pluginId: 'plurtasko',
      })
    }
    return streams
  },

  // Últimos episodios publicados: portada de latanime.org, tarjetas
  // <a href="/ver/<slug>-episodio-N"> con alt "Título capitulo N" y data-src.
  async getLatestEpisodes({ top = 20, signal } = {}) {
    const html = await fetchHtml(HOST, signal)
    if (!html) return []
    const items = []
    const seen = new Set()
    const matches = findMultipleMatches(html, '<a href="(https?://[^"]*/ver/([a-z0-9-]+)-episodio-(\\d+))"[^>]*>([\\s\\S]*?)</a>')
    for (const m of matches) {
      const epUrl = m[1]
      const slug = m[2]
      const episode = parseInt(m[3], 10)
      const block = m[4]
      if (!episode || !slug || seen.has(epUrl)) continue
      seen.add(epUrl)
      const parentUrl = `${HOST}anime/${slug}`
      let title = decodeEntities(findSingleMatch(block, 'alt="([^"]+)"') || '')
        .replace(/\s*cap[ií]tulo\s*\d+\s*$/i, '').trim()
      const poster = findSingleMatch(block, 'data-src="([^"]+)"') || findSingleMatch(block, 'src="([^"]+)"')
      if (!title) {
        title = slug.replace(/-(castellano|latino|subtitulado|vose)$/, '').replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
      }
      items.push({
        id: `latanime:${parentUrl}`,
        type: CONTENT_TYPES.ANIME,
        name: `${title} E${episode}`,
        title,
        episode,
        poster: poster ? absoluteUrl(poster, HOST) : null,
        url: epUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(0, top)
  },
}
