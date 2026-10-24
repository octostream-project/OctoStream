// MagisTV24 channel â€” pelÃ­culas/series embebidas en Castellano/Latino.
// Portado de Balandro channels/seriespapayato.py (mismo theme "aa-tbs").
//
//   ?s=<q>                       â†’ tarjetas <article class="post">
//   cartelera-peliculas|series/  â†’ catÃ¡logo paginado
//   /<pelicula|serie>/<slug>/    â†’ ficha (series listan solo T1)
//   wp-admin/admin-ajax.php POST action=action_select_season&post=&season=
//                                â†’ HTML con los capÃ­tulos de esa temporada
//   /capitulo/<slug>-temporada-N-capitulo-M/ â†’ pÃ¡gina de episodio
//   /?trembed=N&trid=<id>&trtype=<1|2>       â†’ <IFRAME SRC="embedâ€¦">

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer, detectServerFromUrl } from '../scraper.js'
import { extractQualityFromText, detectLangFromText } from '../meta.js'

const HOST = 'https://magistv24.com/'
const NAME = 'MagisTV24'

const fixUrl = (u) => u?.startsWith('//') ? `https:${u}` : u

// Tarjetas <article class="post â€¦"> del listado/bÃºsqueda.
function parseCards(html) {
  const items = []
  for (const m of findMultipleMatches(html, '<article class="post[^>]*>([\\s\\S]*?)</article>')) {
    const body = m[1]
    const url = findSingleMatch(body, 'href="([^"]+)"[^>]*class="lnk-blk"') || findSingleMatch(body, 'class="lnk-blk"[^>]*href="([^"]+)"')
    const title = findSingleMatch(body, '<h2 class="entry-title">([^<]+)').trim()
    if (!url || !title) continue
    const poster = fixUrl(findSingleMatch(body, '<img[^>]*src="([^"]+)"')) || null
    const year = parseInt(findSingleMatch(body, '<span class="year">\\s*(\\d{4})'), 10) || null
    const type = /\/serie\//.test(url) ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
    const slug = url.replace(/\/+$/, '').split('/').pop()
    items.push({
      id: `magistv24:${type === CONTENT_TYPES.SERIES ? 'serie' : 'pelicula'}:${slug}`,
      type,
      name: title,
      title,
      poster,
      year,
      url,
      pluginId: 'plurtasko',
    })
  }
  return items
}

// PestaÃ±as "Opcion N" del reproductor: server/idioma por Ã­ndice.
function parseOptionLangs(html) {
  const langs = []
  for (const m of findMultipleMatches(html, 'href="#options-\\d+"[^>]*>([\\s\\S]*?)</a>')) {
    const server = findSingleMatch(m[1], '<span class="server">([\\s\\S]*?)</span>')
    // "-Latino" / "Server - Castellano" â†’ texto tras el Ãºltimo guion.
    const lang = server.split('-').pop()?.trim() || ''
    langs.push(lang)
  }
  return langs
}

// URLs ?trembed=N del documento (data-src lazy o src directo, &#038; â†’ &).
function parseTrembeds(html) {
  const urls = []
  const seen = new Set()
  for (const m of findMultipleMatches(html, '(?:data-)?src="([^"]*\\?trembed=[^"]+)"')) {
    const u = m[1].replace(/&#0?38;/g, '&').replace(/&amp;/g, '&')
    if (!seen.has(u)) { seen.add(u); urls.push(u) }
  }
  return urls
}

// PÃ¡gina ?trembed â†’ URL real del iframe del hoster.
async function trembedToEmbed(url, referer, signal) {
  const html = await fetchHtml(url, signal, { Referer: referer }).catch(() => '')
  return findSingleMatch(html, 'SRC="([^"]+)"') || findSingleMatch(html, 'src="([^"]+)"')
}

async function streamsFromPage(url, signal) {
  const html = await fetchHtml(url, signal).catch(() => '')
  if (!html) return []
  const trembeds = parseTrembeds(html)
  const langs = parseOptionLangs(html)
  const embeds = await Promise.all(trembeds.map(u => trembedToEmbed(u, url, signal).catch(() => '')))
  const streams = []
  embeds.forEach((embedUrl, i) => {
    if (!/^https?:/i.test(embedUrl)) return
    const server = detectServerFromUrl(embedUrl)
    const lang = detectLangFromText(langs[i] || '')
    streams.push({
      name: `${server}${lang ? ` (${lang})` : ''}`,
      url: embedUrl,
      streamType: normalizeServer(server),
      server,
      lang,
      pluginName: NAME,
      pluginId: 'plurtasko',
    })
  })
  return streams
}

export const magistv24 = {
  id: 'magistv24',
  name: NAME,
  defaultLang: 'Esp',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'magistv24-movies', name: 'MagisTV: PelÃ­culas', type: CONTENT_TYPES.MOVIE, url: `${HOST}cartelera-peliculas/` },
    { id: 'magistv24-series', name: 'MagisTV: Series', type: CONTENT_TYPES.SERIES, url: `${HOST}cartelera-series/` },
  ],

  async getCatalog({ id, skip = 0, top = 50, signal }) {
    const cat = this.catalogs.find(c => c.id === id)
    if (!cat) return []
    const page = Math.floor(skip / 20) + 1
    const url = page > 1 ? `${cat.url}page/${page}/` : cat.url
    const html = await fetchHtml(url, signal).catch(() => '')
    return parseCards(html).slice(0, top)
  },

  async getMeta({ id, signal }) {
    const m = String(id).match(/^magistv24:(pelicula|serie|capitulo):(.+)$/)
    if (!m) return null
    const [, kind, slug] = m
    const url = `${HOST}${kind === 'capitulo' ? 'capitulo' : kind}/${slug}/`
    const html = await fetchHtml(url, signal).catch(() => '')
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>([^<]+)</h1>').trim()
      || findSingleMatch(html, '<meta property="og:title" content="([^"]+)"').trim()
    if (!title) return null

    const meta = {
      id,
      type: kind === 'pelicula' ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
      name: title,
      title,
      poster: fixUrl(findSingleMatch(html, '<meta property="og:image" content="([^"]+)"')) || null,
      description: findSingleMatch(html, '<meta name="description" content="([^"]+)"').trim(),
      year: parseInt(findSingleMatch(html, '<span class="year">\\s*(\\d{4})'), 10) || null,
      url,
      pluginId: 'plurtasko',
    }

    if (kind === 'serie') {
      const postId = findSingleMatch(html, 'data-post="(\\d+)"')
      // Temporada visible en el documento + el resto por admin-ajax.
      const episodeHtml = [html]
      const extraSeasons = findMultipleMatches(html, 'data-season="(\\d+)"').map(x => +x[1]).filter(n => n > 1)
      await Promise.all(extraSeasons.map(async (season) => {
        const body = `action=action_select_season&post=${postId}&season=${season}`
        const more = await postHtml(`${HOST}wp-admin/admin-ajax.php`, body, signal, { Referer: url }).catch(() => '')
        if (more) episodeHtml.push(more)
      }))
      const seen = new Set()
      meta.episodes = []
      for (const block of episodeHtml) {
        for (const e of findMultipleMatches(block, 'href="[^"]*capitulo/([^"/]+)-temporada-(\\d+)-capitulo-(\\d+)/?"')) {
          const [, eslug, season, episode] = e
          const key = `${eslug}-${season}x${episode}`
          if (seen.has(key)) continue
          seen.add(key)
          meta.episodes.push({
            id: `magistv24:capitulo:${eslug}-temporada-${season}-capitulo-${episode}`,
            name: `${title} ${season}x${String(episode).padStart(2, '0')}`,
            season: +season,
            episode: +episode,
            url: `${HOST}capitulo/${eslug}-temporada-${season}-capitulo-${episode}/`,
          })
        }
      }
    }
    return meta
  },

  async getStreams({ id, signal }) {
    const m = String(id).match(/^magistv24:(pelicula|serie|capitulo):(.+)$/)
    if (!m) return []
    const [, kind, slug] = m
    const url = `${HOST}${kind === 'capitulo' ? 'capitulo' : kind}/${slug}/`
    return streamsFromPage(url, signal)
  },

  async search({ query, signal }) {
    const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query)}`, signal).catch(() => '')
    return parseCards(html)
  },
}

