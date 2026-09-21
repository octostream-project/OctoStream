import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://vww.monoschinos2.net/'

function decodePlayer(value) {
  try { return atob(value.replace(/\s/g, '')) } catch { return '' }
}

export const monoschinos = {
  id: 'monoschinos',
  name: 'MonosChinos',
  defaultLang: 'VOSE',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'monoschinos-series', name: 'MonosChinos: Series', type: CONTENT_TYPES.ANIME },
    { id: 'monoschinos-movies', name: 'MonosChinos: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async _parseItems(html) {
    html = cleanHtml(html)
    const items = []
    const matches = findMultipleMatches(html, '<li[^>]*class="[^"]*ficha_efecto[^"]*"[^>]*>([\\s\\S]*?)</li>')
    for (const m of matches) {
      const block = m[1]
      const href = findSingleMatch(block, 'href="([^"]+/anime/[^" ]*)"')
      const title = decodeEntities(findSingleMatch(block, 'alt="([^"]+)"') || findSingleMatch(block, '<h3[^>]*>(.*?)</h3>')).trim()
      if (!href || !title) continue
      const url = absoluteUrl(href, HOST)
      const isMovie = /-movie-|tipo=pelicula|pelicula/i.test(url) || /pel[ií]cula/i.test(block)
      const poster = findSingleMatch(block, 'data-src="([^"]+)"') || findSingleMatch(block, 'src="([^"]+)"')
      items.push({ id: `monoschinos:${url}`, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, poster: poster ? absoluteUrl(poster, HOST) : null, url, pluginId: 'plurtasko' })
    }
    return items
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'monoschinos-movies' ? 'animes?tipo=pelicula' : 'animes'
    return (await this._parseItems(await fetchHtml(`${HOST}${path}`))).slice(skip, skip + top)
  },

  async search({ query, type }) {
    const html = await fetchHtml(`${HOST}animes?buscar=${encodeURIComponent(query).replace(/%20/g, '+')}`)
    const items = await this._parseItems(html)
    return type && type !== CONTENT_TYPES.ANIME ? items.filter(item => item.type === type) : items
  },

  async getMeta({ id }) {
    const url = id.replace(/^monoschinos:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>') || url).replace(/^Ver Anime\s+/i, '').trim()
    const isMovie = /-movie-|tipo=pelicula|pelicula/i.test(url)
    const meta = { id, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, url, pluginId: 'plurtasko' }
    if (!isMovie) {
      const episodes = []
      const seen = new Set()
      const addEpisodes = (source) => {
        for (const m of findMultipleMatches(source, 'href="([^"]*/ver/[^" ]*-episodio-(\\d+)[^" ]*)"')) {
          const epUrl = absoluteUrl(m[1], HOST)
          const episode = parseInt(m[2], 10)
          if (seen.has(episode)) continue
          seen.add(episode)
          episodes.push({ id: `monoschinos:${epUrl}`, name: `Episodio ${episode}`, season: 1, episode, url: epUrl })
        }
      }
      addEpisodes(html)
      // MonosChinos carga la lista por AJAX; pedir todas las páginas evita
      // mostrar únicamente el primer capítulo.
      const total = parseInt(findSingleMatch(html, 'id="dt"[^>]*data-e="(\\d+)"') || '0', 10)
      const internalId = findSingleMatch(html, 'id="dt"[^>]*data-i="([^"]+)"')
      const slug = findSingleMatch(html, 'id="dt"[^>]*data-u="([^"]+)"')
      if (total && internalId && slug) {
        const pages = Math.ceil(total / 50)
        for (let page = 1; page <= pages; page++) {
          const body = await postHtml(`${HOST}ajax_pagination`, `acc=episodes&i=${encodeURIComponent(internalId)}&u=${encodeURIComponent(slug)}&p=${page}`, null, { Referer: url, 'X-Requested-With': 'XMLHttpRequest' })
          addEpisodes(body)
        }
      }
      episodes.sort((a, b) => a.episode - b.episode)
      meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id }) {
    let url = id.replace(/^monoschinos:/, '')
    let html = cleanHtml(await fetchHtml(url))
    if (!html) return []
    // Las películas de MonosChinos tienen una ficha y el player en /ver/...episodio-1.
    let encrypt = findSingleMatch(html, 'data-encrypt="([^"]+)"')
    if (!encrypt && /\/anime\//.test(url)) {
      const episodeUrl = findSingleMatch(html, 'href="([^" ]*/ver/[^" ]*-episodio-1[^" ]*)"')
      if (episodeUrl) {
        url = absoluteUrl(episodeUrl, HOST)
        html = cleanHtml(await fetchHtml(url))
        encrypt = findSingleMatch(html, 'data-encrypt="([^"]+)"')
      }
    }
    if (!encrypt) return []
    const endpoint = `${HOST}ajax_pagination`
    const body = await postHtml(endpoint, `acc=opt&i=${encodeURIComponent(encrypt)}`, null, { Referer: url, 'X-Requested-With': 'XMLHttpRequest' })
    const streams = []
    const seen = new Set()
    const matches = findMultipleMatches(body, 'data-player="([^"]+)"[^>]*>([\\s\\S]*?)</button>')
    for (const m of matches) {
      const playerUrl = absoluteUrl(decodePlayer(m[1]), HOST)
      if (!/^https?:/i.test(playerUrl) || seen.has(playerUrl)) continue
      seen.add(playerUrl)
      const label = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim()) || 'embed'
      // El idioma sale del label del botón (latino/subtitulado); sin pista
      // queda sin etiqueta en vez de asumir latino.
      const lang = detectLangFromText(label)
      streams.push({ name: `${label}${lang ? ` (${lang})` : ''}`, url: playerUrl, streamType: normalizeServer('embed'), quality: '720', server: 'embed', lang, pluginName: 'MonosChinos', pluginId: 'plurtasko' })
    }
    return streams
  },
}
