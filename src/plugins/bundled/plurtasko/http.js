// HTTP client wrapper for Plurtasko channels.
// Uses httpClient.js which works on Android (CapacitorHttp) and web/Electron.
// Fallback order for ISP-blocked/judicial-blocked sites: WARP tunnel first
// (Aether local proxy routes all app traffic), then public CORS proxies,
// then r.jina.ai. Cloudflare challenges skip WARP (its exit IP makes
// challenges worse) and go straight to proxies.

import { httpGetText, httpPostText, httpPostJson, shortSignal } from '../../../utils/httpClient.js'
import { isAndroidNative } from '../../../utils/platform.js'
import { isWarpConnected, refreshWarpStatus } from '../../../utils/warpStatus.js'

// Solo host:puerto para logs — las URLs pueden llevar tokens de sesión.
export const hostOf = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
}

// Fallback via r.jina.ai (last resort - converts to markdown, may break parsers)
// Timeout: 8 seconds max (r.jina.ai can take 40+ seconds for some sites)
async function fetchViaJina(url, signal) {
  try {
    const proxiedUrl = `https://r.jina.ai/${url}`
    // Cap propio de 8s también cuando el caller pasa signal (jina puede tardar 40s+)
    const result = await httpGetText(proxiedUrl, {}, shortSignal(signal, 8000))
    if (result && result.length > 100 &&
        !result.includes('Just a moment') &&
        !result.includes('Attention Required! | Cloudflare') &&
        !isAnubisChallenge(result)) {
      // r.jina.ai returns markdown; convert to HTML for existing parsers
      if (result.includes('URL Source:') || result.startsWith('Title:')) {
        return markdownToHtml(result)
      }
      return result
    }
  } catch {}
  return ''
}

// Convert r.jina.ai markdown output back to HTML so existing regex parsers work.
function markdownToHtml(md) {
  if (!md) return ''
  const contentStart = md.indexOf('Markdown Content:')
  if (contentStart >= 0) md = md.substring(contentStart + 'Markdown Content:'.length)
  let html = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
  html = html.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return html
}

// Search via Google for a specific site (used for Cloudflare-protected sites where
// the internal search is blocked). Returns array of URLs found on the site.
export async function googleSiteSearch(siteDomain, query, signal) {
  try {
    const googleUrl = `https://www.google.com/search?q=site:${encodeURIComponent(siteDomain)}+${encodeURIComponent(query)}&num=10`
    const html = await httpGetText(`https://r.jina.ai/${googleUrl}`, {}, signal)
    if (!html) return []
    const urls = []
    const escapedDomain = siteDomain.replace(/\./g, '\\.')
    const linkRegex = new RegExp(`https?://${escapedDomain}/[^\s\\)\\]]+`, 'gi')
    const matches = html.match(linkRegex) || []
    const seen = new Set()
    for (const u of matches) {
      const clean = u.replace(/[.,;!?]+$/, '')
      if (!seen.has(clean) && !clean.includes('/generos/') && !clean.includes('/pagina/')) {
        seen.add(clean)
        urls.push(clean)
      }
    }
    return urls
  } catch {
    return []
  }
}

// Public CORS proxies that return raw HTML (unlike r.jina.ai which mangles it).
// Used as automatic fallback when a site is ISP-blocked or unreachable.
// Each is a URL prefix — the target URL is appended URL-encoded.
const PUBLIC_PROXIES = [
  'https://api.codetabs.com/v1/proxy?quest=',
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?url=',
]

// Try fetching a URL through public CORS proxies. Returns raw HTML or ''.
// Race los proxies con Promise.any: antes eran secuenciales y un proxy caído
// bloqueaba al siguiente hasta su timeout.
async function fetchViaPublicProxies(url, signal) {
  const tryOne = async (prefix) => {
    const proxyUrl = prefix + encodeURIComponent(url)
    const result = await httpGetText(proxyUrl, {}, signal)
    // El proxy puede devolver la página de challenge anti-bot del sitio
    // (Anubis/Cloudflare) — clasificarla como válida impediría rotar de host.
    if (result && result.length > 200 && classifyResponse(result, null) === 'ok') {
      console.log(`[Plurtasko] ${hostOf(url)} OK via ${new URL(prefix).hostname}`)
      return result
    }
    throw new Error('proxy returned empty/short')
  }
  try {
    return await Promise.any(PUBLIC_PROXIES.map(tryOne))
  } catch {
    return ''
  }
}

// When a judicial/ISP block is detected (LaLiga/Telefónica interception page,
// connection hijack, timeout), prefer the WARP tunnel over public proxies:
// once connected, the app-wide HTTP proxy routes retries through Cloudflare.
// Throttled so a burst of blocked domains doesn't spam connect attempts.
let warpConnectAttemptAt = 0

// Bring WARP up for blocked requests. Returns true only when the tunnel was
// newly connected by this call (i.e. a retry through it makes sense).
// On desktop/Electron, Aether is detected by warpStatus and the session proxy
// is already set by main.cjs — so this is a no-op (WARP is "already up").
async function connectWarpForBlocked() {
  if (isWarpConnected()) return false
  if (!isAndroidNative()) return false
  // Respect the user's WARP auto-connect preference
  try {
    if (localStorage.getItem('octostream_warp_autoconnect') === 'false') return false
  } catch { return false }
  if (Date.now() - warpConnectAttemptAt < DOWN_TTL_MS) return false
  warpConnectAttemptAt = Date.now()
  try {
    const { CloudProxy } = await import('@octostream/cloud-proxy')
    // The Aether handshake can take many seconds; cap it so a stuck tunnel
    // cannot hang a catalog/search request indefinitely.
    await Promise.race([
      CloudProxy.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('warp connect timeout')), 12000)),
    ])
    await refreshWarpStatus()
    if (isWarpConnected()) {
      console.log('[Plurtasko] WARP connected — retrying blocked request through tunnel')
      clearDownDomains()
      return true
    }
  } catch {}
  return false
}

async function retryViaWarp(url, headers, signal) {
  // Connect first if the tunnel is down; if it's already up the retry
  // goes through the app-wide proxy anyway.
  const newlyConnected = await connectWarpForBlocked()
  // On desktop/Electron the session proxy already routes through Aether,
  // so the first fetch attempt went through WARP. Only retry if we just
  // brought the tunnel up (Android: native VPN was down).
  if (!newlyConnected) return ''
  try {
    const result = await httpGetText(url, headers, signal)
    return classifyResponse(result, null) === 'ok' ? result : ''
  } catch {
    return ''
  }
}

// Domains known to be down (403/Cloudflare) - skip entirely to speed up searches.
// These domains consistently return 403 and waste ~400ms each per search.
// NOTE: HDFull domains are NOT blocked here - they go through r.jina.ai fallback
// since they have unique content (login required, but r.jina.ai can read public pages).
const BLOCKED_DOMAINS = new Set([
  // Empty - all Cloudflare sites go through r.jina.ai fallback now
])

// Cache of domains known to be down (avoid retrying them every search)
const downDomains = new Map() // host → timestamp
const DOWN_TTL_MS = 2 * 60 * 1000 // Mark as down for 2 min (short, since WARP may connect)

// Check if a domain is marked as down.
// When WARP is connected, previously "down" domains get a free retry
// (the tunnel may bypass whatever caused the failure).
function isDomainDown(url) {
  try {
    const host = new URL(url).hostname
    const ts = downDomains.get(host)
    if (!ts) return false
    if (isWarpConnected()) {
      // WARP is up — give the domain another chance through the tunnel
      downDomains.delete(host)
      return false
    }
    if (Date.now() - ts > DOWN_TTL_MS) {
      downDomains.delete(host)
      return false
    }
    return true
  } catch {
    return false
  }
}

// Mark a domain as down. Entries expire after DOWN_TTL_MS and isDomainDown
// gives a free retry once WARP connects, so caching a possibly ISP-blocked
// domain is safe — and avoids re-running the whole proxy/Jina fallback chain
// for the same dead site on every single request.
function markDomainDown(url) {
  try {
    const host = new URL(url).hostname
    downDomains.set(host, Date.now())
    console.log(`[Plurtasko] Marked ${host} as DOWN for ${DOWN_TTL_MS / 1000}s`)
  } catch {}
}

// Clear all down-domain entries — called when WARP connects, so previously
// "down" (actually ISP-blocked) domains get retried through the tunnel.
function clearDownDomains() {
  if (downDomains.size > 0) {
    console.log(`[Plurtasko] WARP connected — clearing ${downDomains.size} down-domain entries`)
    downDomains.clear()
  }
}

// Classify the error type from an HTTP response or exception
// Returns: 'blocked' | 'cloudflare' | 'down' | 'ratelimit' | 'notfound' | 'ok' | 'unknown'
// Anubis PoW anti-bot: asset path propio + títulos localizados del challenge.
function isAnubisChallenge(html) {
  return !!html && (
    html.includes('x/cmd/anubis') ||
    html.includes('no eres un robot') ||
    html.includes('not a bot')
  )
}

function classifyResponse(result, error) {
  if (error) {
    const msg = String(error?.message || error)
    // Rate limit
    if (/HTTP 429/i.test(msg)) return 'ratelimit'
    // HTTP 5xx = server error = site is down/overloaded
    if (/HTTP 5\d\d/i.test(msg)) return 'down'
    // HTTP 403/451 = blocked or geo-restricted
    if (/HTTP 403|HTTP 451/i.test(msg)) return 'cloudflare'
    // HTTP 404 = page doesn't exist (NOT site down - don't mark domain as down)
    if (/HTTP 404/i.test(msg)) return 'notfound'
    // ISP blocking: connection refused, DNS hijack to 127.0.0.1
    if (/127\.0\.0\.1|connection.*refused|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(msg)) return 'blocked'
    // DNS failure / server not found = site is down
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(msg)) return 'down'
    // Timeout = could be blocked or slow, treat as blocked to try proxy
    if (/timeout|ETIMEDOUT|ERR_TIMED_OUT/i.test(msg)) return 'blocked'
    return 'unknown'
  }
  if (!result) return 'down'
  // Bloqueo judicial / Sentencia LaLiga / Telefónica
  if (result.includes('ha sido bloqueado en cumplimiento de lo dispuesto en la Sentencia') || result.includes('Juzgado de lo Mercantil') || result.includes('la-liga.es') || result.includes('laliga.com/noticias')) {
    return 'blocked'
  }
  // Cloudflare challenge
  if (result.includes('Just a moment') || result.includes('cf-challenge') || result.includes('Attention Required! | Cloudflare')) return 'cloudflare'
  // Anubis PoW anti-bot challenge (dontorrent.supply y otros)
  if (isAnubisChallenge(result)) return 'cloudflare'
  // Cloudflare JWT redirect (window.location.replace with JWT token)
  if (result.includes('window.location.replace') && result.includes('eyJ') && result.length < 1000) return 'cloudflare'
  // Captcha por-enlace (powvideo, streamplay…): form + reCAPTCHA/hCaptcha y
  // sin fuentes de vídeo — sin usuario no se resuelve, y los proxies
  // recibirían el mismo captcha (no es bloqueo de IP). Bailar rápido.
  if (/g-recaptcha|h-captcha|cf-turnstile|grecaptcha\.render|google\.com\/recaptcha|hcaptcha\.com/i.test(result)
    && !/sources?\s*:|jwplayer|\.m3u8|\.mp4/i.test(result)) {
    return 'captcha'
  }
  // Empty/too short = not a real page
  if (result.length < 200) return 'down'
  return 'ok'
}

// Caché de páginas HTML en memoria (TTL 60s): absorbe back-navigation,
// búsquedas repetidas y getMeta→_getEpisodes que piden la misma URL.
const pageCache = new Map()
const PAGE_CACHE_TTL = 60 * 1000
const PAGE_CACHE_MAX = 100 // evita crecimiento ilimitado en sesiones largas
// Coalescing: dos llamadas concurrentes a la misma URL comparten el fetch.
const inflightFetches = new Map()

export async function fetchHtml(url, signal, extraHeaders) {
  const cacheKey = extraHeaders ? `${url}\n${JSON.stringify(extraHeaders)}` : url
  const hit = pageCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < PAGE_CACHE_TTL) return hit.html
  const inflight = inflightFetches.get(cacheKey)
  if (inflight) return inflight
  const promise = fetchHtmlInner(url, signal, extraHeaders)
    .then(html => {
      if (html) {
        if (pageCache.size >= PAGE_CACHE_MAX) {
          // Evict oldest entry (Map preserves insertion order)
          const oldest = pageCache.keys().next().value
          pageCache.delete(oldest)
        }
        pageCache.set(cacheKey, { html, ts: Date.now() })
      }
      return html
    })
    .finally(() => inflightFetches.delete(cacheKey))
  inflightFetches.set(cacheKey, promise)
  return promise
}

async function fetchHtmlInner(url, signal, extraHeaders) {
  // Skip domains known to be permanently blocked (403)
  try {
    const host = new URL(url).hostname
    if (BLOCKED_DOMAINS.has(host)) {
      console.log(`[Plurtasko] Skipping ${hostOf(url)} (permanently blocked)`)
      return ''
    }
  } catch {}

  // Skip domains known to be down
  if (isDomainDown(url)) {
    console.log(`[Plurtasko] Skipping ${hostOf(url)} (marked as DOWN)`)
    return ''
  }

  const headers = extraHeaders ? { ...DEFAULT_HEADERS, ...extraHeaders } : DEFAULT_HEADERS
  try {
    const result = await httpGetText(url, headers, signal)
    const status = classifyResponse(result, null)

    if (status === 'ok') return result

    // 404 = page doesn't exist, but domain is fine - don't mark as down
    if (status === 'notfound') {
      console.log(`[Plurtasko] ${hostOf(url)} → 404 (page not found)`)
      return ''
    }

    // Captcha por-enlace: no probar proxies (recibirían el mismo captcha —
    // es el contenido del enlace, no un bloqueo de IP). Devolver vacío ya
    // para que caiga al WebView visible sin esperar.
    if (status === 'captcha') {
      console.log(`[Plurtasko] ${hostOf(url)} → captcha, skipping proxies`)
      return ''
    }

    // Judicial/ISP block → WARP tunnel first, then public proxies, then r.jina.ai
    if (status === 'blocked') {
      console.log(`[Plurtasko] ${hostOf(url)} → blocked, trying WARP tunnel...`)
      const viaWarp = await retryViaWarp(url, headers, signal)
      if (viaWarp) return viaWarp
      const proxied = await fetchViaPublicProxies(url, signal) || await fetchViaJina(url, signal)
      if (proxied) return proxied
      markDomainDown(url)
      return ''
    }

    // Cloudflare or rate limit → try public proxies (raw HTML), then r.jina.ai.
    // Don't mark as down: Cloudflare challenges are intermittent, not downtime.
    if (status === 'cloudflare' || status === 'ratelimit') {
      console.log(`[Plurtasko] ${hostOf(url)} → ${status}, trying public proxies...`)
      // Jina is the reliable fallback for Cloudflare pages: public CORS
      // proxies often hang or return another challenge page. Try it first so
      // provider parsers can receive the converted page without waiting.
      const proxied = await fetchViaJina(url, signal) || await fetchViaPublicProxies(url, signal)
      if (proxied) return proxied
      // Proxy also failed — return empty but DON'T mark as down
      // (Cloudflare may let the next request through)
      return ''
    }

    // Site is down (empty response) - try proxies once (could be ISP DNS poisoning).
    if (status === 'down') {
      const proxied = await fetchViaPublicProxies(url, signal)
      if (proxied) return proxied
      markDomainDown(url)
      return ''
    }

    return result || ''
  } catch (e) {
    const status = classifyResponse(null, e)

    if (status === 'down') {
      // DNS failure / server error - could be real downtime or ISP DNS poisoning.
      // Try public proxies once, then cache the failure so later requests
      // skip the slow fallback chain (WARP connect still gets a free retry).
      console.log(`[Plurtasko] ${hostOf(url)} is DOWN: ${e?.message || e}, trying public proxies...`)
      const proxied = await fetchViaPublicProxies(url, signal)
      if (proxied) return proxied
      markDomainDown(url)
      return ''
    }

    if (status === 'cloudflare' || status === 'ratelimit') {
      console.log(`[Plurtasko] ${hostOf(url)} → ${status} (${e?.message || e}), trying Jina...`)
      const proxied = await fetchViaJina(url, signal) || await fetchViaPublicProxies(url, signal)
      if (proxied) return proxied
      return ''
    }

    if (status === 'blocked' || status === 'unknown') {
      // Could be ISP blocking - try WARP tunnel, then public proxies, then r.jina.ai
      console.log(`[Plurtasko] ${hostOf(url)} → ${status} (${e?.message || e}), trying WARP tunnel...`)
      const viaWarp = await retryViaWarp(url, headers, signal)
      if (viaWarp) return viaWarp
      const proxied = await fetchViaPublicProxies(url, signal) || await fetchViaJina(url, signal)
      if (proxied) return proxied
      // Proxy also failed — don't mark as down (could be transient)
      return ''
    }

    console.warn(`[Plurtasko] fetchHtml failed: ${hostOf(url)}`, e?.message || e)
    return ''
  }
}

// POST form data and return text response. Used for HDFull login and the
// animeflv.one /flv player-list endpoint. Judicial/ISP interception of POSTs
// also goes through the WARP tunnel (connects it first if needed).
export async function postHtml(url, body, signal, extraHeaders) {
  const headers = { ...DEFAULT_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', ...(extraHeaders || {}) }
  try {
    const result = await httpPostText(url, body, headers, signal)
    if (classifyResponse(result, null) === 'blocked' && await connectWarpForBlocked()) {
      try { return (await httpPostText(url, body, headers, signal)) || result } catch { return result }
    }
    return result
  } catch (e) {
    if (await connectWarpForBlocked()) {
      try { return (await httpPostText(url, body, headers, signal)) || '' } catch {}
    }
    console.warn(`[Plurtasko] postHtml failed: ${hostOf(url)}`, e?.message || e)
    return ''
  }
}

// POST JSON and return parsed JSON response. Used for GraphQL APIs.
export async function postJson(url, body, signal, extraHeaders) {
  try {
    const headers = extraHeaders
      ? { ...DEFAULT_HEADERS, 'Content-Type': 'application/json', ...extraHeaders }
      : { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' }
    return await httpPostJson(url, body, headers, false, signal)
  } catch (e) {
    console.warn(`[Plurtasko] postJson failed: ${hostOf(url)}`, e?.message || e)
    return null
  }
}

// Clean HTML for easier regex scraping: remove whitespace, newlines, tabs.
export function cleanHtml(html) {
  return html.replace(/\n|\r|\t|\s{2}|&nbsp;/g, '')
}

// Convert a possibly-relative URL to absolute using a base host.
export function absoluteUrl(url, baseHost) {
  if (!url) return ''
  if (/^https?:\/\//i.test(url) || /^magnet:/i.test(url)) return url
  if (url.startsWith('//')) return 'https:' + url
  const host = baseHost.replace(/\/$/, '')
  if (url.startsWith('/')) return host + url
  return host + '/' + url
}

// Decode HTML entities: named common/Spanish ones plus generic numeric forms.
export function decodeEntities(text) {
  if (!text) return ''
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#821[67];|&[lr]squo;/g, '’')
    .replace(/&#822[01];|&[lr]dquo;/g, '”')
    .replace(/&#0?38;/g, '&')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

// Rotación de hosts con memoria para webs con dominios que rotan o caen
// (dontorrent, grantorrent, subtorrents…): prueba primero el último host que
// funcionó y, si falla, itera el resto en orden. `fn(host)` debe devolver el
// resultado crudo; `valid(res)` decide si el host sirvió (por defecto truthy).
// Devuelve { res, host } — res=null si ningún host respondió válido.
export function makeHostRotator(hosts) {
  let working = hosts[0]
  return {
    get working() { return working },
    set working(h) { working = h },
    async rotate(fn, valid = r => !!r) {
      const tried = new Set()
      let host = working
      for (let i = 0; i < hosts.length; i++) {
        tried.add(host)
        const res = await fn(host)
        if (valid(res)) { working = host; return { res, host } }
        host = hosts.find(h => !tried.has(h)) || host
      }
      return { res: null, host: working }
    },
  }
}

// GET con fallback de host: prueba el host cacheado y, si la respuesta no
// parece una página válida (>minLen), rota al siguiente. Devuelve { html, host }.
// `htmlFetch` se inyecta para que los tests puedan mockear fetchHtml.
export function makeHtmlFetcher(rotator, htmlFetch, minLen = 1000) {
  return async function fetchHost(path, signal) {
    const { res, host } = await rotator.rotate(h => htmlFetch(h + path, signal), r => !!r && r.length > minLen)
    return { html: res || '', host }
  }
}
