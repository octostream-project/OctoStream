// DocumaniaTV channel — documentales en castellano. Sitio PHP Melody con
// tarjetas schema.org/Movie: catálogo por categoría
// (documentales-<cat>-videos-<pag>-date.html), ficha
// /<cat>/<slug>-video_<id>.html con el vídeo embebido. Los embeds de YouTube
// se resuelven por NewPipeExtractor (resolveYouTubeStream) — la ficha
// devuelve la URL directa, no el iframe del proveedor.

import { CONTENT_TYPES } from '../../../base.js'
import { httpGetText } from '../../../../utils/httpClient.js'
import { detectServerFromUrl } from '../scraper.js'
import { resolveYouTubeStream } from '../../../../utils/youtube.js'

const HOST = 'https://www.documaniatv.com'
const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
}
const PAGE_SIZE = 20

const CATEGORIES = [
  ['historia', 'Historia'],
  ['ciencia-y-tecnologia', 'Ciencia y tecnología'],
  ['naturaleza', 'Naturaleza'],
  ['arte-y-cine', 'Arte y cine'],
  ['biografias', 'Biografías'],
  ['politica', 'Política'],
  ['social', 'Social'],
  ['viajes', 'Viajes'],
  ['deporte', 'Deporte'],
]

const fetchHtml = (url, signal) => httpGetText(url, { headers: UA_HEADERS }, signal).catch(() => '')

// Tarjeta del listado: schema.org/Movie + enlace itemprop="url".
function parseCards(html) {
  const items = []
  const re = /itemtype="https?:\/\/schema\.org\/Movie"[\s\S]*?<meta itemprop="name" content="([^"]*)"[\s\S]*?<a itemprop="url" href="([^"]*-video_([a-z0-9]+)\.html)"[\s\S]*?<img[^>]+src="([^"]+)"/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const [, name, url, vid, poster] = m
    items.push({
      id: `documaniatv:${vid}`,
      type: CONTENT_TYPES.MOVIE,
      name: name.trim(),
      title: name.trim(),
      poster: poster.startsWith('http') ? poster : `${HOST}${poster}`,
      url,
      docUrl: url,
      pluginId: 'plurtasko',
    })
  }
  return items
}

// Embeds de la ficha: iframes + YouTube/Dailymotion/Vimeo.
function parseEmbeds(html) {
  const out = []
  const push = (url) => {
    if (!/^https?:/i.test(url) || out.includes(url)) return
    out.push(url)
  }
  for (const m of html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)) push(m[1].replace(/&amp;/g, '&'))
  for (const m of html.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{6,})/gi)) {
    push(`https://www.youtube.com/watch?v=${m[1]}`)
  }
  for (const m of html.matchAll(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/gi)) {
    push(`https://www.dailymotion.com/embed/video/${m[1]}`)
  }
  for (const m of html.matchAll(/player\.vimeo\.com\/video\/(\d+)/gi)) {
    push(`https://player.vimeo.com/video/${m[1]}`)
  }
  return out
}

async function metaFromPage(id, html) {
  const pick = (re) => html.match(re)?.[1]?.trim() || ''
  const name = pick(/<meta itemprop="name" content="([^"]+)"/)
    || pick(/<meta property="og:title" content="([^"]+)"/)
    || pick(/<title>([^<]+)<\/title>/).replace(/\s*-\s*DocumaniaTV.*$/i, '')
  if (!name) return null
  return {
    id,
    type: CONTENT_TYPES.MOVIE,
    name,
    title: name,
    poster: pick(/<meta property="og:image" content="([^"]+)"/) || null,
    description: pick(/<meta itemprop="description" content="([^"]+)"/)
      || pick(/<meta name="description" content="([^"]+)"/),
    genres: ['Documental'],
    pluginId: 'plurtasko',
  }
}

async function streamsFromEmbeds(html, signal) {
  const streams = []
  for (const url of parseEmbeds(html)) {
    const isYt = /youtube\.com|youtu\.be/.test(url)
    if (isYt) {
      // NewPipe: URL directa (dash/hls/mp4) — el iframe solo de respaldo.
      const resolved = await resolveYouTubeStream(url).catch(() => null)
      if (resolved?.url) {
        streams.push({
          ...resolved,
          name: `DocumaniaTV (YT) ${resolved.quality || ''}`.trim(),
          server: 'YouTube',
          lang: 'Esp',
          pluginName: 'DocumaniaTV',
          pluginId: 'plurtasko',
          _refreshUrl: async () => (await resolveYouTubeStream(url, { force: true }))?.url || null,
        })
        continue
      }
      if (signal?.aborted) break
    }
    streams.push({
      name: `DocumaniaTV (${detectServerFromUrl(url)})`,
      url,
      streamType: 'embed',
      referer: HOST,
      lang: 'Esp',
      server: detectServerFromUrl(url),
      pluginName: 'DocumaniaTV',
      pluginId: 'plurtasko',
    })
  }
  return streams
}

export const documaniatv = {
  id: 'documaniatv',
  name: 'DocumaniaTV',
  defaultLang: 'Esp',
  types: [CONTENT_TYPES.MOVIE],
  host: HOST,

  catalogs: [
    { id: 'documaniatv-nuevos', name: 'DocumaniaTV: Nuevos', type: CONTENT_TYPES.MOVIE },
    { id: 'documaniatv-top', name: 'DocumaniaTV: Los mejores', type: CONTENT_TYPES.MOVIE },
    { id: 'documaniatv-series', name: 'DocumaniaTV: Series documentales', type: CONTENT_TYPES.MOVIE },
    ...CATEGORIES.map(([slug, name]) => ({
      id: `documaniatv-${slug}`, name: `DocumaniaTV: ${name}`, type: CONTENT_TYPES.MOVIE,
    })),
  ],

  async getCatalog({ id, skip = 0, top = 40, signal }) {
    const page = Math.floor(skip / PAGE_SIZE) + 1
    let url
    if (id === 'documaniatv-nuevos') url = `${HOST}/documentales-nuevos.html`
    else if (id === 'documaniatv-top') url = `${HOST}/top-documentales.html`
    else if (id === 'documaniatv-series') url = `${HOST}/top-series-documentales-${page}.html`
    else {
      const slug = String(id).replace(/^documaniatv-/, '')
      if (!/^[a-z0-9-]+$/i.test(slug)) return []
      url = `${HOST}/documentales-${slug}-videos-${page}-date.html`
    }
    return parseCards(await fetchHtml(url, signal)).slice(0, top)
  },

  async getMeta({ id, signal }) {
    const vid = String(id).match(/^documaniatv:([a-z0-9]+)$/i)?.[1]
    if (!vid) return null
    const html = await fetchHtml(`${HOST}/watch.php?vid=${vid}`, signal)
    if (!html) return null
    return metaFromPage(id, html)
  },

  async getStreams({ id, signal }) {
    const vid = String(id).match(/^documaniatv:([a-z0-9]+)$/i)?.[1]
    if (!vid) return []
    const html = await fetchHtml(`${HOST}/watch.php?vid=${vid}`, signal)
    return streamsFromEmbeds(html, signal)
  },

  async search({ query, signal }) {
    const html = await fetchHtml(`${HOST}/search.php?keywords=${encodeURIComponent(query)}`, signal)
    return parseCards(html)
  },
}
