// AnimeAV1 channel - ported from Plurtasko's animeav1.py
// Provides anime in Spanish (Latino/DUB and Subtitulado/SUB)
// Domain moved from animeav1.com → wwv.animeav1.one (2025)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer, hex2a } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://wwv.animeav1.one/'

export const animeav1 = {
  id: 'animeav1',
  name: 'AnimeAV1',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,

  catalogs: [
    { id: 'animeav1-latest', name: 'AnimeAV1: Últimos', type: CONTENT_TYPES.SERIES },
    { id: 'animeav1-popular', name: 'AnimeAV1: Populares', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const page = Math.floor(skip / 20) + 1
    let url
    if (id === 'animeav1-latest') url = `${HOST}catalogo?page=${page}`
    else if (id === 'animeav1-popular') url = `${HOST}catalogo?sort=popular&page=${page}`
    else return []

    const html = await fetchHtml(url)
    if (!html) return []
    const items = []
    // New structure: <article class="li"><figure>...<a href="./anime/<slug>"...>...
    //   <h3 class="h"><a href="./anime/<slug>" title="Ver ...">Title</a></h3></article>
    const matches = findMultipleMatches(html, '<article class="li">([\\s\\S]*?)</article>')
    for (const m of matches.slice(skip % 20, skip % 20 + top)) {
      const block = m[1] || m[0]
      let itemUrl = findSingleMatch(block, 'href="(\\./anime/[^"]+)"') || findSingleMatch(block, 'href="(anime/[^"]+)"')
      if (!itemUrl) continue
      let title = findSingleMatch(block, '<h3[^>]*>([\\s\\S]*?)</h3>')
      title = decodeEntities(title.replace(/<[^>]*>/g, '').trim())
      if (!title) title = findSingleMatch(block, 'title="([^"]*)"')
      const thumb = findSingleMatch(block, 'data-src="([^"]*)"') || findSingleMatch(block, 'src="([^"]*)"')
      if (!itemUrl) continue

      const fullUrl = absoluteUrl(itemUrl, HOST)
      const isMovie = block.includes('>Películas<') || block.includes('>Pelicula<')
      items.push({
        id: `animeav1:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(0, top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^animeav1:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    let title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || findSingleMatch(html, '<title>(.*?)</title>')
    title = decodeEntities(title).replace(/\s*\|.*$/, '').replace(/\s*Online.*$/i, '').trim()
    const poster = findSingleMatch(html, 'og:image"\s*content="([^"]*)"') || findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, 'og:description"\s*content="([^"]*)"') || findSingleMatch(html, '<p[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</p>')

    const meta = {
      id,
      type: CONTENT_TYPES.SERIES,
      name: title,
      title,
      poster: poster ? absoluteUrl(poster, HOST) : null,
      backdrop: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      url,
      pluginId: 'plurtasko',
    }

    meta.episodes = await this._getEpisodes(url, html)
    return meta
  },

  async _getEpisodes(url, html) {
    const episodes = []
    // Episode data is in a JS array: const data = [[1,"4437-1"],[2,"4437-2"]];
    const dataMatch = findSingleMatch(html, 'const\\s+data\\s*=\\s*(\\[\\[\\d+,["\'][^\\]]+["\']\\][\\s\\S]*?\\])')
    if (dataMatch) {
      // Parse the JS array of [episodeNumber, episodeId] pairs
      const pairs = findMultipleMatches(dataMatch, '\\[(\\d+),["\']([^"\']+)["\']\\]')
      for (const m of pairs) {
        const epNum = parseInt(m[1], 10)
        // Episode URL: ./ver/<slug>/<epNum>
        const slug = findSingleMatch(url, '/anime/([^/?]+)')
        if (slug) {
          const epUrl = `${HOST}ver/${slug}/${epNum}`
          episodes.push({
            id: `animeav1:${epUrl}`,
            name: `Episodio ${epNum}`,
            season: 1,
            episode: epNum,
            url: epUrl,
          })
        }
      }
    }

    // Fallback: find episode links in HTML
    if (episodes.length === 0) {
      const slug = findSingleMatch(url, '/anime/([^/?]+)')
      const epMatches = findMultipleMatches(html, `href="[^"]*/ver/${slug}/(\\d+)[^"]*"`)
      const seen = new Set()
      for (const m of epMatches) {
        const epNum = parseInt(m[1], 10)
        if (seen.has(epNum)) continue
        seen.add(epNum)
        episodes.push({
          id: `animeav1:${HOST}ver/${slug}/${epNum}`,
          name: `Episodio ${epNum}`,
          season: 1,
          episode: epNum,
          url: `${HOST}ver/${slug}/${epNum}`,
        })
      }
    }

    episodes.sort((a, b) => a.episode - b.episode)
    return episodes
  },

  async getStreams({ id }) {
    let url = id.replace(/^animeav1:/, '')
    let html = await fetchHtml(url)
    if (!html) return []

    // Si es una página /anime/ (no /ver/), no tiene el player.
    // Obtener el primer episodio y usar esa URL.
    if (/\/anime\//.test(url) && !/data-encrypt=/.test(html)) {
      const eps = await this._getEpisodes(url, html)
      if (eps.length > 0 && eps[0].url) {
        url = eps[0].url
        html = await fetchHtml(url)
        if (!html) return []
      }
    }

    const streams = []

    // The episode page has <div class="opt" data-encrypt="<hex>">.
    // POST {acc:'opt', i:'<hex>'} to ./av1 returns <li> elements with
    // encrypt="<hex url>" attributes. hex2a() decodes each to the embed URL.
    const enc = findSingleMatch(html, 'class="[^"]*opt[^"]*"[^>]*data-encrypt="(.*?)"')
             || findSingleMatch(html, 'data-encrypt="(.*?)"[^>]*class="[^"]*opt')
             || findSingleMatch(html, 'data-encrypt="(.*?)"')
    if (enc) {
      const body = await postHtml(`${HOST}av1`, `acc=opt&i=${encodeURIComponent(enc)}`, null, {
        'Referer': url,
        'X-Requested-With': 'XMLHttpRequest',
      })
      if (body) {
        // Each <li encrypt="<hex>" ...> has a <span>ServerName</span>
        const serverMatches = findMultipleMatches(body, '(?:<li|<div)[^>]*encrypt="([0-9a-fA-F]+)"[^>]*>([\\s\\S]*?)(?:</li>|</div>)')
        for (const m of serverMatches) {
          const rawUrl = hex2a(m[1])
          const embedUrl = absoluteUrl(rawUrl, HOST)
          if (!embedUrl || !/^https?:/i.test(embedUrl)) continue
          // Skip images/assets
          if (/\.(webp|jpe?g|png|gif|svg|css|js|ico|woff2?)(\?|$)/i.test(embedUrl)) continue
          if (embedUrl.includes('youtube.com/embed') || /trailer/i.test(embedUrl)) continue
          const label = findSingleMatch(m[2], '<span>(.*?)</span>').replace(/<[^>]*>/g, '').toLowerCase().trim()
          const server = this._detectServer(embedUrl) || label || 'embed'
          if (streams.some(s => s.url === embedUrl)) continue
          streams.push({
            name: `${server}`,
            url: embedUrl,
            streamType: normalizeServer(server),
            quality: '',
            server,
            lang: detectLangFromText(label) || (/dub/i.test(label) ? 'Lat' : ''),
            pluginName: 'AnimeAV1',
            pluginId: 'plurtasko',
          })
        }
      }
    }

    // Fallback: find iframe src
    if (streams.length === 0) {
      const iframeMatches = findMultipleMatches(html, '<iframe[^>]*src=["\'](.*?)["\']')
      for (const m of iframeMatches) {
        const embedUrl = absoluteUrl(m[1], HOST)
        if (!/^https?:/i.test(embedUrl)) continue
        if (embedUrl.includes('youtube.com/embed') || /trailer/i.test(embedUrl)) continue
        const server = this._detectServer(embedUrl) || 'embed'
        streams.push({
          name: `${server}`,
          url: embedUrl,
          streamType: normalizeServer(server),
          quality: '',
          server,
          pluginName: 'AnimeAV1',
          pluginId: 'plurtasko',
        })
      }
    }

    return streams
  },

  _detectServer(url) {
    const u = (url || '').toLowerCase()
    if (/voe\.|eugenemakedraw|morencius/.test(u)) return 'voe'
    if (/zilla-networks/.test(u)) return 'zilla'
    if (/streamwish|hglink|hanerix|audinifer|sfastwish/.test(u)) return 'streamwish'
    if (/dood|do0od|d000d/.test(u)) return 'doodstream'
    if (/streamtape|streamta\.pe/.test(u)) return 'streamtape'
    if (/filemoon|filelions/.test(u)) return 'filemoon'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/upstream/.test(u)) return 'upstream'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/yourupload/.test(u)) return 'yourupload'
    if (/mega\.nz/.test(u)) return 'mega'
    if (/fastream/.test(u)) return 'fastream'
    if (/ok\.ru|okru/.test(u)) return 'okru'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/lulustream|lulu/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/uns\.bio|upnshare/.test(u)) return 'upnshare'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/mediafire/.test(u)) return 'mediafire'
    return 'embed'
  },

  async search({ query, type, signal }) {
    const url = `${HOST}catalogo?buscar=${encodeURIComponent(query)}`
    const html = await fetchHtml(url, signal)
    if (!html) return []
    const items = []
    const matches = findMultipleMatches(html, '<article class="li">([\\s\\S]*?)</article>')
    for (const m of matches) {
      const block = m[1] || m[0]
      let itemUrl = findSingleMatch(block, 'href="(\\./anime/[^"]+)"') || findSingleMatch(block, 'href="(anime/[^"]+)"')
      if (!itemUrl) continue
      let title = findSingleMatch(block, '<h3[^>]*>([\\s\\S]*?)</h3>')
      title = decodeEntities(title.replace(/<[^>]*>/g, '').trim())
      if (!title) title = findSingleMatch(block, 'title="([^"]*)"')
      const thumb = findSingleMatch(block, 'data-src="([^"]*)"') || findSingleMatch(block, 'src="([^"]*)"')
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const isMovie = block.includes('>Películas<') || block.includes('>Pelicula<')
      items.push({
        id: `animeav1:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    // Deduplicate
    const seen = new Set()
    return items.filter(item => {
      if (seen.has(item.url)) return false
      seen.add(item.url)
      return true
    })
  },
}
