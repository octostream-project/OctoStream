// BlogHorror channel — blog WordPress de películas de terror (bloghorror.com).
// Portado del canal bloghorror de Alfa/Balandro. Las fichas llevan un bloque
// "FICHA TECNICA" con Calidad/Audio seguido de los enlaces de descarga:
// mayoritariamente magnet: (YTS) y ocasionalmente hosts directos (ok.ru,
// megaup…). Posts de noticias/críticas sin ficha devuelven streams vacíos.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectServerFromUrl, normalizeServer, baseTitle, makeTorrentStream, extractYear } from '../scraper.js'
import { detectLangFromText, extractQualityFromText } from '../meta.js'

const HOST = 'https://bloghorror.com/'

// Categorías con fichas descargables (el home mezcla noticias y trailers).
const CATALOGS = [
  { id: 'bloghorror-terror', name: 'BlogHorror: Terror', path: 'category/terror-3' },
  { id: 'bloghorror-asia', name: 'BlogHorror: Terror Asiático', path: 'category/asiatico1' },
]

// Enlaces que nunca son descarga (subs, trailers, widgets, sociales, créditos).
const SKIP_HOST = /subdivx|imdb\.com|disqus|feedspot|afthemes|identi\.li|stats\.fm|instagram|facebook|twitter|x\.com|pinterest|whatsapp|telegram|reddit|youtube|youtu\.be|vimeo|t\.co|wordpress|gravatar|bloghorror/i

export const bloghorror = {
  id: 'bloghorror',
  name: 'BlogHorror',
  defaultLang: 'VO',
  types: [CONTENT_TYPES.MOVIE],
  host: HOST,

  catalogs: CATALOGS.map(c => ({ id: c.id, name: c.name, type: CONTENT_TYPES.MOVIE })),

  async getCatalog({ id, skip = 0, top = 50 }) {
    const cat = CATALOGS.find(c => c.id === id) || CATALOGS[0]
    const page = Math.floor(skip / 15) + 1
    const url = `${HOST}${cat.path}${page > 1 ? `/page/${page}` : ''}`
    const html = await fetchHtml(url)
    if (!html) return []
    return parseArticleCards(html).slice(0, top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^bloghorror:/, '')
    const html = await fetchHtml(url)
    if (!html) return null
    const title = findSingleMatch(html, /<h1[^>]*class="[^"]*(?:entry-title|post-title)[^"]*"[^>]*>([\s\S]*?)<\/h1>/)
      || findSingleMatch(html, /og:title[^>]*content="([^"]+)"/)
      || findSingleMatch(html, /<title>([^<]+?)(?:\s*[-–|].*)?<\/title>/)
      || ''
    const poster = findSingleMatch(html, /og:image[^>]*content="([^"]+)"/)
    const ficha = fichaBlock(html)
    const synopsis = findSingleMatch(html, /<span[^>]*>RESEÑA:?<\/span>\s*<\/p>\s*<p>([\s\S]*?)<\/p>/i)
    const cleanTitle = decodeEntities(title).replace(/<[^>]+>/g, '').trim()
    const { base } = baseTitle(cleanTitle)
    const meta = {
      id,
      type: CONTENT_TYPES.MOVIE,
      name: cleanTitle,
      title: base,
      year: extractYear(cleanTitle).year,
      poster: poster || null,
      description: synopsis ? decodeEntities(synopsis).replace(/<[^>]+>/g, '').trim() : '',
      url,
      pluginId: 'plurtasko',
    }
    if (ficha) meta.extra = ficha
    return meta
  },

  async getStreams({ id }) {
    const url = id.replace(/^bloghorror:/, '')
    const html = await fetchHtml(url)
    if (!html) return []

    const ficha = fichaBlock(html)
    const quality = ficha?.quality || ''
    // Audio declarado en la ficha ("Audio: Ingles/Latino/Castellano…")
    const lang = detectLangFromText(ficha?.audio || '') || 'VO'

    const streams = []
    const seen = new Set()
    // Anchors de toda la página filtrados por blacklist: en algunos posts la
    // regex de ficha engancha un "FICHA TECNICA" decorativo de un widget sin
    // los enlaces reales, así que no se puede limitar el scope a ese bloque.
    const scope = html
    const anchors = findMultipleMatches(scope, /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    for (const m of anchors) {
      const href = m[1].replace(/&amp;/g, '&').trim()
      const label = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
      if (/^magnet:/i.test(href)) {
        const key = (href.match(/btih:([0-9a-f]+)/i) || [])[1] || href
        if (seen.has(key)) continue
        seen.add(key)
        const q = extractQualityFromText(decodeURIComponent(href)) || quality || 'HD'
        streams.push(makeTorrentStream('BlogHorror', href, q, label || undefined))
        if (lang && streams[streams.length - 1]) {
          streams[streams.length - 1].lang = lang
          streams[streams.length - 1].name = `BlogHorror (${lang}) ${q}`
        }
        continue
      }
      if (!/^https?:/i.test(href) || SKIP_HOST.test(href)) continue
      // Solo hosts de vídeo conocidos o enlaces directos a archivo — el resto
      // son enlaces editoriales del post.
      const server = detectServerFromUrl(href)
      const isFile = /\.(?:mp4|mkv|avi|webm|m3u8)(?:$|[?#])/i.test(href)
      if (server === 'embed' && !isFile) continue
      // ok.ru solo resuelve rutas /video/ — grupos/topics no son reproducción.
      if (server === 'okru' && !/\/video\//.test(href)) continue
      // m.ok.ru → ok.ru (el resolver espera el host canónico).
      const cleanHref = href.replace(/^https?:\/\/m\.ok\.ru/i, 'https://ok.ru')
      if (seen.has(cleanHref)) continue
      seen.add(cleanHref)
      streams.push({
        name: `${isFile ? 'Directo' : server}${lang ? ` (${lang})` : ''}`,
        lang,
        url: cleanHref,
        streamType: isFile ? 'mp4' : normalizeServer(server),
        quality: quality || '',
        server: isFile ? 'directo' : server,
        title: label || undefined,
        pluginName: 'BlogHorror',
        pluginId: 'plurtasko',
      })
    }
    return streams
  },

  async search({ query, type }) {
    if (type && type !== CONTENT_TYPES.MOVIE) return []
    const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query).replace(/%20/g, '+')}`)
    if (!html) return []
    return parseArticleCards(html)
  },
}

// Cards <article> del home/categorías/búsqueda:
//   data-background="POSTER" … <h3 class="article-title…"><a href="URL">TÍTULO</a>
function parseArticleCards(html) {
  const items = []
  const seen = new Set()
  const arts = findMultipleMatches(html, /<article[^>]*>([\s\S]*?)<\/article>/)
  for (const a of arts) {
    const block = a[1]
    const m = findMultipleMatches(block, /article-title[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)[0]
    if (!m) continue
    const url = m[1]
    if (seen.has(url) || !/\.html?$/.test(url)) continue
    seen.add(url)
    const rawName = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
    const poster = findSingleMatch(block, /data-background="([^"]+)"/)
    const { base } = baseTitle(rawName)
    items.push({
      id: `bloghorror:${url}`,
      type: CONTENT_TYPES.MOVIE,
      name: rawName,
      title: base,
      year: extractYear(rawName).year,
      poster: poster || null,
      url,
      pluginId: 'plurtasko',
    })
  }
  return items
}

// Bloque "FICHA TECNICA: <br/> Calidad: X <br/> Audio: Y …" dentro del post.
// Devuelve el html del bloque y los campos parseados, o null si el post es
// una noticia/crítica sin descargas.
function fichaBlock(html) {
  // El primer "FICHA TECNICA" del documento puede ser un widget decorativo
  // vacío — quedarse con el primer bloque que realmente declare Calidad o
  // contenga enlaces.
  const m = findMultipleMatches(html, /FICHA\s*TECNICA:?([\s\S]*?)<\/p>/i)
    .find(x => /Calidad|href=/i.test(x[1]))
  if (!m) return null
  const inner = m[1]
  // Campos en texto plano: "Calidad: 1080", "Audio: Ingles" (los <br/> ya
  // fuera — el bloque es un <p> y los separadores son tags, no espacios).
  const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
  const quality = (text.match(/Calidad\s*:?\s*([^\n]{1,40})/i) || [])[1] || ''
  const audio = (text.match(/Audio\s*:?\s*([^\n]{1,40})/i) || [])[1] || ''
  return {
    html: `<p>${inner}</p>`,
    quality: extractQualityFromText(quality) || quality.trim(),
    audio: audio.trim(),
  }
}
