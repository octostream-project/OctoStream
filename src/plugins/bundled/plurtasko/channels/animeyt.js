import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'

const HOST = 'https://vvw.animeyt.one/'

// Mismo slugify que usa la web para construir las URLs de episodio:
// `<sl>-episodio-<slugify(num)>` (sin acentos, espacios/puntos → guiones).
function slugify(text) {
  return String(text).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\s]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .toLowerCase()
    .trim()
}

// La lista de servidores llega con la URL en dos formatos: `data="https://…"`
// en claro y `encrypt="…"` en hexadecimal. Preferimos el claro y decodificamos
// el hex como fallback.
function hexDecode(hex) {
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.substr(i, 2), 16)
    if (!Number.isFinite(code)) return ''
    out += String.fromCharCode(code)
  }
  return out
}

function streamFromUrl(rawUrl, server, lang = 'VOSE') {
  const url = absoluteUrl(String(rawUrl || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim(), HOST)
  if (!/^https?:/i.test(url) || /youtube\.com\/embed|trailer/i.test(url)) return null
  return {
    name: `${server || 'embed'}${lang ? ` (${lang})` : ''}`,
    url,
    streamType: normalizeServer(server || ''),
    quality: '720',
    server: server || 'embed',
    lang,
    pluginName: 'AnimeYT',
    pluginId: 'plurtasko',
  }
}

export const animeyt = {
  id: 'animeyt',
  name: 'AnimeYT',
  defaultLang: 'VOSE',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,
  catalogs: [
    { id: 'animeyt-series', name: 'AnimeYT: Series', type: CONTENT_TYPES.ANIME },
    { id: 'animeyt-movies', name: 'AnimeYT: Películas', type: CONTENT_TYPES.MOVIE },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const url = id === 'animeyt-movies' ? `${HOST}animes?tipo=pelicula` : `${HOST}animes?tipo=tv`
    return (await this._parseSearch(await fetchHtml(url))).slice(skip, skip + top)
  },

  // Las tarjetas son <article class="li"> con el badge de tipo en
  // <span class="tp tv|pe|ov"> y el póster en img[data-src].
  async _parseSearch(html) {
    html = cleanHtml(html)
    if (!html) return []
    const items = []
    const seen = new Set()
    const matches = findMultipleMatches(html, '<article[^>]*>[\\s\\S]*?<a[^>]*href="([^"]*/anime/[^"]*)"[^>]*>[\\s\\S]*?<img[^>]*data-src="([^"]*)"[^>]*alt="([^"]*)"[\\s\\S]*?class="tp[^"]*"[^>]*>([^<]*)')
    for (const m of matches) {
      const url = absoluteUrl(m[1].replace(/^\.\//, '/'), HOST)
      if (seen.has(url)) continue
      seen.add(url)
      const title = decodeEntities(m[3].trim())
      if (!title) continue
      const isMovie = /pel.cula|^pe$/i.test(m[4].trim()) || /class="tp pe"/i.test(m[0])
      items.push({
        id: `animeyt:${url}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: m[2] || null,
        url,
        pluginId: 'plurtasko',
      })
    }
    return items
  },

  async search({ query, type }) {
    // El buscador del sitio es un GET a /animes?buscar=<q> que devuelve la
    // misma parrilla de tarjetas que el catálogo.
    const html = await fetchHtml(`${HOST}animes?buscar=${encodeURIComponent(query)}`)
    const items = await this._parseSearch(html)
    return type && type !== CONTENT_TYPES.ANIME ? items.filter(item => item.type === type) : items
  },

  async getMeta({ id }) {
    const url = id.replace(/^animeyt:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null
    const title = decodeEntities(
      findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') ||
      findSingleMatch(html, 'og:title"[^>]*content="([^"]*)"') ||
      findSingleMatch(html, '<title>(.*?)</title>') || url
    ).replace(/<[^>]+>/g, ' ')
      .replace(/^\s*ver\s+/i, '')
      .replace(/\s*(episodio\s+\S+.*)?online\s+gratis.*$/i, '')
      .replace(/\s+-\s+animeyt\.?\s*$/i, '')
      .replace(/\s+/g, ' ').trim()
    const isMovie = /Tipo:<\/b>\s*Pel.cula/i.test(html)
    const poster = findSingleMatch(html, 'og:image"[^>]*content="([^"]+)"') || null
    const meta = { id, type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES, name: title, title, url, poster, pluginId: 'plurtasko' }

    // La ficha incluye `var eps = [["293","Despedida"],…]` con la lista de
    // episodios y `data-sl`/`data-zr` con el slug y el primer episodio.
    const slug = findSingleMatch(html, 'data-sl="([^"]+)"') || (url.match(/\/anime\/([^/?#]+)/) || [])[1] || ''
    const epsJson = findSingleMatch(html, 'var eps = (\\[.*?\\]);')
    if (slug && epsJson) {
      let eps = []
      try { eps = JSON.parse(epsJson) } catch { eps = [] }
      const episodes = []
      for (const entry of eps) {
        const num = String(entry?.[0] ?? '').trim()
        if (!num) continue
        const epUrl = `${HOST}anime/${slug}-episodio-${slugify(num)}`
        const episode = parseInt(num, 10) || episodes.length + 1
        const epTitle = decodeEntities(String(entry?.[1] || '').trim())
        episodes.push({
          id: `animeyt:${epUrl}`,
          name: epTitle ? `${num}. ${epTitle}` : `E${episode}`,
          season: 1,
          episode,
          url: epUrl,
        })
      }
      episodes.sort((a, b) => a.episode - b.episode)
      if (episodes.length) meta.episodes = episodes
    }
    return meta
  },

  async getStreams({ id }) {
    let url = id.replace(/^animeyt:/, '')
    // Las películas (y cualquier ficha sin sufijo de episodio) se reproducen en
    // su episodio 1.
    if (!/-episodio-/i.test(url)) url = `${url.replace(/\/+$/, '')}-episodio-1`
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return []

    const streams = []
    const seen = new Set()
    const push = (rawUrl, server) => {
      const stream = streamFromUrl(rawUrl, server)
      if (stream && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream) }
    }

    // Servidores del reproductor: <ul class="opt" data-encrypt="…"> y POST a
    // ./yt (acc=opt) que devuelve <li data="url" encrypt="hex"><i>servidor</i>.
    const token = findSingleMatch(html, 'class="opt"[^>]*data-encrypt="([^"]+)"') ||
      findSingleMatch(html, 'data-encrypt="([^"]+)"[^>]*class="opt"') ||
      findSingleMatch(html, 'data-encrypt="([0-9a-f]+)"')
    if (token) {
      const opts = cleanHtml(await postHtml(`${HOST}yt`, `acc=opt&i=${encodeURIComponent(token)}`, undefined, {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': url,
      }))
      for (const m of findMultipleMatches(opts, '<li[^>]*>[\\s\\S]*?</li>')) {
        const li = m[0]
        const server = decodeEntities(
          findSingleMatch(li, '<i[^>]*>(.*?)</i>') ||
          (li.match(/title="[^"]*?,\s*([^"<]+?)"/) || [])[1] || ''
        ).trim()
        push(findSingleMatch(li, 'data="([^"]+)"') || hexDecode(findSingleMatch(li, 'encrypt="([0-9a-f]+)"') || ''), server)
      }
    }

    // Fallback: los enlaces de descarga directos de .mep[data-dwn] (JSON de
    // URLs) — mismos hosts que los embeds.
    if (!streams.length) {
      const dwn = findSingleMatch(html, 'data-dwn="([^"]+)"')
      if (dwn) {
        try {
          for (const u of JSON.parse(decodeEntities(dwn))) push(u, 'download')
        } catch {}
      }
    }
    return streams
  },
}
