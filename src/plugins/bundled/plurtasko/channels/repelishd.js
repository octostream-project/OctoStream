// Repelishd channel - ported from Plurtasko's repelishd.py
// Provides movies and series in Spanish (Latino, Castellano, Vose)

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, decodeEntities } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer, detectServerFromUrl } from '../scraper.js'
import { detectLangFromText } from '../meta.js'

const HOST = 'https://repelishd.courses/'

export const repelishd = {
  id: 'repelishd',
  name: 'RepelisHD',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: HOST,

  catalogs: [
    { id: 'repelishd-movies', name: 'RepelisHD: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'repelishd-series', name: 'RepelisHD: Series', type: CONTENT_TYPES.SERIES },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'repelishd-movies') url = `${HOST}pelicula/`
    else if (id === 'repelishd-series') url = `${HOST}series/`
    else return []

    const html = await fetchHtml(url)
    const items = []
    const bloque = findSingleMatch(html, 'Añadido recientemente<([\\s\\S]*?)>Películas Destacadas<')
    const matches = findMultipleMatches(bloque, '<article([\\s\\S]*?)</article>')
    for (const m of matches) {
      const block = m[1]
      const itemUrl = findSingleMatch(block, '<a href="(.*?)"')
      let title = findSingleMatch(block, 'alt="(.*?)"')
      if (!itemUrl || !title) continue
      title = title.replace(/&#8217;/g, "'").replace(/&/g, '&').replace(/&#039;s/g, "'s")
      const thumb = findSingleMatch(block, '<img src="(.*?)"')
      const fullThumb = thumb && !thumb.includes('https') ? HOST.slice(0, -1) + thumb : thumb
      const fullUrl = itemUrl.startsWith('http') ? itemUrl : HOST.slice(0, -1) + itemUrl
      // /series/ catalog contains both; detect from source page and URL hints
      const itemType = (id === 'repelishd-series' && !fullUrl.includes('/cine/') && !fullUrl.includes('/proximas-')) ||
                        fullUrl.includes('/ver-serie/') ||
                        fullUrl.includes('/series/')
                        ? 'series' : 'movie'
      items.push({
        id: `repelishd:${fullUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: fullThumb || null,
        url: fullUrl,
        pluginId: 'plurtasko',
      })
    }
    return items.slice(skip, skip + top)
  },

  async getMeta({ id }) {
    const url = id.replace(/^repelishd:/, '')
    const html = await fetchHtml(url)
    let title = findSingleMatch(html, '<meta[^>]*property="og:title"[^>]*content="([^"]+)"')
      || findSingleMatch(html, '<h1(?![^>]*class=["\']text["\'])[^>]*>(.*?)</h1>')
      || findSingleMatch(html, '<title>(.*?)</title>')
    title = decodeEntities(title).replace(/^Ver\s+/i, '').replace(/\s*\|.*$/, '').replace(/\s*online.*$/i, '').trim()
    const poster = findSingleMatch(html, '<img[^>]*src="([^"]*)"[^>]*class="[^"]*poster[^"]*"')
    const description = findSingleMatch(html, '<div[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</div>')
    const year = findSingleMatch(html, /(\d{4})/)

    const meta = {
      id,
      // Detect series by page content since URLs now use /ver-pelicula/ for everything
      type: /vimeus|buildVimeusSelector|data\.seasons|seasons\.length/.test(html) ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: title,
      title,
      poster: poster || null,
      backdrop: poster || null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (meta.type === CONTENT_TYPES.SERIES) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  async _getEpisodes(url, html) {
    const episodes = []

    // Modern RepelisHD loads season/episode data via vimeus.com iframe.
    // Try to fetch the vimeus JSON and list all episodes.
    const tmdbRaw = findSingleMatch(html, "var tmdbRaw\\s*=\\s*'([^']+)'")
    const imdb = findSingleMatch(html, "var imdb\\s*=\\s*'([^']+)'")
    const pageTitle = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''

    if (tmdbRaw) {
      const vimeusUrl = `https://vimeus.com/e/serie?tmdb=${encodeURIComponent(tmdbRaw)}&view_key=5yXx8bsITsFlRG-X-rDhcOHd0XuLsjlzliKpi5aGcHA&title=${encodeURIComponent(pageTitle)}&theme=minimal`
      const vimeusHtml = await fetchHtml(vimeusUrl)
      if (vimeusHtml) {
        const dataMatch = vimeusHtml.match(/<script type="text\/json" id="data">\s*([\s\S]*?)\s*<\/script>/)
        if (dataMatch) {
          try {
            const data = JSON.parse(dataMatch[1])
            if (data.seasons) {
              for (const season of data.seasons) {
                for (const ep of season.episodes) {
                  episodes.push({
                    id: `repelishd:${url}?se=${season.season_number}&ep=${ep.episode}&tmdb=${tmdbRaw}&imdb=${imdb}`,
                    name: `S${season.season_number}E${ep.episode}`,
                    season: season.season_number,
                    episode: ep.episode,
                    url: `${url}?se=${season.season_number}&ep=${ep.episode}&tmdb=${tmdbRaw}&imdb=${imdb}`,
                  })
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // Fallback: legacy pattern
    if (episodes.length === 0) {
      const matches = findMultipleMatches(html, 'href="(https?://[^"]*ver-serie[^"]*capitulo[^"]*)"')
      let epNum = 0
      for (const m of matches) {
        const epUrl = m[1]
        const seasonMatch = epUrl.match(/temporada\/(\d+)\/capitulo\/(\d+)/i) || epUrl.match(/(\d+)x(\d+)/i)
        epNum++
        episodes.push({
          id: `repelishd:${epUrl}`,
          name: `T${seasonMatch ? seasonMatch[1] : 1}E${seasonMatch ? seasonMatch[2] : epNum}`,
          season: seasonMatch ? parseInt(seasonMatch[1], 10) : 1,
          episode: seasonMatch ? parseInt(seasonMatch[2], 10) : epNum,
          url: epUrl,
        })
      }
    }
    return episodes
  },

  async getStreams({ id }) {
    let url = id.replace(/^repelishd:/, '')
    const urlObj = new URL(url)
    const se = urlObj.searchParams.get('se')
    const ep = urlObj.searchParams.get('ep')
    const tmdbRaw = urlObj.searchParams.get('tmdb') || ''
    const imdb = urlObj.searchParams.get('imdb') || ''
    const baseUrl = url.split('?')[0]

    const html = await fetchHtml(baseUrl)
    if (!html) return []

    const streams = []

    // Modern Vimeus/Verhdlink series player
    if (se && ep && tmdbRaw) {
      const title = findSingleMatch(html, '<h1[^>]*>(.*?)</h1>') || ''
      const vimeusUrl = `https://vimeus.com/e/serie?tmdb=${encodeURIComponent(tmdbRaw)}&view_key=5yXx8bsITsFlRG-X-rDhcOHd0XuLsjlzliKpi5aGcHA&title=${encodeURIComponent(title)}&se=${se}&ep=${ep}&theme=minimal`
      const vimeusHtml = await fetchHtml(vimeusUrl)
      if (vimeusHtml) {
        const iframeMatch = vimeusHtml.match(/<iframe[^>]*src="([^"]+)"/i)
        if (iframeMatch) {
          let iframeSrc = iframeMatch[1]
          if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc
          const vimeusLang = detectLangFromText(title)
          streams.push({
            name: `Vimeus [RepelisHD]${vimeusLang ? ` (${vimeusLang})` : ''}`,
            url: iframeSrc,
            streamType: 'embed',
            quality: '',
            server: 'vimeus',
            lang: vimeusLang,
            pluginName: 'RepelisHD',
            pluginId: 'plurtasko',
          })
        }
      }
    }

    // Find iframe to verhdlink (handle newlines)
    const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/i)
    const iframeSrc = iframeMatch ? iframeMatch[1] : ''
    if (iframeSrc) {
      const embedUrl = iframeSrc.startsWith('//') ? 'https:' + iframeSrc
        : iframeSrc.startsWith('/') ? HOST.slice(0, -1) + iframeSrc
        : iframeSrc
      try {
        const embedHtml = await fetchHtml(embedUrl)
        // Find _player-mirrors sections (each has a language)
        const mirrors = embedHtml.match(/<ul class="_player-mirrors ([^"]*)">([\s\S]*?)<\/ul>/g) || []
        for (const mirror of mirrors) {
          const clsMatch = mirror.match(/<ul class="_player-mirrors ([^"]*)"/)
          const langClass = (clsMatch ? clsMatch[1] : '').toLowerCase()
          let lang = ''
          if (langClass.includes('castellano') || langClass.includes('español')) lang = 'ESP'
          else if (langClass.includes('latino')) lang = 'LAT'
          else if (langClass.includes('subtitulado')) lang = 'VOSE'
          if (!lang) continue

          // Find data-link URLs
          const dataLinks = mirror.match(/data-link="([^"]+)"/g) || []
          for (const dl of dataLinks) {
            const link = dl.match(/data-link="([^"]+)"/)[1]
            const linkUrl = link.startsWith('//') ? 'https:' + link : link.startsWith('/') ? HOST.slice(0, -1) + link : link
            if (linkUrl.includes('/player/')) continue
            if (linkUrl.includes('verhdlink')) continue
            const server = detectServerFromUrl(linkUrl)
            streams.push({
              name: `${server} (${lang})`,
              url: linkUrl,
              streamType: normalizeServer(server),
              quality: '',
              server,
              pluginName: 'RepelisHD',
              pluginId: 'plurtasko',
            })
          }
        }
      } catch (e) {
        // skip
      }
    }

    return streams
  },

  async search({ query, type }) {
    const url = `${HOST}?story=${encodeURIComponent(query)}&do=search&subaction=search`
    const html = await fetchHtml(url)
    const items = []

    // Find articles with ver-pelicula/ver-serie links
    const matches = findMultipleMatches(html, '<article([\\s\\S]*?)</article>')
    for (const m of matches) {
      const block = m[1]
      const itemUrl = findSingleMatch(block, '<a href="(.*?)"')
      let title = findSingleMatch(block, 'alt="(.*?)"')
      if (!itemUrl || !title) continue
      if (!itemUrl.includes('ver-pelicula') && !itemUrl.includes('ver-serie')) continue
      title = title.replace(/&#8217;/g, "'").replace(/&/g, '&').replace(/&#039;s/g, "'s")
      const fullUrl = itemUrl.startsWith('http') ? itemUrl : HOST.slice(0, -1) + itemUrl
      const itemType = fullUrl.includes('/ver-serie/') ? 'series' : 'movie'

      if (type === CONTENT_TYPES.MOVIE && itemType === 'series') continue
      if (type === CONTENT_TYPES.SERIES && itemType === 'movie') continue

      items.push({
        id: `repelishd:${fullUrl}`,
        type: itemType === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
        name: decodeEntities(title),
        title: decodeEntities(title),
        poster: null,
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

