// AnimeFlvOne channel - ported from Plurtasko's animeflvone.py
// Provides anime series and movies.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, cleanHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer, hex2a } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://vww.animeflv.one/'

export const animeflvone = {
  id: 'animeflvone',
  name: 'AnimeFlvOne',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,

  catalogs: [
    { id: 'animeflvone-all', name: 'AnimeFlvOne: Catálogo', type: CONTENT_TYPES.ANIME },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'animeflvone-latest') url = `${HOST}latest`
    else if (id === 'animeflvone-peliculas') url = `${HOST}peliculas`
    else url = HOST

    const items = await this._listAll(url)
    return items.slice(skip, skip + top)
  },

  async _listAll(url) {
    const html = cleanHtml(await fetchHtml(url))
    const items = []
    const bloque = findSingleMatch(html, '<button>Filtrar</button>(.*?)$')
    const matches = findMultipleMatches(bloque || html, '<article(.*?)</article>')

    for (const match of matches) {
      const block = match[1].replace(/""/g, '"').trim()
      let itemUrl = findSingleMatch(block, ' href="(.*?)"')
      let title = findSingleMatch(block, 'alt="(.*?)"')
      if (!title) title = findSingleMatch(block, 'title=".*?"')
      if (!itemUrl || !title) continue
      // Only return anime pages from this provider, not external news articles.
      try {
        const itemHost = new URL(itemUrl, HOST).hostname
        if (itemHost !== new URL(HOST).hostname || !itemUrl.includes('/anime/')) continue
      } catch { continue }

      title = title.replace('#8217;', "'").replace('Ver ', '').replace(/\s+Online.*$/i, '').trim()
      let thumb = findSingleMatch(block, ' data-src="(.*?)"') || findSingleMatch(block, ' src="(.*?)"')
      // Convertir URLs relativas de imágenes a absolutas
      if (thumb && !thumb.startsWith('http')) {
        thumb = HOST.replace(/\/$/, '') + '/' + thumb.replace(/^\.\//, '').replace(/^\//, '')
      }

      if (itemUrl.startsWith('./')) itemUrl = HOST.replace(/\/$/, '') + itemUrl.replace('./', '/')
      else if (!itemUrl.startsWith('http')) itemUrl = HOST.replace(/\/$/, '') + '/' + itemUrl.replace(/^\//, '')

      const isMovie = block.includes('>Pelicula<') || url.includes('?tipo=pelicula')
      const type = isMovie ? 'movie' : 'series'

      items.push({
        id: `animeflvone:${itemUrl}`,
        type: type === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: thumb || null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    return items
  },

  async getMeta({ id }) {
    const url = id.replace(/^animeflvone:/, '')
    const html = cleanHtml(await fetchHtml(url))
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>')
             || findSingleMatch(html, 'og:title"\s*content="([^"]*)"')
             || findSingleMatch(html, '<title>(.*?)</title>')
    const poster = findSingleMatch(html, 'og:image"\s*content="([^"]*)"')
             || findSingleMatch(html, '<img[^>]*class="[^"]*cover[^"]*"[^>]*src="(.*?)"')
             || findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, 'og:description"\s*content="([^"]*)"')
             || findSingleMatch(html, '<div class="[^"]*description[^"]*"[^>]*>(.*?)</div>')
             || findSingleMatch(html, '<p[^>]*>(.*?)</p>')

    const cleanTitle = decodeEntities(title).replace(/^Ver\s+/i, '').replace(/\s+(Sub\s+español|Online|latino|Sub español latino).*$/i, '').trim()

    const meta = {
      id: `animeflvone:${url}`,
      type: CONTENT_TYPES.SERIES,
      name: cleanTitle || url,
      title: cleanTitle || url,
      poster: poster || null,
      backdrop: poster || null,
      description: decodeEntities(description) || '',
      url,
      pluginId: 'plurtasko',
    }

    meta.episodes = await this._getEpisodes(url, html)
    return meta
  },

  async _getEpisodes(url, html = null) {
    // Reutiliza el HTML ya descargado por getMeta en vez de refetchear
    html = html || cleanHtml(await fetchHtml(url))
    const episodes = []

    // Episode data is in a JS array: var eps = [["1","0",""], ["2","1",""], ...]
    // Each element is [episode_number, episode_id, cod]
    // Episode URL: ./ver/<slug>-<episode_number>[-<cod>]
    // For movies, the format is a flat array: ["1","0",""]
    const slug = findSingleMatch(url, '/anime/([^/?#]+)') || findSingleMatch(url, 'anime/([^/?#]+)')
    const epsMatch = findSingleMatch(html, 'var\\s+eps\\s*=\\s*(\\[\\s*\\[[\\s\\S]*?\\]\\s*\\])')
    if (epsMatch) {
      // Parse the JS array of [num, id, cod] triples
      const pairs = findMultipleMatches(epsMatch, '\\["?([^"\\],]+)"?,\\s*"([^"]*)",?\\s*"([^"]*)"\\]')
      for (const m of pairs) {
        const epNum = m[1]
        const cod = m[3] || ''
        if (!slug || !epNum) continue
        const epUrl = `${HOST.replace(/\/$/, '')}/ver/${slug}-${epNum}${cod ? '-' + cod : ''}`
        episodes.push({
          id: `animeflvone:${epUrl}`,
          name: `Episodio ${epNum}`,
          season: 1,
          episode: parseInt(epNum, 10) || episodes.length + 1,
          url: epUrl,
        })
      }
    }

    // Fallback for movies: flat array format ["1","0",""]
    if (episodes.length === 0) {
      const flatMatch = findSingleMatch(html, 'var\\s+eps\\s*=\\s*\\["?(\\d+)"?,\\s*"[^"]*"\\s*,?\\s*"[^"]*"\\]')
      if (flatMatch && slug) {
        const epNum = flatMatch
        const epUrl = `${HOST.replace(/\/$/, '')}/ver/${slug}-${epNum}`
        episodes.push({
          id: `animeflvone:${epUrl}`,
          name: `Episodio ${epNum}`,
          season: 1,
          episode: parseInt(epNum, 10) || 1,
          url: epUrl,
        })
      }
    }

    // Fallback: find actual episode links in HTML
    if (episodes.length === 0) {
      const matches = findMultipleMatches(html, 'href="([^"]*/ver/[^"]*?-\\d+[^"]*)"')
      const seen = new Set()
      for (const m of matches) {
        const epUrl = m[1].replace(/^\.\//, HOST)
        if (seen.has(epUrl) || epUrl.includes("${")) continue
        seen.add(epUrl)
        const epMatch = epUrl.match(/-(\d+)(?:-|$)/)
        const epNum = epMatch ? parseInt(epMatch[1], 10) : episodes.length + 1
        episodes.push({
          id: `animeflvone:${epUrl}`,
          name: `Episodio ${epNum}`,
          season: 1,
          episode: epNum,
          url: epUrl,
        })
      }
    }

    episodes.sort((a, b) => a.episode - b.episode)
    return episodes
  },

  async getStreams({ id }) {
    let url = id.replace(/^animeflvone:/, '')
    let html = cleanHtml(await fetchHtml(url))
    if (!html) return []

    // Si es una página /anime/ (no /ver/), no tiene el player.
    // Obtener el primer episodio y usar esa URL.
    if (/\/anime\//.test(url) && !/data-encrypt=/.test(html)) {
      const eps = await this._getEpisodes(url, html)
      if (eps.length > 0 && eps[0].url) {
        url = eps[0].url
        html = cleanHtml(await fetchHtml(url))
        if (!html) return []
      }
    }

    const streams = []

    const addStream = (rawUrl, serverHint = '') => {
      const embedUrl = absoluteUrl(String(rawUrl || '').replace(/\\\//g, '/'), HOST)
      if (!/^https?:/i.test(embedUrl)) return
      // Skip lazy-load images/assets picked up by the data-* fallback
      if (/\.(webp|jpe?g|png|gif|svg|css|js|ico|woff2?)(\?|$)/i.test(embedUrl)) return
      if (embedUrl.includes('youtube.com/embed') || /trailer/i.test(embedUrl)) return
      if (streams.some(stream => stream.url === embedUrl)) return
      const server = serverHint
        || embedUrl.match(/(?:voe\.|dood|ok\.ru|streamtape|filemoon|filelions|mixdrop|upstream|fembed|mega\.nz|streamwish|mp4upload|yourupload|uqload|streamium|vidhide|fastream|lulustream|sendvid|turbovid|vidmoly)/i)?.[0]?.replace(/\..*/, '')
        || 'embed'
      // El idioma sale del label del server ("latino"/"dub"→doblaje);
      // sin pista queda sin etiqueta en vez de asumir VOSE.
      const langLabel = detectLangFromText(serverHint) || (/dub/i.test(serverHint) ? 'Lat' : '')
      streams.push({
        name: `${server}${langLabel ? ` (${langLabel})` : ''}`,
        url: embedUrl,
        streamType: normalizeServer(server),
        quality: '720',
        server,
        lang: langLabel,
        pluginName: 'AnimeFlvOne',
        pluginId: 'plurtasko',
      })
    }

    // The player list is loaded via AJAX: the episode page has
    // <ul class="opt" data-encrypt="<hex>"> and POSTing {acc:'opt', i:<hex>}
    // to ./flv returns <li encrypt="<hex url>"><span>ServerName</span></li> items.
    const enc = findSingleMatch(html, 'class="[^"]*opt[^"]*"[^>]*data-encrypt="(.*?)"')
             || findSingleMatch(html, 'data-encrypt="(.*?)"[^>]*class="[^"]*opt')
             || findSingleMatch(html, 'data-encrypt="(.*?)"')
    if (enc) {
      const body = await postHtml(`${HOST}flv`, `acc=opt&i=${encodeURIComponent(enc)}`, null, {
        'Referer': url,
        'X-Requested-With': 'XMLHttpRequest',
      })
      for (const m of findMultipleMatches(body, '<li[^>]*encrypt="([0-9a-fA-F]+)"[^>]*>([\\s\\S]*?)</li>')) {
        const embedUrl = hex2a(m[1])
        const label = findSingleMatch(m[2], '<span>(.*?)</span>').replace(/<[^>]*>/g, '').toLowerCase().trim()
        addStream(embedUrl, label)
      }
    }

    // Fallbacks for older layouts: iframes, data-player attrs, videos[] scripts
    const iframeMatches = findMultipleMatches(html, '<iframe[^>]*src=["\'](.*?)["\']')
    for (const m of iframeMatches) addStream(m[1])
    const dataPlayerMatches = findMultipleMatches(html, '(?:data-player|data-video)=["\'](.*?)["\']')
    for (const m of dataPlayerMatches) addStream(m[1])

    // Extract video server links from script blocks
    const scriptMatches = findMultipleMatches(html, 'videos\\["([^"]*)"\\]\\s*=\\s*"([^"]*)"')
    for (const m of scriptMatches) {
      const server = m[1].toLowerCase().trim()
      if (server === 'trailer') continue
      addStream(m[2], server)
    }

    return streams
  },

  async search({ query, signal }) {
    const url = `${HOST}animes?buscar=${encodeURIComponent(query)}`
    const html = cleanHtml(await fetchHtml(url, signal))
    if (!html) return []
    const items = []
    const matches = findMultipleMatches(html, '<article(.*?)</article>')

    for (const match of matches) {
      const block = match[1].replace(/""/g, '"').trim()
      let itemUrl = findSingleMatch(block, ' href="(.*?)"')
      let title = findSingleMatch(block, 'alt="(.*?)"')
      if (!itemUrl || !title) continue
      // Only return anime series, not episode entries (which have /ver/ in the URL)
      if (!itemUrl.includes('/anime/')) continue
      title = title.replace('#8217;', "'").replace('Ver ', '').trim()
      let thumb = findSingleMatch(block, ' data-src="(.*?)"') || findSingleMatch(block, ' src="(.*?)"')
      // Convertir URLs relativas de imágenes a absolutas
      if (thumb && !thumb.startsWith('http')) {
        thumb = HOST.replace(/\/$/, '') + '/' + thumb.replace(/^\.\//, '').replace(/^\//, '')
      }

      if (itemUrl.startsWith('./')) itemUrl = HOST.replace(/\/$/, '') + itemUrl.replace('./', '/')
      else if (!itemUrl.startsWith('http')) itemUrl = HOST.replace(/\/$/, '') + '/' + itemUrl.replace(/^\//, '')

      items.push({
        id: `animeflvone:${itemUrl}`,
        type: CONTENT_TYPES.SERIES,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: thumb || null,
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    return items
  },
}
