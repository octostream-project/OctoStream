// JKAnime channel - ported from Plurtasko's jkanime.py
// Anime in Spanish (Vose) - movies and series
// Uses CSRF-protected AJAX for episodes, var servers + iframe arrays for videos

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, decodeEntities, absoluteUrl } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://jkanime.net/'

export const jkanime = {
  id: 'jkanime',
  name: 'JKAnime',
  types: [CONTENT_TYPES.SERIES, CONTENT_TYPES.MOVIE, CONTENT_TYPES.ANIME],
  host: HOST,

  catalogs: [
    { id: 'jkanime-series', name: 'JKAnime: Catálogo', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const page = Math.floor(skip / 24) + 1
    const isMovie = id === 'jkanime-movies'
    const url = `${HOST}directorio/${page}/`
    const html = await fetchHtml(url)
    if (!html) return []

    const items = []
    // Extraer del JSON embebido var animes = {...}
    const animesJsonMatch = findSingleMatch(html, 'var animes =\\s*(\\{.*?\\});')
    if (animesJsonMatch) {
      try {
        const parsed = JSON.parse(animesJsonMatch)
        const list = Array.isArray(parsed?.data) ? parsed.data : []
        for (const it of list) {
          const itemType = String(it.type || it.tipo || '').toLowerCase()
          const isItemMovie = itemType.includes('movie') || itemType.includes('pelicula') || itemType.includes('película')
          if (isMovie && !isItemMovie) continue
          if (!isMovie && isItemMovie) continue

          const fullUrl = it.url || `${HOST}${it.slug}/`
          const itemTitle = it.title || it.short_title || ''
          if (!itemTitle || /\{(?:titulo|title)\}/i.test(itemTitle) || !fullUrl || /\{[^}]+\}/.test(fullUrl)) continue
          items.push({
            id: `jkanime:${fullUrl}`,
            type: isItemMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
            name: itemTitle,
            title: itemTitle,
            poster: it.image || null,
            url: fullUrl,
            pluginId: 'plurtasko',
          })
        }
      } catch {}
    }

    if (items.length > 0) return items.slice(0, top)

    // Fallback: parsear HTML si no viene JSON
    const matches = findMultipleMatches(html, '<div[^>]*class="[^"]*(?:card|d-thumb|anime__item)[^"]*"[\\s\\S]*?<a[^>]*href="([^"]+)"[\\s\\S]*?<img[^>]*src="([^"]+)"[\\s\\S]*?<h5[^>]*>([^<]+)</h5>')
    for (const m of matches) {
      const itemUrl = m[1]
      const thumb = m[2]
      const title = decodeEntities(m[3].trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      items.push({
        id: `jkanime:${fullUrl}`,
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
    const url = id.replace(/^jkanime:/, '')
    const html = await fetchHtml(url)
    if (!html) return null

    const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>')
      || findSingleMatch(html, '<meta[^>]*property="og:title"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<title>(.*?)</title>')
      || ''
    const poster = findSingleMatch(html, '<meta[^>]*property="og:image"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<img[^>]*src="([^"]*)"')
    const description = findSingleMatch(html, '<meta[^>]*name="description"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<p[^>]*>(.*?)</p>')
      || ''

    const isMovie = url.includes('pelicula')
    const meta = {
      id,
      type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
      name: decodeEntities(title).replace(/\s+-\s+anime\s+.*$/i, '').replace(/\s+-\s*JkAnime.*$/i, '').trim(),
      title: decodeEntities(title).replace(/\s+-\s+anime\s+.*$/i, '').replace(/\s+-\s*JkAnime.*$/i, '').trim(),
      poster: poster ? absoluteUrl(poster, HOST) : null,
      description: decodeEntities(description) || '',
      url,
      pluginId: 'plurtasko',
    }

    if (!isMovie) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  async _getEpisodes(url, html) {
    const episodes = []

    // Get CSRF token and series ID
    const token = findSingleMatch(html, '<meta name="csrf-token" content="(.*?)"')
    // JKAnime exposes episode pages as /<slug>/<number>/ even when its
    // pagination endpoint rejects the AJAX request. Keep a usable first
    // episode fallback instead of hiding the whole provider.
    const firstEpisode = () => [{
      id: `jkanime:${url.replace(/\/$/, '')}/1/`,
      name: 'S1E1',
      season: 1,
      episode: 1,
      url: `${url.replace(/\/$/, '')}/1/`,
    }]
    if (!token) return firstEpisode()

    const idSerie = findSingleMatch(html, '/ajax/episodes/(\\d+)/')
    if (!idSerie) return firstEpisode()

    // Fetch episodes via AJAX
    const ajaxUrl = `${HOST}ajax/episodes/${idSerie}/1/`
    const ajaxResult = await postHtml(ajaxUrl, `_token=${token}`, null, {
      'Referer': url,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': token,
    })
    if (!ajaxResult) return firstEpisode()

    const total = findSingleMatch(ajaxResult, '"total":(\\d+)')
    if (!total) return firstEpisode()

    // Parse episodes from JSON response
    const matches = findMultipleMatches(ajaxResult, '"number":(\\d+),"title":"([^"]+)"')
    for (const m of matches) {
      const nro = m[1]
      const epTitle = m[2]
      const cleanTitle = decodeEntities(epTitle.trim())
      const epUrl = url.endsWith('/') ? `${url}${nro}/` : `${url}/${nro}/`

      episodes.push({
        id: `jkanime:${epUrl}`,
        name: `S1E${nro} ${cleanTitle}`,
        season: 1,
        episode: parseInt(nro, 10),
        url: epUrl,
      })
    }

    // Fetch more pages if needed
    let loaded = matches.length
    let pageNum = 1
    while (loaded < parseInt(total, 10) && pageNum < 20) {
      pageNum++
      const nextUrl = `${HOST}ajax/episodes/${idSerie}/${pageNum}/`
      const nextResult = await postHtml(nextUrl, `_token=${token}`, null, {
        'Referer': url,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': token,
      })
      if (!nextResult) break

      const nextMatches = findMultipleMatches(nextResult, '"number":(\\d+),"title":"([^"]+)"')
      for (const m of nextMatches) {
        const nro = m[1]
        const epTitle = m[2]
        const cleanTitle = decodeEntities(epTitle.trim())
        const epUrl = url.endsWith('/') ? `${url}${nro}/` : `${url}/${nro}/`

        episodes.push({
          id: `jkanime:${epUrl}`,
          name: `S1E${nro} ${cleanTitle}`,
          season: 1,
          episode: parseInt(nro, 10),
          url: epUrl,
        })
      }
      loaded += nextMatches.length
      if (nextMatches.length === 0) break
    }

    return episodes
  },

  async getStreams({ id }) {
    let url = id.replace(/^jkanime:/, '')
    let html = await fetchHtml(url)
    if (!html) return []

    // Si es una página de anime (no de episodio), no tiene player.
    // JKAnime usa /<slug>/ para anime y /<slug>/<num>/ para episodios.
    if (/\/$/.test(url) && !url.match(/\/\d+\/?$/)) {
      const eps = await this._getEpisodes(url, html)
      if (eps.length > 0 && eps[0].url) {
        url = eps[0].url
        html = await fetchHtml(url)
        if (!html) return []
      }
    }

    const streams = []

    // Fix broken HTML (jkanime has malformed src attributes)
    html = html.replace(/src=https/g, 'src="https').replace(/\/ width="/g, '/" width="')

    // El idioma del episodio sale del <title> de la página ("Sub Español",
    // "Latino"…); sin pista queda sin etiqueta en vez de asumir VOSE.
    const pageLang = detectLangFromText(findSingleMatch(html, '<title[^>]*>(.*?)</title>') || '')

    const pushStream = (streamUrl, server, srvName) => {
      if (!streamUrl || !server) return
      if (streams.some(st => st.url === streamUrl)) return
      streams.push({
        name: `${srvName || server}${pageLang ? ` (${pageLang})` : ''}`,
        url: streamUrl,
        streamType: normalizeServer(server),
        quality: '',
        server,
        lang: pageLang,
        pluginName: 'JKAnime',
        pluginId: 'plurtasko',
      })
    }

    // Parse var servers — each object has a base64 "remote" URL and a server name.
    // The servers array is JSON: var servers = [{...},{...},...];
    // Use a greedy match up to "];" to capture all objects.
    const vServers = findSingleMatch(html, 'var servers\\s*=\\s*(\\[[\\s\\S]*?\\]);')
    if (vServers) {
      // Parse as JSON first (most reliable), fall back to regex object extraction
      let serverList = null
      try { serverList = JSON.parse(vServers) } catch {}
      if (Array.isArray(serverList)) {
        for (const obj of serverList) {
          const remoteB64 = obj.remote
          const srvName = obj.server || obj.title || obj.name
          if (!remoteB64) continue
          let remoteUrl = ''
          try { remoteUrl = atob(remoteB64) } catch {}
          if (!remoteUrl.startsWith('http')) remoteUrl = remoteB64.startsWith('http') ? remoteB64 : ''
          if (!remoteUrl) continue
          const server = this._detectServer(remoteUrl) || (srvName || '').toLowerCase()
          pushStream(remoteUrl, server, srvName)
        }
      } else {
        // Fallback: regex extraction of each {..."remote"...} object
        const serverObjs = findMultipleMatches(vServers, '\\{([^{}]*"remote"[^{}]*)\\}')
        for (const m of serverObjs) {
          const remoteB64 = findSingleMatch(m[1], '"remote"\\s*:\\s*"(.*?)"')
          const srvName = findSingleMatch(m[1], '"(?:server|title|name)"\\s*:\\s*"(.*?)"')
          if (!remoteB64) continue
          let remoteUrl = ''
          try { remoteUrl = atob(remoteB64) } catch {}
          if (!remoteUrl.startsWith('http')) remoteUrl = remoteB64.startsWith('http') ? remoteB64 : ''
          if (!remoteUrl) continue
          const server = this._detectServer(remoteUrl) || (srvName || '').toLowerCase()
          pushStream(remoteUrl, server, srvName)
        }
      }
    }

    // Parse video[N] = '<iframe ...>' array — src may be quoted or not
    const videoBlocks = findMultipleMatches(html, 'video\\[\\d+\\]\\s*=\\s*[\'"]([\\s\\S]*?)[\'"];')
    for (const m of videoBlocks) {
      let cleanUrl = findSingleMatch(m[1], 'src=["\']?([^"\'\\s>]+)')
      if (!cleanUrl || cleanUrl === "/','src=") continue

      // Rewrite um2.php to um.php
      if (cleanUrl.includes('/um2.php')) cleanUrl = cleanUrl.replace('/um2.php', '/um.php')

      // Resolve relative URLs
      if (!cleanUrl.startsWith('http')) {
        if (cleanUrl.startsWith('/')) cleanUrl = HOST.slice(0, -1) + cleanUrl
        else cleanUrl = 'https:' + cleanUrl
      }

      // Handle jkanime-specific URL rewrites
      if (cleanUrl.includes('/jkokru.php?u=')) {
        cleanUrl = cleanUrl.replace('/jkokru.php?u=', 'https://ok.ru/videoembed/')
      }
      if (cleanUrl.includes('/jkvmixdrop?u=')) {
        cleanUrl = cleanUrl.replace('/jkvmixdrop?u=', 'https://mixdrop.co/e/')
      }

      pushStream(cleanUrl, this._detectServer(cleanUrl))
    }

    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/voe|voex/.test(u)) return 'voe'
    if (/fastream/.test(u)) return 'fastream'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/upstream/.test(u)) return 'upstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/ok\.ru|odnoklassniki/.test(u)) return 'okru'
    if (/kwik/.test(u)) return 'kwik'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/fastplay/.test(u)) return 'fastplay'
    if (/lulustream/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/mediafire/.test(u)) return 'mediafire'
    if (/mega\.nz|mega\.co/.test(u)) return 'mega'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    // jkanime c1.php and um.php wrappers
    if (/c1\.php|um\.php|jk\.php/.test(u)) return 'directo'
    return ''
  },

  async search({ query, type, signal }) {
    const url = `${HOST}buscar/${encodeURIComponent(query.replace(/ /g, '_'))}/`
    const html = await fetchHtml(url, signal)
    if (!html) return []

    const items = []
    // New HTML structure (2024+): <div class="anime__item"> with <a href> + data-setbg + <h5><a>title</a></h5>
    const matches = findMultipleMatches(html, '<div class="anime__item">([\\s\\S]*?)</div>\\s*</div>\\s*</div>')
    for (const m of matches) {
      const block = m[1] || m[0]
      const itemUrl = findSingleMatch(block, 'href="(https://jkanime\\.net/[^"#]+/)"')
      // Title is in <h5><a href="...">Title</a></h5>
      let title = findSingleMatch(block, '<h5>\\s*<a[^>]*>([^<]+)</a>')
      if (!title) title = findSingleMatch(block, 'alt="(.*?)"')
      if (!title) title = findSingleMatch(block, 'card-title">([^<]*)')
      // Thumb is in data-setbg attribute
      const thumb = findSingleMatch(block, 'data-setbg="([^"]+)"')
      if (!itemUrl || !title) continue

      title = decodeEntities(title.replace(/"/g, '').replace(/&/g, '').replace(/&#039;/g, "'").trim())
      const fullUrl = absoluteUrl(itemUrl, HOST)
      const isMovie = /\b(pelicula|movie|film|ova|final)\b/i.test(fullUrl) || /\b(Película|Movie|OVA|Final)\b/i.test(title)

      if (type === CONTENT_TYPES.MOVIE && !isMovie) continue
      if (type === CONTENT_TYPES.SERIES && isMovie) continue

      items.push({
        id: `jkanime:${fullUrl}`,
        type: isMovie ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, HOST) : null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items
  },
}
