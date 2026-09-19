// HDFull channel - ported from Balandro's hdfull.py
// Requires login credentials supplied through Vite environment variables.
// Decrypts obfuscated stream data using the same obfs algorithm as Balandro.
// Uses AJAX API for episodes (like Balandro) and a provider map.

import { CONTENT_TYPES } from '../../../base.js'
import { fetchHtml, postHtml, decodeEntities, absoluteUrl, hostOf } from '../http.js'
import { findSingleMatch, findMultipleMatches, normalizeServer } from '../scraper.js'
import { httpPostWithHeaders, httpGetWithHeaders } from '../../../../utils/httpClient.js'

// Credenciales HDFull: se leen de localStorage (configuradas por el usuario en
// Settings) con fallback a las variables de entorno de Vite (.env).
// Se leen en cada ensureLogin() para que un cambio en Settings surta efecto
// sin tener que reconstruir la app.
function getHdfullCredentials() {
  const lsUser = localStorage.getItem('octostream_hdfull_username') || ''
  const lsPass = localStorage.getItem('octostream_hdfull_password') || ''
  return {
    username: lsUser || import.meta.env?.VITE_HDFULL_USERNAME || '',
    password: lsPass || import.meta.env?.VITE_HDFULL_PASSWORD || '',
  }
}

// HDFull configurado (Settings o .env): se usa para priorizar el canal.
export const hasHdfullCredentials = () => {
  const c = getHdfullCredentials()
  return !!(c.username && c.password)
}

// Cache de la clave de descifrado por dominio (1h): el JS que la contiene no
// cambia por episodio y antes se descargaba en cada getStreams.
const hdfullKeyCache = new Map()

// HDFull blocks Android/mobile User-Agents; use desktop
const HDFULL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
}

// Try multiple domains since HDFull changes frequently
const DOMAINS = [
  'https://hdfull.today/',
  'https://hdfull.love/',
  'https://hdfull.sbs/',
  'https://www3.hdfull.one/',
  'https://hdfull.buzz/',
  'https://hdfull.org/',
  'https://hdfull.one/',
  'https://new.hdfull.one/',
]

let activeDomain = DOMAINS[0]
let loggedIn = false
let sessionCookies = ''  // Store session cookies from login response

// Provider map: provider ID -> { type, url template }
// 't': 's' = stream/embed, 'd' = direct download
// Hardcoded from Balandro (updated 2024)
const PROVIDERS = {
  '1':  { t: 's', d: 'https://powvideo.org/embed-%s.html', server: 'powvideo' },
  '2':  { t: 's', d: 'https://streamplay.to/embed-%s.html', server: 'streamplay' },
  '4':  { t: 's', d: 'https://upstream.to/embed-%s.html', server: 'upstream' },
  '5':  { t: 's', d: 'https://cloudvideo.tv/embed-%s.html', server: 'cloudvideo' },
  '6':  { t: 's', d: 'https://streamtape.com/e/%s', server: 'streamtape' },
  '8':  { t: 'd', d: 'https://www.filefactory.com/file/%s', server: 'filefactory' },
  '10': { t: 'd', d: 'https://rapidgator.net/file/%s.html', server: 'rapidgator' },
  '12': { t: 's', d: 'https://gamovideo.com/embed-%s.html', server: 'gamovideo' },
  '15': { t: 's', d: 'https://mixdrop.bz/e/%s', server: 'mixdrop' },
  '16': { t: 's', d: 'https://videobin.co/embed-%s.html', server: 'videobin' },
  '22': { t: 'd', d: 'https://mexa.sh/%s', server: 'mexa' },
  '23': { t: 'd', d: 'https://1fichier.com/?%s', server: '1fichier' },
  '24': { t: 'd', d: 'https://katfile.biz/%s', server: 'katfile' },
  '27': { t: 'd', d: 'http://nitroflare.com/%s', server: 'nitroflare' },
  '31': { t: 's', d: 'https://vidoza.net/embed-%s.html', server: 'vidoza' },
  '35': { t: 'd', d: 'https://uptobox.com/%s', server: 'uptobox' },
  '38': { t: 'd', d: 'https://clicknupload.cc/%s', server: 'clicknupload' },
  '40': { t: 's', d: 'https://vidmoly.me/embed-%s.html', server: 'vidmoly' },
  // Provider 45 (waaw) removed — domain is dead (waaw.to → 127.0.0.1, waaw.tv → waaw.to)
}

// obfs decryption: Caesar cipher with key mod 126 (port of Balandro's obfs)
function obfs(data, key, n = 126) {
  const chars = data.split('')
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].charCodeAt(0)
    if (c <= n) {
      chars[i] = String.fromCharCode((c + key) % n)
    }
  }
  return chars.join('')
}

// Detect language from HDFull lang code. Sin código no se asume Esp:
// devolver '' deja el stream sin etiqueta en vez de mentir como castellano
// (los sin-etiqueta van al final del sort por prioridad de idioma).
function detectLanguage(lang) {
  if (!lang) return ''
  if (lang === 'ESPSUB') return 'Vose'
  if (lang === 'ESP') return 'Esp'
  if (lang === 'LAT') return 'Lat'
  if (lang === 'ENG') return 'Eng'
  return lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase()
}

// Login to HDFull and store session
async function ensureLogin() {
  if (loggedIn) return true
  const { username: USERNAME, password: PASSWORD } = getHdfullCredentials()
  if (!USERNAME || !PASSWORD) return false

  for (const domain of DOMAINS) {
    activeDomain = domain
    try {
      // Step 1: GET login page to get CSRF token AND session cookie.
      // The CSRF token is bound to the PHPSESSID, so we MUST send the
      // same PHPSESSID back in the POST or the CSRF check fails.
      const { data: loginPage, headers: getHeaders } = await httpGetWithHeaders(
        domain + 'login', HDFULL_HEADERS
      )
      if (!loginPage) {
        console.warn(`[HDFull] GET login failed on ${domain}: empty response`)
        continue
      }

      // Check for Cloudflare
      if (loginPage.includes('Just a moment...')) {
        console.warn(`[HDFull] Cloudflare protection on ${domain}`)
        continue
      }

      // Extract CSRF token (Balandro pattern)
      const csrf = findSingleMatch(loginPage, '__csrf_magic.*?value="(.*?)"')
      if (!csrf) {
        console.warn(`[HDFull] No CSRF token found on ${domain}`)
        continue
      }
      console.log(`[HDFull] CSRF token found on ${domain}`)

      // Capture PHPSESSID from the GET response (needed for CSRF validation)
      let getSessionCookie = ''
      if (getHeaders) {
        const sc = getHeaders['Set-Cookie'] || getHeaders['set-cookie']
        if (sc) {
          const cookies = Array.isArray(sc) ? sc : [sc]
          // Keep PHPSESSID and any other session cookies
          getSessionCookie = cookies.map(c => c.split(';')[0]).join('; ')
        }
      }

      // Step 2: POST login credentials with the session cookie from GET
      const postBody = `__csrf_magic=${encodeURIComponent(csrf)}&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&action=login`
      const postHeaders = {
        ...HDFULL_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': domain + 'login',
      }
      if (getSessionCookie) postHeaders['Cookie'] = getSessionCookie

      const { data: response, headers: respHeaders } = await httpPostWithHeaders(
        domain + 'login', postBody, postHeaders
      )

      if (!response) {
        console.warn(`[HDFull] POST login failed on ${domain}: empty response`)
        continue
      }

      // Merge cookies from GET (PHPSESSID) and POST (guid, etc.)
      const allCookies = []
      if (getSessionCookie) allCookies.push(getSessionCookie)
      if (respHeaders) {
        const setCookie = respHeaders['Set-Cookie'] || respHeaders['set-cookie']
        if (setCookie) {
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
          for (const c of cookies) allCookies.push(c.split(';')[0])
        }
      }
      // Deduplicate by cookie name (keep last value)
      const cookieMap = {}
      for (const c of allCookies) {
        const name = c.split('=')[0]
        cookieMap[name] = c
      }
      sessionCookies = Object.values(cookieMap).join('; ')

      // Check for successful login (Balandro patterns)
      if (response.includes(`Bienvenido ${USERNAME}`) ||
          response.includes("window.location='/'") ||
          response.includes("window.location=''")) {
        loggedIn = true
        console.log(`[HDFull] Login successful on ${domain}`)
        return true
      }

      // Try alternative login (JSON response)
      try {
        const jdata = JSON.parse(response)
        if (jdata.status === 'OK') {
          loggedIn = true
          console.log(`[HDFull] Login successful (JSON) on ${domain}`)
          return true
        }
      } catch {
        // Not JSON, continue
      }

      console.warn(`[HDFull] Login rejected on ${domain}`)
    } catch (e) {
      console.warn(`[HDFull] Login failed on ${domain}:`, e?.message || e)
    }
  }

  console.warn('[HDFull] Login failed on all domains')
  return false
}

// Fetch HTML with login check (Balandro's do_downloadpage pattern)
async function fetchHdfull(url, referer) {
  const ok = await ensureLogin()
  if (!ok) return ''

  const headers = { ...HDFULL_HEADERS }
  headers['Referer'] = referer || activeDomain
  if (sessionCookies) headers['Cookie'] = sessionCookies

  let data = await fetchHtml(url, null, headers)

  // Check if session expired (Balandro pattern)
  if (data && data.includes('<div id="popup_login_result"></div>')) {
    console.warn('[HDFull] Session expired, re-logging in...')
    loggedIn = false
    const reOk = await ensureLogin()
    if (reOk) {
      headers['Cookie'] = sessionCookies
      data = await fetchHtml(url, null, headers)
    }
  }

  // Check for Cloudflare
  if (data && data.includes('Just a moment...')) {
    console.warn(`[HDFull] Cloudflare blocked: ${hostOf(url)}`)
    return ''
  }

  return data
}

// POST with login check (for AJAX API calls)
async function postHdfull(url, body, referer) {
  const ok = await ensureLogin()
  if (!ok) return ''

  const headers = {
    ...HDFULL_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': referer || activeDomain,
  }
  if (sessionCookies) headers['Cookie'] = sessionCookies

  let data = await postHtml(url, body, null, headers)

  // Check if session expired
  if (data && data.includes('<div id="popup_login_result"></div>')) {
    loggedIn = false
    const reOk = await ensureLogin()
    if (reOk) {
      data = await postHtml(url, body, null, headers)
    }
  }

  return data
}

export const hdfull = {
  id: 'hdfull',
  name: 'HDFull',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  host: DOMAINS[0],

  catalogs: [
    { id: 'hdfull-movies', name: 'HDFull: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'hdfull-series', name: 'HDFull: Series', type: CONTENT_TYPES.SERIES },
    { id: 'hdfull-estrenos', name: 'HDFull: Estrenos', type: CONTENT_TYPES.MOVIE },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    let url
    if (id === 'hdfull-movies') url = activeDomain + 'peliculas'
    else if (id === 'hdfull-series') url = activeDomain + 'series'
    else if (id === 'hdfull-estrenos') url = activeDomain + 'peliculas-estreno'
    else return []

    const html = await fetchHdfull(url)
    if (!html) return []

    const searchType = id.includes('series') ? 'series' : 'movie'
    return this._parseList(html, searchType, skip, top)
  },

  // Balandro's list_all pattern
  _parseList(html, searchType, skip, top) {
    const items = []
    // HDFull search results have two layouts:
    // Movies: <div class="item"><a href="/pelicula/slug"><img src="thumb" title="Title"></a></div>
    // Series: <div class="item"><a href="/serie/slug"><img src="thumb"></a></div><h5><a class="link" href="/serie/slug" title="Title">Title</a></h5>
    // The most reliable pattern is <a class="link" href="..." title="..."> which works for both.
    const linkPattern = '<a class="link"[^>]*href="([^"]*)"[^>]*title="([^"]*)"'
    const linkMatches = findMultipleMatches(html, linkPattern)

    // Also try the movie img pattern (title in img tag)
    const imgPattern = '<div class="item"[^>]*>\\s*<a href="([^"]+)"[^>]*>\\s*<img[^>]*src="([^"]+)"[^>]*title="([^"]+)"'
    const imgMatches = findMultipleMatches(html, imgPattern)

    // Build a map of url -> {thumb, title} from img matches
    const imgMap = {}
    for (const m of imgMatches) {
      imgMap[m[1]] = { thumb: m[2], title: decodeEntities(m[3].trim()) }
    }

    console.log(`[HDFull] _parseList: ${linkMatches.length} link matches, ${imgMatches.length} img matches, searchType=${searchType}`)

    // Use link matches as primary (they have titles for both movies and series)
    // Normalizar ambos formatos a [fullMatch, url, title] para que el bucle use m[1]=url, m[2]=title
    const allMatches = linkMatches.length > 0
      ? linkMatches
      : imgMatches.map(m => [null, m[1], m[3]])

    for (const m of allMatches.slice(skip, skip + top)) {
      let itemUrl = m[1]
      const title = decodeEntities((m[2] || m[1] || '').trim())

      if (!itemUrl || !title) continue

      // Handle relative URLs
      itemUrl = absoluteUrl(itemUrl, activeDomain)

      const type = /\/pelicula\//.test(itemUrl) ? 'movie' : /\/serie\//.test(itemUrl) ? 'series' : null
      if (!type) continue
      if (searchType === 'movie' && type !== 'movie') continue
      if (searchType === 'series' && type !== 'series') continue

      // Get thumb from imgMap or try to find it near the link
      const thumb = imgMap[itemUrl.replace(activeDomain, '')]?.thumb
        || findSingleMatch(html, `href="${itemUrl.replace(activeDomain, '/')}[^"]*"[^>]*>[^<]*<img[^>]*src="([^"]+)"`)

      items.push({
        id: `hdfull:${itemUrl.replace(activeDomain, '/')}`,
        type: type === 'movie' ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: title,
        title,
        poster: thumb ? absoluteUrl(thumb, activeDomain) : '',
        url: itemUrl,
        pluginId: 'plurtasko',
      })
    }

    return items
  },

  async getMeta({ id }) {
    const path = id.replace(/^hdfull:/, '')
    const url = absoluteUrl(path, activeDomain)
    const html = await fetchHdfull(url, activeDomain + 'peliculas')
    if (!html) return null

    const title = findSingleMatch(html, '<title>([^<]*)</title>') || ''
    const poster = findSingleMatch(html, '<div class="show-poster">.*?<img src="([^"]*)"')
    const year = findSingleMatch(html, '<a href="/buscar/year/[^"]*">(\\d{4})</a>')
    const description = findSingleMatch(html, '<p itemprop="description">(.*?)</p>')

    const isSeries = path.startsWith('/serie/')
    const cleanTitle = decodeEntities(title)
      .replace(/^Ver\s+/i, '')
      .replace(/\s+Online(?:\s+Castellano|\s+Latino|\s+Subtitulada|\s+HD|\s+-).*$/i, '')
      .replace(/\s*[|–-]\s*HDFull.*$/i, '')
      .trim()
    const meta = {
      id,
      type: isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
      name: cleanTitle,
      title: cleanTitle,
      poster: poster ? absoluteUrl(poster, activeDomain) : null,
      backdrop: poster ? absoluteUrl(poster, activeDomain) : null,
      description: decodeEntities(description) || '',
      year: year ? parseInt(year, 10) : null,
      url,
      pluginId: 'plurtasko',
    }

    if (isSeries) {
      meta.episodes = await this._getEpisodes(url, html)
    }
    return meta
  },

  // Balandro's episodios pattern: AJAX API at /a/episodes
  async _getEpisodes(url, html) {
    const episodes = []
    const pageHtml = html || await fetchHdfull(url)
    if (!pageHtml) return episodes

    // Get series ID (sid) from page
    const sid = findSingleMatch(pageHtml, "var sid = '([^']+)';")
    if (!sid) return episodes

    // Get seasons from the season-list links: <a href='/serie/slug/temporada-N'>N</a>
    const seasonLinkMatches = findMultipleMatches(pageHtml, "/serie/[^/]+/temporada-(\\d+)")
    const seasonNums = []
    for (const m of seasonLinkMatches) {
      const num = parseInt(m[1], 10)
      if (!isNaN(num) && !seasonNums.includes(num)) seasonNums.push(num)
    }
    // Fallback: try <h5 itemprop="name">Temporada N</h5>
    if (seasonNums.length === 0) {
      const h5Matches = findMultipleMatches(pageHtml, '<h5 itemprop="name">Temporada (\\d+)</h5>')
      for (const m of h5Matches) seasonNums.push(parseInt(m[1], 10))
    }
    // If no seasons found, try season 1
    if (seasonNums.length === 0) seasonNums.push(1)

    // Get episodes for each season via AJAX API (Balandro pattern)
    for (const season of seasonNums) {
      try {
        const post = `action=season&show=${sid}&season=${season}`
        const response = await postHdfull(activeDomain + 'a/episodes', post, url)
        if (!response) continue

        // CapacitorHttp puede devolver el JSON ya parseado (Content-Type: application/json)
        // o como string. Manejar ambos casos.
        const data = typeof response === 'string' ? JSON.parse(response) : response
        if (!Array.isArray(data)) {
          console.warn(`[HDFull] Episodes API returned non-array for season ${season}:`, typeof data)
          continue
        }
        console.log(`[HDFull] Season ${season}: ${data.length} episodes`)

        for (const ep of data) {
          const epTitle = ep.title?.es || ep.title?.en || ''
          const epNum = parseInt(ep.episode, 10) || 0
          const epSeason = parseInt(ep.season, 10) || season
          const showPerma = ep.show?.permalink || ''
          const epUrl = `${activeDomain}serie/${showPerma}/temporada-${epSeason}/episodio-${epNum}`

          episodes.push({
            id: `hdfull:${epUrl.replace(activeDomain, '/')}`,
            name: epTitle || `Episodio ${epNum}`,
            season: epSeason,
            episode: epNum,
            url: epUrl,
          })
        }
      } catch (e) {
        console.warn(`[HDFull] Failed to get episodes for season ${season}:`, e?.message || e)
      }
    }

    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
    return episodes
  },

  async getStreams({ id, debridEnabled, season, episode }) {
    let path = id.replace(/^hdfull:/, '')
    // If season/episode are provided and this is a series, construct the episode URL
    if (season != null && episode != null && path.startsWith('/serie/') && !path.includes('/temporada-')) {
      path = `${path}/temporada-${season}/episodio-${episode}`
      console.log(`[HDFull] Constructed episode URL: ${path}`)
    }
    const url = absoluteUrl(path, activeDomain)
    const html = await fetchHdfull(url, activeDomain)
    if (!html) return []

    // Get decryption key from jquery.hdfull.view.min.js (Balandro pattern).
    // Cacheada por dominio 1h: antes descargaba el JS entero por cada episodio.
    let key = 14 // Emergency fallback key (Balandro default)
    try {
      const cacheKey = activeDomain
      const hit = hdfullKeyCache.get(cacheKey)
      if (hit && Date.now() - hit.ts < 60 * 60 * 1000) {
        key = hit.key
      } else {
        const jsData = await fetchHtml(activeDomain + 'templates/hdfull/js/jquery.hdfull.view.min.js', null, HDFULL_HEADERS)
        if (jsData) {
          const keyMatch = findSingleMatch(jsData, 'JSON\\.parse\\(atob.*?substrings\\((.*?)\\)\\)')
          if (keyMatch) {
            key = parseInt(keyMatch, 16)
            if (key >= 20) key = 14
          } else {
            const keyMatch2 = findSingleMatch(jsData, 'JSON.*?\\]\\((0x[0-9a-f]+)\\)\\)')
            if (keyMatch2) key = parseInt(keyMatch2, 16)
            else {
              const keyMatch3 = findSingleMatch(jsData, 'JSON.*?\\]\\(([0-9]+)\\)\\)')
              if (keyMatch3) key = parseInt(keyMatch3, 10)
            }
          }
        }
        hdfullKeyCache.set(cacheKey, { key, ts: Date.now() })
      }
    } catch (e) {
      console.warn('[HDFull] Failed to get decryption key, using fallback 14:', e?.message || e)
    }

    // Extract obfuscated stream data (Balandro pattern)
    const dataObf = findSingleMatch(html, "var ad\\s*=\\s*'([^']+)")
    if (!dataObf) {
      console.warn('[HDFull] No obfuscated data found')
      return []
    }

    // Decrypt: base64 decode then obfs with key (126 - key)
    const streams = []
    try {
      const decoded = atob(dataObf)
      const decrypted = obfs(decoded, 126 - key)
      const data = JSON.parse(decrypted)

      console.log(`[HDFull] Decrypted ${data.length} streams`)

      for (const match of data) {
        if (!match.provider || !PROVIDERS[match.provider]) continue
        if (!match.code) continue

        const provider = PROVIDERS[match.provider]
        // Skip download-only providers unless debrid is enabled
        if (provider.t === 'd' && !debridEnabled) continue

        const streamUrl = provider.d.replace('%s', match.code)
        const lang = detectLanguage(match.lang)
        const quality = match.quality || ''
        const server = provider.server || 'embed'

        streams.push({
          name: `${server}${lang ? ` (${lang})` : ''}`,
          url: streamUrl,
          streamType: normalizeServer(server) || 'embed',
          quality,
          server,
          lang,
          pluginName: 'HDFull',
          pluginId: 'plurtasko',
        })
      }
    } catch (e) {
      console.warn('[HDFull] Decryption failed:', e?.message || e)
    }

    return streams
  },

  // Balandro's search pattern: GET home for CSRF, then POST to /buscar
  async search({ query, type, originalName }) {
    const ok = await ensureLogin()
    if (!ok) return []

    // GET home page for CSRF token AND its session cookie.
    // The CSRF token is bound to the PHPSESSID, so we MUST send the same
    // PHPSESSID back in the POST or the CSRF check fails (403).
    // Send login cookies in the GET so the home page loads as logged-in
    // (otherwise we get a new PHPSESSID without session and the search returns login page).
    const getHeaders = { ...HDFULL_HEADERS }
    if (sessionCookies) getHeaders['Cookie'] = sessionCookies
    const { data: homeHtml, headers: respHeaders } = await httpGetWithHeaders(activeDomain, getHeaders)
    if (!homeHtml) return []

    const csrf = findSingleMatch(homeHtml, "name='__csrf_magic'\\s*value=\"([^\"]+)")
    if (!csrf) return []

    // Capture PHPSESSID from the GET / response (may be a new session)
    let homeCookie = ''
    if (respHeaders) {
      const sc = respHeaders['Set-Cookie'] || respHeaders['set-cookie']
      if (sc) {
        const cookies = Array.isArray(sc) ? sc : [sc]
        homeCookie = cookies.map(c => c.split(';')[0]).join('; ')
      }
    }

    // Merge login cookies with home cookies (home PHPSESSID takes precedence
    // for CSRF validation, but keep guid from login)
    const mergedCookies = []
    if (sessionCookies) mergedCookies.push(sessionCookies)
    if (homeCookie) mergedCookies.push(homeCookie)
    const cookieMap = {}
    for (const c of mergedCookies) cookieMap[c.split('=')[0]] = c
    const searchCookies = Object.values(cookieMap).join('; ')

    // POST search with the merged cookies
    const postBody = `__csrf_magic=${encodeURIComponent(csrf)}&menu=search&query=${encodeURIComponent(query)}`
    const searchHeaders = {
      ...HDFULL_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': activeDomain,
    }
    if (searchCookies) searchHeaders['Cookie'] = searchCookies

    const response = await postHtml(activeDomain + 'buscar', postBody, null, searchHeaders)
    if (!response) return []

    console.log(`[HDFull] search "${query}" response length: ${response.length}`)

    // Parse search results
    let items = this._parseList(response, type === CONTENT_TYPES.SERIES ? 'series' : 'movie', 0, 20)

    // Fallback: try direct slug (Balandro doesn't do this but it's useful)
    if (items.length === 0) {
      const isSeries = type === CONTENT_TYPES.SERIES
      const pathPrefix = isSeries ? 'serie' : 'pelicula'
      const contentType = isSeries ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
      const candidates = [query, originalName].filter(Boolean)
      for (const candidate of candidates) {
        const slug = candidate
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
        const directUrl = `${activeDomain}${pathPrefix}/${slug}`
        const page = await fetchHdfull(directUrl, activeDomain)
        if (page && page.length > 30000 && /providers\.js|provider|episodio|season|temporada/i.test(page)) {
          console.log(`[HDFull] search fallback accepted direct slug: ${directUrl}`)
          items = [{
            id: `hdfull:${directUrl.replace(activeDomain, '/')}`,
            type: contentType,
            name: query,
            title: query,
            poster: '',
            url: directUrl,
            pluginId: 'plurtasko',
          }]
          break
        }
      }
    }

    console.log(`[HDFull] search "${query}" returned ${items.length} items`)
    return items
  },
}
