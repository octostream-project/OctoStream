// Shared scraper for DooPlay WordPress theme sites (estrenoscinesaa, cinemitas…).
// Structure verified live:
//   catalog cards : <article class="item"> → <a href="/movies|tvshows/slug/"> + img + h3.title + span.item_type
//   search        : ?s=query → <article class="w_item_a"> (same inner markup)
//   player options: <li class='dooplay_player_option' data-post=N data-type=movie|tv data-nume=N>
//                   + <span class='title'>ServerCastellano|ServerLatino|…</span>
//   player call   : POST /wp-admin/admin-ajax.php  action=doo_player_ajax&post=N&nume=N&type=movie|tv
//                   → {embed_url:"<IFRAME SRC=…>" | "https://…", type:"iframe"|"dtshcode"}
//   episodes      : #seasons .se-c → ul.episodios li → div.numerando "S - E" + a[href=/episodes/…]

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, cleanHtml, decodeEntities, absoluteUrl, googleSiteSearch } from '../http.js'
import { findSingleMatch, findMultipleMatches, detectServerFromUrl, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const ARTICLE_RE = '<article[^>]*>([\\s\\S]*?)</article>'
// The data-post/data-type/data-nume attribute order varies between options
// on the same page — parse each attribute independently from the <li> tag.
const OPTION_LI_RE = /<li[^>]*dooplay_player_option[^>]*>([\s\S]*?)<\/li>/g

function parseLangFromTitle(title) {
  const t = (title || '').toLowerCase()
  if (/castellano|español(?!.*latino)/.test(t)) return 'ESP'
  if (/latino|lat\b/.test(t)) return 'LAT'
  if (/vose|subtitulad|sub\b/.test(t)) return 'VOSE'
  if (/ingl[eé]s|english|\beng\b/.test(t)) return 'ENG'
  return ''
}

function stripLangFromTitle(title) {
  return (title || '')
    .replace(/\s*(castellano|español|latino|vose|subtitulado|sub|ingl[eé]s|english)\s*/gi, ' ')
    .trim() || 'embed'
}

function extractEmbedUrl(json, referer) {
  try {
    const data = JSON.parse(json)
    let embed = data?.embed_url
    if (!embed) return ''
    // Some sites wrap the player URL in an <IFRAME SRC="…"> snippet.
    const m = embed.match(/src=["'](https?:[^"']+)["']/i)
    if (m) embed = m[1]
    return absoluteUrl(decodeEntities(embed), referer)
  } catch {
    return ''
  }
}

export function makeDooplayChannel({ id, name, host, defaultLang = 'ESP' }) {
  const HOST = host.endsWith('/') ? host : host + '/'

  async function parseCard(block, typeFilter) {
    const itemUrl = findSingleMatch(block, `href=["'](${HOST.replace(/\//g, '\\/')}(?:movies|tvshows)\\/[a-z0-9-]+\\/?)["']`)
    if (!itemUrl) return null
    const isSeries = itemUrl.includes('/tvshows/')
    if (typeFilter === CONTENT_TYPES.MOVIE && isSeries) return null
    if (typeFilter === CONTENT_TYPES.SERIES && !isSeries) return null
    const title = decodeEntities(
      findSingleMatch(block, "<h3[^>]*>([\\s\\S]*?)</h3>") || findSingleMatch(block, 'alt="([^"]*)"')
    ).trim()
    const poster = findSingleMatch(block, '<img[^>]*src="([^"]*)"')
    const year = findSingleMatch(block, '<span[^>]*>(\\d{4})</span>') || (title.match(/\((\d{4})\)/) || [])[1] || ''
    return {
      id: `${id}:${itemUrl}`,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster || null,
      year: year ? parseInt(year, 10) : null,
      url: itemUrl,
      pluginId: 'plurtasko',
    }
  }

  async function getStreamsForPage(url, signal) {
    const rawHtml = await fetchHtml(url, signal)
    if (!rawHtml) return []
    const streams = []
    const seen = new Set()
    for (const m of rawHtml.matchAll(OPTION_LI_RE)) {
      const tag = m[0]
      const inner = m[1]
      const post = tag.match(/data-post='(\d+)'/)?.[1]
      const dtype = tag.match(/data-type='(\w+)'/)?.[1]
      const nume = tag.match(/data-nume='([^']+)'/)?.[1]
      if (!post || !nume || nume === 'trailer') continue
      const optTitle = decodeEntities(findSingleMatch(inner, "<span class='title'>([\\s\\S]*?)</span>")).trim()
      const lang = parseLangFromTitle(optTitle)
      const serverTitle = stripLangFromTitle(optTitle)
      const body = new URLSearchParams({ action: 'doo_player_ajax', post, nume, type: dtype })
      const json = await postHtml(`${HOST}wp-admin/admin-ajax.php`, body.toString(), signal, { Referer: url })
      const videoUrl = extractEmbedUrl(json, HOST)
      if (!videoUrl || seen.has(videoUrl)) continue
      seen.add(videoUrl)
      const server = /uqload|filemoon|streamtape|dood|voe|mixdrop|upstream|okru|vidmoly|lulustream|mp4upload|sendvid|vidoza|supervideo|fastream|fivemanage|turbovid|streamwish|fembed|netu|waaw|youtube|mega|dailymotion|rumble|vk\.com/i.test(videoUrl)
        ? detectServerFromUrl(videoUrl)
        : serverTitle.toLowerCase().split(/[^a-z0-9]+/)[0]
      streams.push({
        name: `${server}${lang ? ` (${lang})` : ''}`,
        lang,
        url: videoUrl,
        streamType: normalizeServer(server),
        quality: '',
        server,
        pluginName: name,
        pluginId: 'plurtasko',
      })
    }
    return streams
  }

  return {
    id,
    name,
    defaultLang,
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
    host: HOST,

    catalogs: [
      { id: `${id}-movies`, name: `${name}: Películas`, type: CONTENT_TYPES.MOVIE },
      { id: `${id}-series`, name: `${name}: Series`, type: CONTENT_TYPES.SERIES },
    ],

    async getCatalog({ id: catId, skip = 0, top = 50, signal }) {
      const path = catId === `${id}-movies` ? 'movies/' : catId === `${id}-series` ? 'tvshows/' : null
      if (!path) return []
      const page = Math.floor(skip / 24) + 1
      const url = `${HOST}${path}${page > 1 ? `page/${page}/` : ''}`
      const html = await fetchHtml(url, signal)
      const type = path === 'movies/' ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES
      const items = []
      for (const m of findMultipleMatches(html, ARTICLE_RE)) {
        const item = await parseCard(m[1], type)
        if (item) items.push(item)
      }
      return items.slice(page > 1 ? 0 : skip % 24, (page > 1 ? 0 : skip % 24) + top)
    },

    async getMeta({ id: metaId, signal }) {
      const url = metaId.replace(`${id}:`, '')
      const html = cleanHtml(await fetchHtml(url, signal))
      const isSeries = url.includes('/tvshows/')
      let title = decodeEntities(findSingleMatch(html, '<h1[^>]*>([\\s\\S]*?)</h1>') || findSingleMatch(html, '<title>([\\s\\S]*?)</title>'))
        .replace(/\s*[|–-]\s*[^|–-]*$/, '').replace(/^Ver\s+/i, '').trim()
      const poster = findSingleMatch(html, '<div[^>]*class="poster"[^>]*>[\\s\\S]*?<img[^>]*src="([^"]*)"') ||
        findSingleMatch(html, '<img[^>]*class="[^"]*poster[^"]*"[^>]*src="([^"]*)"')
      const description = decodeEntities(findSingleMatch(html, '<div[^>]*class="(?:wp-content|description|resumen|sinopsis)"[^>]*>([\\s\\S]*?)</div>')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim()
      const year = findSingleMatch(html, '(\\d{4})')

      const meta = {
        id: metaId,
        type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: title,
        title,
        poster: poster || null,
        backdrop: poster || null,
        description,
        year: year ? parseInt(year, 10) : null,
        url,
        pluginId: 'plurtasko',
      }

      if (isSeries) {
        const episodes = []
        const epMatches = findMultipleMatches(html, "class='episodiotitle'><a href='([^']+)'[^>]*>([\\s\\S]*?)</a>")
        const numMatches = findMultipleMatches(html, "class='numerando'>(\\d+)\\s*-\\s*(\\d+)")
        epMatches.forEach((m, i) => {
          const epUrl = m[1]
          const epTitle = decodeEntities(m[2]).replace(/<[^>]*>/g, '').trim()
          const snum = numMatches[i] ? parseInt(numMatches[i][1], 10) : 1
          const enum_ = numMatches[i] ? parseInt(numMatches[i][2], 10) : i + 1
          episodes.push({
            id: `${id}:${epUrl}`,
            name: epTitle || `Episodio ${enum_}`,
            season: snum,
            episode: enum_,
            url: epUrl,
          })
        })
        meta.episodes = episodes
      }
      return meta
    },

    async getStreams({ id: streamId, signal }) {
      const url = streamId.replace(`${id}:`, '')
      return getStreamsForPage(url, signal)
    },

    async search({ query, type, signal }) {
      const html = await fetchHtml(`${HOST}?s=${encodeURIComponent(query)}`, signal)
      const items = []
      for (const m of findMultipleMatches(html, ARTICLE_RE)) {
        const item = await parseCard(m[1], type)
        if (item) items.push(item)
      }
      // Some sites Cloudflare-protect the ?s= endpoint but leave content pages
      // readable — fall back to a site:-scoped Google search for URLs.
      if (!items.length) {
        const host = new URL(HOST).hostname
        const urls = await googleSiteSearch(host, query, signal)
        for (const itemUrl of urls) {
          if (!itemUrl.startsWith(HOST) && !itemUrl.startsWith(HOST.replace('www.', ''))) continue
          const isSeries = itemUrl.includes('/tvshows/')
          const isMovie = itemUrl.includes('/movies/')
          if (!isSeries && !isMovie) continue
          if (type === CONTENT_TYPES.MOVIE && !isMovie) continue
          if (type === CONTENT_TYPES.SERIES && !isSeries) continue
          const title = decodeURIComponent(itemUrl.split('/').filter(Boolean).pop() || '').replace(/-/g, ' ')
          items.push({
            id: `${id}:${itemUrl}`,
            type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
            name: title,
            title,
            poster: null,
            url: itemUrl,
            pluginId: 'plurtasko',
          })
        }
      }
      const seen = new Set()
      return items.filter(it => (seen.has(it.url) ? false : seen.add(it.url)))
    },
  }
}
