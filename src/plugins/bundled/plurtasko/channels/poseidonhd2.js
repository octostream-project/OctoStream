// PoseidonHD2 channel — películas y series en castellano/latino/VOSE.
// Portado de Balandro poseidonhd2.py. Tema React (marcadores <!-- -->):
//   catálogo  : /peliculas, /series → <div class="TPost..."> cards
//   búsqueda  : /search?q=query
//   temporadas: <option value="N">; episodios en JSON "title"/"number"/"image"
//   episodio  : {serie}/temporada/{S}/episodio/{E}
//   streams   : <li class="open_submenu active actives"> → opts data-tr="URL"
//               + <span>servidor</span>; lang Español/Latino/Subtitulado.
// Las URLs llevan el TMDB id numérico: /pelicula/{tmdbId}/slug.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://www.poseidonhd2.co/'

const SRV_MAP = { drive: 'gvideo', 'ok-ru': 'okru', voex: 'voe' }
const SKIP_SRV = new Set(['plustream', '1fichier'])

function mapLang(t) {
  const l = detectLangFromText(t)
  return l || 'ESP'
}

function parseCards(html, typeFilter) {
  const items = []
  const seen = new Set()
  for (const m of findMultipleMatches(html, '<div class="TPost[\\s\\S]*?</div></li>')) {
    const block = m[0]
    const href = findSingleMatch(block, 'href="([^"]+)"')
    if (!href || seen.has(href)) continue
    let title = decodeEntities(
      findSingleMatch(block, '<h2[^>]*>([\\s\\S]*?)</h2>') ||
      findSingleMatch(block, 'title="([^"]+)"') ||
      findSingleMatch(block, 'alt="([^"]+)"') || ''
    ).replace(/^Ver\s+/i, '').replace(/\s*online.*$/i, '').trim()
    if (!title) continue
    const url = absoluteUrl(href, HOST)
    const isSeries = /\/serie\//.test(url)
    if (typeFilter === CONTENT_TYPES.MOVIE && isSeries) continue
    if (typeFilter === CONTENT_TYPES.SERIES && !isSeries) continue
    const poster = findSingleMatch(block, 'src="([^"]+)"') || findSingleMatch(block, 'data-src="([^"]+)"')
    seen.add(href)
    items.push({
      id: `poseidonhd2:${url}`,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      url,
      pluginId: 'plurtasko',
    })
  }
  return items
}

function parsePlayerOptions(html, signal) {
  const streams = []
  const seen = new Set()
  const sections = findMultipleMatches(html, '<li class="open_submenu active actives">([\\s\\S]*?)</div></li>')
  for (const s of sections) {
    const opts = findMultipleMatches(s[1], '</svg><div class="_([\\s\\S]*?)</ul>')
    for (const o of opts) {
      const opt = o[1]
      const lang = mapLang(findSingleMatch(opt, '<span>([^<]*)<span>'))
      const quality = findSingleMatch(opt, '<span>[^<]*<span>([^<]*)</span>')
      for (const l of findMultipleMatches(opt, 'data-tr="([^"]+)"[\\s\\S]*?<span>([\\s\\S]*?)</span>')) {
        const url = l[1]
        let srv = (l[2] || '').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '').trim().toLowerCase()
        if (!srv || SKIP_SRV.has(srv)) continue
        srv = SRV_MAP[srv] || srv
        const embed = absoluteUrl(url, HOST)
        if (!/^https?:/i.test(embed) || seen.has(embed)) continue
        seen.add(embed)
        streams.push({
          name: `${srv === 'player' || srv === 'embed' ? 'embed' : srv} (${lang})`,
          url: embed,
          streamType: normalizeServer('embed'),
          quality: (quality || 'HD').replace(/CALIDAD/i, '').trim() || 'HD',
          server: srv === 'player' || srv === 'embed' ? 'embed' : srv,
          lang,
          pluginName: 'PoseidonHD2',
          pluginId: 'plurtasko',
        })
      }
    }
  }
  return streams
}

export const poseidonhd2 = {
  id: 'poseidonhd2',
  name: 'PoseidonHD2',
  defaultLang: 'ESP',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  // Las URLs llevan el id numérico de TMDB: /pelicula/1381071/godzilla…
  extractId(url) {
    const m = url.match(/poseidonhd2\.co\/(?:pelicula|serie)\/(\d+)\//)
    return m ? m[1] : null
  },

  catalogs: [
    { id: 'poseidonhd2-movies', name: 'PoseidonHD2: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'poseidonhd2-series', name: 'PoseidonHD2: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const path = id === 'poseidonhd2-series' ? 'series' : 'peliculas'
    const page = Math.floor(skip / 24) + 1
    const html = await fetchHtml(`${HOST}${path}${page > 1 ? `?page=${page}` : ''}`)
    const typeFilter = id === 'poseidonhd2-series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
    return parseCards(html, typeFilter).slice(skip % 24, skip % 24 + top)
  },

  async search({ query, type, signal }) {
    const html = await fetchHtml(`${HOST}search?q=${encodeURIComponent(query).replace(/%20/g, '+')}`, signal)
    return parseCards(html, type)
  },

  async getMeta({ id }) {
    const url = id.replace(/^poseidonhd2:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>([\\s\\S]*?)</h1>') ||
      findSingleMatch(html, 'property="og:title"[^>]*content="([^"]+)"') || ''
    ).replace(/\s*[-–|].*$/,'').trim() || url
    const poster = findSingleMatch(html, 'property="og:image"[^>]*content="([^"]+)"') ||
      findSingleMatch(html, '<img[^>]*src="([^"]+)"')
    const isSeries = /\/serie\//.test(url)
    const meta = {
      id, type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title, title, url,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      pluginId: 'plurtasko',
    }
    if (isSeries) {
      // Temporadas: <option value="N"> + episodios en JSON embebido
      // ("title":"…","number":N,…,"image":"…") por temporada.
      const episodes = []
      const seasonNums = findMultipleMatches(html, '<option value="(\\d+)"').map(m => parseInt(m[1], 10)).filter(Boolean)
      const seasons = seasonNums.length ? seasonNums : [1]
      for (const s of seasons) {
        // Los episodios de cada temporada se cargan al cambiar el select;
        // el JSON del SSR lleva al menos la temporada 1. Pedimos /temporada/S
        // cuando hace falta.
        let pageHtml = html
        if (s !== 1 && seasons.length > 1) {
          pageHtml = cleanHtml(await fetchHtml(`${url.replace(/\/+$/, '')}/temporada/${s}`)) || html
        }
        for (const m of findMultipleMatches(pageHtml, '"title":"([^"]*)"[\\s\\S]*?"number":(\\d+)[\\s\\S]*?"image":"([^"]*)"')) {
          const epNum = parseInt(m[2], 10)
          if (!epNum) continue
          const epUrl = `${url.replace(/\/+$/, '')}/temporada/${s}/episodio/${epNum}`
          episodes.push({
            id: `poseidonhd2:${epUrl}`,
            name: decodeEntities(m[1].replace(/\\u0026/g, '&')) || `Episodio ${epNum}`,
            season: s,
            episode: epNum,
            poster: m[3] ? absoluteUrl(m[3].replace(/\\\//g, '/'), HOST) : null,
            url: epUrl,
          })
        }
      }
      // Dedupe + orden
      const seen = new Set()
      meta.episodes = episodes.filter(e => {
        const k = `${e.season}x${e.episode}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }).sort((a, b) => a.season - b.season || a.episode - b.episode)
    }
    return meta
  },

  async getStreams({ id, signal }) {
    const url = id.replace(/^poseidonhd2:/, '')
    const html = cleanHtml(await fetchHtml(url, signal))
    if (!html) return []
    return parsePlayerOptions(html, signal)
  },
}
