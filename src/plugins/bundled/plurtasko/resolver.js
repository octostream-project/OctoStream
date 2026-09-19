// Embed resolver system - port of ResolveURL (Gujal00) to JavaScript.
// Resolves embed URLs from video hosting sites to direct playable URLs.
// Used by Plurtasko channels to avoid ads in embed players.

import { fetchHtml, postHtml, postJson, hostOf } from './http.js'
import { extractPageMeta } from './meta.js'

// ---- Captura de metadatos de las páginas de embed ----------------------
// Cada página que se descarga durante una resolución guarda su {title, lang,
// quality} — la página final del embed suele traer el nombre real del release
// ("Movie.2024.1080p.LATINO.mkv"), mucho más preciso que adivinar por la URL.
const MAX_PAGE_META = 80
const recentPageMetas = [] // ring buffer: { url, meta, ts }

function capturePageMeta(url, html) {
  if (!url || !html) return
  const text = typeof html === 'string' ? html : (() => { try { return JSON.stringify(html) } catch { return '' } })()
  if (!text) return
  const meta = extractPageMeta(text, url)
  if (!meta) return
  recentPageMetas.push({ url, meta, ts: Date.now() })
  if (recentPageMetas.length > MAX_PAGE_META) recentPageMetas.splice(0, recentPageMetas.length - MAX_PAGE_META)
}

// postHtml/postJson también devuelven páginas reales (p. ej. la respuesta al
// POST del gate ALTCHA de VOE es la página del player, no un GET más).
async function postPage(url, body, signal, extraHeaders) {
  const html = await postHtml(url, body, signal, extraHeaders)
  capturePageMeta(url, html)
  return html
}

async function postPageJson(url, body, signal, extraHeaders) {
  const data = await postJson(url, body, signal, extraHeaders)
  capturePageMeta(url, data)
  return data
}

const UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
}

async function fetchPage(url, referer, extraHeaders = {}) {
  const headers = { ...HEADERS, ...extraHeaders }
  if (referer) headers['Referer'] = referer
  try {
    // 15s timeout to prevent hanging on captcha pages
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const result = await fetchHtml(url, controller.signal, headers)
    clearTimeout(timeout)
    capturePageMeta(url, result)
    return result
  } catch {
    return ''
  }
}

// Helper: extract first regex match
function re1(text, pattern, flags = 'i') {
  if (!text) return ''
  try {
    const m = new RegExp(pattern, flags).exec(text)
    return m ? (m[1] || m[0] || '') : ''
  } catch {
    return ''
  }
}

// Helper: extract all matches
function reAll(text, pattern, flags = 'gi') {
  if (!text) return []
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
    const results = []
    let m
    while ((m = re.exec(text)) !== null) {
      results.push(m)
      // Guard against zero-width matches looping forever
      if (m.index === re.lastIndex) re.lastIndex++
    }
    return results
  } catch {
    return []
  }
}

// Unpack Dean Edwards p.a.c.k.e.r eval blocks.
// Los mirrors actuales de VOE/vidhide ya no traen JSON ofuscado en el HTML:
// entregan la página del player con las fuentes dentro de
// eval(function(p,a,c,k,e,d)('...',N,M,'k1|k2|...'.split('|'))).
// Devuelve el código desempaquetado de cada bloque.
function unpackPackedScripts(html) {
  if (!html || !/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d/.test(html)) return []
  const outputs = []
  const blockRe = /eval\(function\(p,a,c,k,e,d\)/g
  let m
  while ((m = blockRe.exec(html))) {
    const rest = html.slice(m.index)
    const end = rest.indexOf('</script>')
    const block = end > 0 ? rest.slice(0, end) : rest
    const args = block.match(/\}\('([\s\S]*)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/)
    if (!args) continue
    const [, payload, radixStr, countStr, keysStr] = args
    const radix = parseInt(radixStr)
    const count = parseInt(countStr)
    const keys = keysStr.split('|')
    if (radix !== 36 || count !== keys.length) continue
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    const dict = {}
    for (let i = count - 1; i >= 0; i--) {
      if (!keys[i]) continue
      let n = i, s = ''
      do { s = chars[n % 36] + s; n = Math.floor(n / 36) } while (n)
      dict[s] = keys[i]
    }
    outputs.push(payload.replace(/\b\w+\b/g, w => dict[w] ?? w))
  }
  return outputs
}

// Helper: build absolute URL
function absUrl(url, base) {
  if (!url) return ''
  if (/^https?:\/\//i.test(url) || /^magnet:/i.test(url)) return url
  if (url.startsWith('//')) return 'https:' + url
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

// Helper: decode base64 safely (with padding fix for unpadded inputs)
function b64decode(str) {
  try {
    let s = str.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    return atob(s)
  } catch {
    return ''
  }
}

// Helper: decode packer-style obfuscated JS (eval(function(p,a,c,k,e,d)...))
// Used by Fastream, Streamwish, Vidhide and similar video hosts.
// Returns the decoded JavaScript string, or '' if no packed JS found.
// Decode Dean Edward's p.a.c.k.e.r obfuscated JS.
// Based on Alfa's jsunpack.py (https://github.com/einars/js-beautify unpackers/packer)
function decodePackedJs(html) {
  if (!html) return ''

  // Extract the packed eval block: eval(function(p,a,c,k,e,d){...}('payload',radix,count,'symtab'.split('|')))
  // Alfa uses: text/javascript'>(eval.*?)\s*</script>
  // Simple approach: find eval(function and extract to the end of the split call
  const evalIdx = html.indexOf('eval(function')
  if (evalIdx === -1) return ''
  // Find .split('|') - the packed JS always has this pattern
  const splitIdx = html.indexOf(".split('|')", evalIdx)
  if (splitIdx === -1) return ''
  // Find the closing )) after .split('|') - may have extra args like ,0,{})
  let endIdx = splitIdx + 10 // length of .split('|')
  // Skip past any extra args (e.g. ,0,{} or ,0,{})
  let parenCount = 0
  let i = endIdx
  while (i < html.length) {
    if (html[i] === '(') parenCount++
    else if (html[i] === ')') {
      if (parenCount === 0) { endIdx = i + 1; break }
      parenCount--
    }
    endIdx = i + 1
    i++
  }
  let source = html.substring(evalIdx, endIdx)

  // Extract payload, radix, count, symtab from: }('payload', radix, count, 'symtab'.split('|'))
  // Alfa uses two regexes; radix can be a number or [] (=62)
  const argsMatch = source.match(/\}\('([\s\S]*?)',\s*(\d+|\[\]),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/)
  if (!argsMatch) return ''

  let payload = argsMatch[1]
  let radix = argsMatch[2] === '[]' ? 62 : parseInt(argsMatch[2])
  let count = parseInt(argsMatch[3])
  let symtab = argsMatch[4].split('|')

  if (count !== symtab.length) {
    // Alfa raises UnpackingError; we just continue with what we have
    console.warn('[decodePackedJs] count mismatch:', count, 'vs symtab length:', symtab.length)
  }

  // Convert base-radix numbers to integers
  // Replace each base-radix number in payload with symtab[number]
  let result = payload
  // Replace from highest index to lowest (like Alfa: c-1 down to 0)
  for (let i = count - 1; i >= 0; i--) {
    if (symtab[i]) {
      const numStr = i.toString(radix)
      if (numStr) {
        result = result.replace(new RegExp('\\b' + numStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), symtab[i])
      }
    }
  }

  // Alfa's _replacestrings: replace var _xxx=["...","..."] arrays
  const varMatch = result.match(/var\s+(_\w+)\s*=\s*\["([\s\S]*?)"\];/)
  if (varMatch) {
    const varname = varMatch[1]
    const strings = varMatch[2].split('","')
    // Replace _xxx[index] with "string"
    for (let i = 0; i < strings.length; i++) {
      result = result.replace(new RegExp(varname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\[' + i + '\\]', 'g'), '"' + strings[i] + '"')
    }
    // Remove the var declaration
    result = result.substring(varMatch.index + varMatch[0].length)
  }

  return result
}

// Helper: extract m3u8 from sources:[{file:"..."}] block (Fastream style).
// Pass baseUrl to resolve relative URLs.
function extractFromUnpacked(unpacked, baseUrl) {
  if (!unpacked) return ''
  // Fastream: sources:[{file:"https://...m3u8"}]
  const sourcesBlockMatch = unpacked.match(/sources\s*:\s*\[([\s\S]*?)\]/)
  if (sourcesBlockMatch) {
    const fileMatch = sourcesBlockMatch[1].match(/file:\s*"([^"]+\.m3u8[^"]*)"/)
    if (fileMatch) return absUrl(fileMatch[1], baseUrl)
    const fileMatch2 = sourcesBlockMatch[1].match(/file:\s*'([^']+\.m3u8[^']*)'/)
    if (fileMatch2) return absUrl(fileMatch2[1], baseUrl)
    const fileMatch3 = sourcesBlockMatch[1].match(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/)
    if (fileMatch3) return absUrl(fileMatch3[1], baseUrl)
  }
  return ''
}

// Helper: extract HLS URL from decoded packed JS.
// Many hosts (Streamwish, Vidhide) use a `var links = {hls2: "...", hls4: "..."}` pattern.
// The hls2 key usually has a clean m3u8 URL; hls4 often has a '.split(' decoy.
// Pass baseUrl to resolve relative URLs.
function extractHlsFromLinks(decoded, baseUrl) {
  if (!decoded) return ''
  // Try links object: var links = {"hls2":"https://...master.m3u8?t=..."}
  const linksMatch = decoded.match(/var\s+links\s*=\s*\{([^}]+)\}/)
  if (linksMatch) {
    // Prefer hls2 (usually clean absolute URL), then hls3, then hls4
    for (const key of ['hls2', 'hls3', 'hls4']) {
      const m = linksMatch[1].match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
      if (m && m[1] && !m[1].includes("'.split(") && /\.m3u8/i.test(m[1])) {
        const url = m[1]
        // Prefer absolute URLs
        if (/^https?:\/\//i.test(url)) return url
        // Make relative URL absolute
        if (baseUrl) return absUrl(url, baseUrl)
      }
    }
  }
  // Fallback: find any clean m3u8 URL in decoded JS
  const m3u8 = decoded.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/i)
  if (m3u8 && !m3u8[0].includes("'.split(")) return m3u8[0]
  return ''
}

// Helper: pick best source from list of {url, label}
function pickSource(sources) {
  if (!sources || !sources.length) return ''
  // Prefer m3u8 (HLS) for compatibility, then highest quality mp4
  const hls = sources.find(s => /\.m3u8/i.test(s.url))
  if (hls) return hls.url
  const mp4s = sources.filter(s => /\.mp4/i.test(s.url))
  if (mp4s.length) return mp4s[0].url
  return sources[0].url
}

// Helper: fetch a master m3u8 playlist and return the highest-quality variant URL.
// Parses #EXT-X-STREAM-INF.*?RESOLUTION=WIDTHxHEIGHT to pick the best stream.
// Falls back to the original URL if parsing fails or it's not a master playlist.
async function pickBestFromMasterM3u8(m3u8Url, referer) {
  if (!m3u8Url) return ''
  try {
    const content = await fetchPage(m3u8Url, referer)
    if (!content || !content.includes('#EXT-X-STREAM-INF')) return m3u8Url
    const lines = content.split('\n')
    let bestUrl = ''
    let bestHeight = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const resMatch = line.match(/RESOLUTION=\d+x(\d+)/)
        const height = resMatch ? parseInt(resMatch[1]) : 0
        // Next non-empty line is the URL
        for (let j = i + 1; j < lines.length; j++) {
          const urlLine = lines[j].trim()
          if (urlLine && !urlLine.startsWith('#')) {
            if (height > bestHeight) {
              bestHeight = height
              bestUrl = absUrl(urlLine, m3u8Url)
            }
            break
          }
        }
      }
    }
    return bestUrl || m3u8Url
  } catch {
    return m3u8Url
  }
}

// Helper: scrape sources from common patterns
function scrapeSources(html) {
  const sources = []
  const patterns = [
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)/gi,
    /sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)/gi,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/gi,
    /source\s+src=["']([^"']+)/gi,
    /<source[^>]+src=["']([^"']+)/gi,
    /["']?file["']?\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
  ]
  for (const p of patterns) {
    const matches = reAll(html, p.source, p.flags)
    for (const m of matches) {
      if (m[1]) sources.push({ url: m[1], label: '' })
    }
    if (sources.length) break
  }
  return sources
}

// ===================== RESOLVERS =====================

const resolvers = []

// Sentinel: the page explicitly reports the video as deleted/404.
// resolveEmbed propagates it so the caller can drop the stream entirely
// instead of showing a dead embed in the list.
export const DEAD_LINK = Symbol('dead-link')

// True when the page itself says the file is gone (not just unresolvable).
function isDeadPage(html) {
  if (!html) return false
  return /<title>\s*404|404 Not Found|video you are looking for is not found|file (?:not found|was deleted|is no longer available|has been deleted)|video not found|>WE ARE SORRY<|domain is for sale|video has been removed/i.test(html)
}

function addResolver(name, domains, resolve) {
  resolvers.push({ name, domains: domains.map(d => d.toLowerCase()), resolve })
}

// --- VOE ---
// Ported faithfully from ResolveURL's voesx.py (GPL-3.0)
// Includes voe_decode for the obfuscated JSON+LUT encoding
addResolver('voe', [
  'voe.sx', 'voe-unblock.com', 'voeunblock.com', 'voe-unblock.net',
  // Catch-all: "voe" matches any URL containing voe (voe.sx, voex, voe-unblock, etc.)
  'voe',
  // Mirror domains detected by channels (eugenemakedraw, etc.)
  'eugenemakedraw',
  'edwardarriveoften.com', 'nathanfromsubject.com', 'audaciousdefaulthouse.com',
  'launchreliantcleaverriver.com', 'kennethofficialitem.com', 'housecardsummerbutton.com',
  'fittingcentermondaysunday.com', 'lukecomparetwo.com', 'realfinanceblogcenter.com',
  'tinycat-voe-fashion.com', '35volitantplimsoles5.com', '20demidistance9elongations.com',
  'telyn610zoanthropy.com', 'toxitabellaeatrebates306.com', 'greaseball6eventual20.com',
  '745mingiestblissfully.com', '19turanosephantasia.com', '30sensualizeexpression.com',
  '321naturelikefurfuroid.com', '449unceremoniousnasoseptal.com', 'guidon40hyporadius9.com',
  'cyamidpulverulence530.com', 'boonlessbestselling244.com', 'antecoxalbobbing1010.com',
  'matriculant401merited.com', 'scatch176duplicities.com', 'availedsmallest.com',
  'counterclockwisejacky.com', 'simpulumlamerop.com', 'paulkitchendark.com',
  'metagnathtuggers.com', 'gamoneinterrupted.com', 'chromotypic.com',
  'crownmakermacaronicism.com', 'generatesnitrosate.com', 'yodelswartlike.com',
  'figeterpiazine.com', 'strawberriesporail.com', 'valeronevijao.com',
  'timberwoodanotia.com', 'apinchcaseation.com', 'nectareousoverelate.com',
  'nonesnanking.com', 'kathleenmemberhistory.com', 'stevenimaginelittle.com',
  'jamiesamewalk.com', 'bradleyviewdoctor.com', 'sandrataxeight.com',
  'graceaddresscommunity.com', 'shannonpersonalcost.com', 'cindyeyefinal.com',
  'michaelapplysome.com', 'sethniceletter.com', 'brucevotewithin.com',
  'rebeccaneverbase.com', 'loriwithinfamily.com', 'roberteachfinal.com',
  'erikcoldperson.com', 'jasminetesttry.com', 'heatherdiscussionwhen.com',
  'robertplacespace.com', 'alleneconomicmatter.com', 'josephseveralconcern.com',
  'donaldlineelse.com', 'lisatrialidea.com', 'toddpartneranimal.com',
  'jamessoundcost.com', 'brittneystandardwestern.com', 'sandratableother.com',
  'robertordercharacter.com', 'maxfinishseveral.com', 'chuckle-tube.com',
  'kristiesoundsimply.com', 'adrianmissionminute.com', 'richardsignfish.com',
  'jennifercertaindevelopment.com', 'diananatureforeign.com', 'goofy-banana.com',
  'mariatheserepublican.com', 'johnalwayssame.com', 'kellywhatcould.com',
  'jilliandescribecompany.com', 'lukesitturn.com', 'mikaylaarealike.com',
  'christopheruntilpoint.com', 'walterprettytheir.com', 'crystaltreatmenteast.com',
  'lauradaydo.com', 'smoki.cc', 'lancewhosedifficult.com', 'ogladaj.me',
  'dianaavoidthey.com', 'jefferycontrolmodel.com', 'marissasharecareer.com',
  'charlestoughrace.com', 'ianrequireadult.com', 'timmaybealready.com',
  'jessicayeahcatch.com', 'kinoger.ru', 'johnbeyondnation.com',
  'jeanprofessorcentral.com', 'juliewomanwish.com', 'garylargeavailable.com',
  'jennifereconomicgive.com', 'pamelachangemission.com', 'ellenpoliticalfollow.com',
  'caseyimpactstation.com', 'matthewhotelscience.com', 'jessicachoosemake.com',
  'stevenfamilyedge.com', 'tracylocalschool.com', 'eugenemakedraw.com',
  'morencius.com', 'jennifercertaindevelopment.com', 'dramiyos-cdn.com',
], async (url) => {
  console.log('[Voe] Resolving:', url)
  const VOE_HEADERS = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    // NO Accept-Encoding manual: CapacitorHttp no descomprime gzip cuando el
    // header se fija a mano — la respuesta llegaba como binario ilegible.
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  }
  let webUrl = url
  let html = await fetchPage(webUrl, undefined, VOE_HEADERS)
  console.log('[Voe] HTML length:', html?.length || 0)

  // If page is empty/404, try mirrors — voe.sx ya no sirve /e/ directamente,
  // pero los mirrors (morencius, etc.) aceptan los mismos video IDs.
  if (!html || /<title>404/i.test(html) || /Not Found/i.test(html.slice(0, 500))) {
    const videoIdMatch = url.match(/\/(?:e|embed)\/([^\/?]+)/i)
    if (videoIdMatch) {
      const vid = videoIdMatch[1]
      const MIRRORS = [
        `https://morencius.com/embed/${vid}`,
        `https://eugenemakedraw.com/embed/${vid}`,
        `https://jilliandescribecompany.com/embed/${vid}`,
        `https://chrisalthough.com/embed/${vid}`,
        `https://voe.sx/e/${vid}`,
      ]
      for (const mirror of MIRRORS) {
        if (mirror === url) continue
        console.log('[Voe] Page empty/404, trying mirror:', mirror)
        webUrl = mirror
        html = await fetchPage(webUrl, undefined, VOE_HEADERS)
        if (html && !/<title>404/i.test(html) && html.length > 1000) {
          console.log('[Voe] Mirror OK, HTML length:', html.length)
          break
        }
        html = ''
      }
    }
  }

  // Follow JS redirects (Alfa: window.location.href = '...' or permanentToken redirect)
  let redirectCount = 0
  while (redirectCount < 5) {
    let redirect = re1(html, /(?:window\.)?(?:location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/)
    if (!redirect) redirect = re1(html, /(?:window\.)?location\.replace\(['"]([^'"]+)['"]\)/)
    if (redirect && redirect !== webUrl) {
      console.log('[Voe] Following redirect:', redirect)
      webUrl = absUrl(redirect, webUrl)
      html = await fetchPage(webUrl, undefined, VOE_HEADERS)
      redirectCount++
    } else break
  }

  // ALTCHA gate ("Confirm you're human to start the video"): proof-of-work
  // PBKDF2 — solvable in JS without user interaction. CapacitorHttp shares the
  // WebView cookie jar on Android, so the session cookie set by the GET is
  // sent on the POST automatically.
  if (html && /altcha-widget/i.test(html)) {
    const gated = await solveAltchaGate(webUrl, html, VOE_HEADERS)
    if (gated) html = gated
  }

  // Method 0: AniWorld VOE extractor (encoded JSON / var a168c / plain hls)
  const aniworldSource = extractVoeSourceFromHtml(html)
  if (aniworldSource) {
    console.log('[Voe] AniWorld source found:', aniworldSource.substring(0, 80))
    return absUrl(aniworldSource, webUrl)
  }

  // Method 1: JSON + LUT encoding (voe_decode)
  // Alfa: r = re.search(r'json">\["([^"]+)"]</script>\s*<script\s*src="([^"]+)', data)
  const jsonMatch = html.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)"/)
  if (jsonMatch) {
    const ct = jsonMatch[1]
    const scriptUrl = absUrl(jsonMatch[2], webUrl)
    const html2 = await fetchPage(scriptUrl, webUrl, VOE_HEADERS)
    // Extract LUT: ['xx','yy',...] (tolerate spaces between elements)
    const lutsMatch = html2.match(/(\[(?:\s*'\W{2}'\s*,?\s*){1,9}\s*\])/)
    if (lutsMatch) {
      const decoded = voeDecode(ct, lutsMatch[1])
      if (decoded) {
        // Extract sources from decoded JSON
        const sources = []
        for (const key of ['file', 'source', 'direct_access_url']) {
          if (decoded[key]) sources.push(decoded[key])
        }
        if (sources.length) {
          // Prefer HLS, then MP4
          const hls = sources.find(s => /\.m3u8/i.test(s))
          if (hls) return hls
          return sources[0]
        }
      }
    }
  }

  // Method 2: Direct source patterns (Alfa: mp4/hls': '...')
  // Alfa: video_srcs = scrapertools.find_multiple_matches(data, r"(?:mp4|hls)': '([^']+)'")
  console.log('[Voe] Has json pattern:', /json">\["/.test(html))
  console.log('[Voe] Has mp4:', /mp4/.test(html))
  console.log('[Voe] Has hls:', /hls/.test(html))
  console.log('[Voe] Has sources:', /sources/.test(html))
  console.log('[Voe] Has file:', /file/.test(html))
  console.log('[Voe] Has let hex:', /let\s+[0-9a-f]+\s*=\s*'/i.test(html))
  console.log('[Voe] HTML snippet:', html.substring(0, 300))
  const directSrcs = reAll(html, /(?:mp4|hls)['"]?\s*:\s*['"]([^'"]+)/)
  if (directSrcs.length) {
    for (const s of directSrcs) {
      if (s && /^https?:\/\//.test(s)) {
        return s
      }
      if (s && s.startsWith('aHR0')) {
        // Alfa: base64 decode if starts with aHR0
        try {
          const decoded = b64decode(s)
          if (decoded && /^https?:\/\//.test(decoded)) return decoded
        } catch {}
      }
    }
  }

  // Alfa: bloque = scrapertools.find_single_match(data, "sources.*?\}")
  //        video_srcs = scrapertools.find_multiple_matches(bloque, ": '([^']+)")
  const sourcesBlock = re1(html, /sources\s*[\s\S]*?\}/)
  if (sourcesBlock) {
    const blockSrcs = reAll(sourcesBlock, /:\s*['"]([^'"]+)/)
    for (const s of blockSrcs) {
      if (s && /^https?:\/\//.test(s) && /\.m3u8|\.mp4/i.test(s)) {
        return s
      }
    }
  }

  // Method 3: base64 + reversed JSON (Alfa fallback)
  // Pattern: let <hex> = '<base64>'; decode, reverse, parse JSON for 'file'
  const revMatch = html.match(/let\s+[0-9a-f]+\s*=\s*'(.*?)'/i)
  if (revMatch) {
    try {
      const dec = b64decode(revMatch[1])
      const reversed = dec.split('').reverse().join('')
      const jsonData = JSON.parse(reversed)
      if (jsonData.file) return absUrl(jsonData.file, webUrl)
      if (jsonData.source) return absUrl(jsonData.source, webUrl)
    } catch {}
  }

  // Method 3b: packed player JS — los mirrors actuales de VOE/vidhide
  // entregan las fuentes dentro de eval(p,a,c,k,e,d) en vez de JSON.
  for (const js of unpackPackedScripts(html)) {
    const hls = js.match(/https?:\/\/[^\s"'\\]+?\.m3u8[^\s"'\\]*/i)
    if (hls) {
      console.log('[Voe] packed-JS hls:', hls[0].substring(0, 80))
      return hls[0]
    }
    const mp4 = js.match(/https?:\/\/[^\s"'\\]+?\.mp4[^\s"'\\]*/i)
    if (mp4) return mp4[0]
    // vidhide sirve la playlist como master.txt (contenido m3u8)
    const txt = js.match(/https?:\/\/[^\s"'\\]+?master\.txt[^\s"'\\]*/i)
    if (txt) return txt[0]
  }

  // Method 4: Generic scrape
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)

  return ''
})

// --- WAAW removed ---
// waaw.to resolves to 127.0.0.1, waaw.tv redirects to waaw.to.
// Domain is dead. Provider 45 removed from HDFull PROVIDERS.
// If the domain comes back, re-add provider 45 in hdfull.js and a resolver here.

// Port of voe_decode from ResolveURL's voesx.py
function voeDecode(ct, luts) {
  try {
    // Extract LUT entries of two chars inside single quotes, tolerant of spaces
    const lutMatches = [...luts.matchAll(/'([^']{2})'/g)]
    const lutStr = lutMatches.map(m => m[1])
    // Escape regex special chars in each LUT entry
    const lut = lutStr.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

    // Apply ROT13-like cipher to ct
    let txt = ''
    for (const ch of ct) {
      let x = ch.charCodeAt(0)
      if (x > 64 && x < 91) {
        x = (x - 52) % 26 + 65
      } else if (x > 96 && x < 123) {
        x = (x - 84) % 26 + 97
      }
      txt += String.fromCharCode(x)
    }

    // Remove LUT patterns from txt
    for (const pattern of lut) {
      txt = txt.replace(new RegExp(pattern, 'g'), '')
    }

    // Base64 decode
    let decoded = b64decode(txt)

    // Subtract 3 from each char code
    let shifted = ''
    for (const ch of decoded) {
      shifted += String.fromCharCode(ch.charCodeAt(0) - 3)
    }

    // Reverse and base64 decode again
    const reversed = shifted.split('').reverse().join('')
    const final = b64decode(reversed)

    return JSON.parse(final)
  } catch (e) {
    console.warn('[VoeDecode] Error:', e?.message)
    return null
  }
}

// Port of decode_voe_string from AniWorld-Downloader's voe.py
const VOE_JUNK_PARTS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]

function voeRot13(input) {
  let out = ''
  for (const c of input) {
    let x = c.charCodeAt(0)
    if (x >= 65 && x <= 90) x = (x - 65 + 13) % 26 + 65
    else if (x >= 97 && x <= 122) x = (x - 97 + 13) % 26 + 97
    out += String.fromCharCode(x)
  }
  return out
}

function voeReplaceJunk(input) {
  let s = input
  for (const part of VOE_JUNK_PARTS) {
    s = s.replaceAll(part, '_')
  }
  return s.replace(/_/g, '')
}

function voeShiftBack(s, n) {
  return [...s].map(c => String.fromCharCode(c.charCodeAt(0) - n)).join('')
}

function decodeVoeString(encoded) {
  const step1 = voeRot13(encoded)
  const step2 = voeReplaceJunk(step1)
  const step3 = b64decode(step2)
  const step4 = voeShiftBack(step3, 3)
  const step5 = b64decode(step4.split('').reverse().join(''))
  return JSON.parse(step5)
}

// --- ALTCHA gate solver (VOE "Confirm you're human") ---
// PBKDF2 proof-of-work: password = nonce_bytes + counter(uint32 BE),
// derivedKey = PBKDF2(password, salt, cost, keyLength). Find counter where
// derivedKey starts with keyPrefix bytes. Then POST the gate form with the
// base64 JSON payload. Session cookies are handled by the shared cookie jar.
async function solveAltchaGate(pageUrl, gateHtml, headers) {
  try {
    const challengeUrl = re1(gateHtml, /challenge="([^"]+)"/)
    const token = re1(gateHtml, /name="_token"[^>]*value="([^"]+)"/)
    if (!challengeUrl || !token || !globalThis.crypto?.subtle) return null
    const chalAbs = absUrl(challengeUrl, pageUrl)

    const chalText = await fetchPage(chalAbs, pageUrl, { ...headers, 'Accept': 'application/json' })
    const chal = JSON.parse(chalText)
    const p = chal.parameters
    if (!p?.nonce || !p?.salt || !p?.keyPrefix) return null

    const h2b = h => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a }
    const b2h = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    const nonce = h2b(p.nonce), salt = h2b(p.salt)
    const prefixBytes = p.keyPrefix.length % 2 === 0 ? h2b(p.keyPrefix) : null
    const hashName = (p.algorithm || 'PBKDF2/SHA-256').replace('PBKDF2/', '')
    const t0 = Date.now()

    let counter = 0, derivedHex = ''
    while (counter < 500000) {
      const pw = new Uint8Array(nonce.length + 4)
      pw.set(nonce)
      new DataView(pw.buffer).setUint32(nonce.length, counter, false)
      const key = await crypto.subtle.importKey('raw', pw, { name: 'PBKDF2' }, false, ['deriveBits'])
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: hashName, salt, iterations: p.cost || 10000 },
        key, (p.keyLength || 32) * 8)
      const dk = new Uint8Array(bits)
      const ok = prefixBytes
        ? prefixBytes.every((b, i) => dk[i] === b)
        : b2h(dk).startsWith(p.keyPrefix)
      if (ok) { derivedHex = b2h(dk); break }
      counter++
    }
    if (!derivedHex) return null
    const took = Date.now() - t0
    console.log('[Voe] ALTCHA solved in', took, 'ms (counter', counter + ')')

    const payload = btoa(JSON.stringify({
      challenge: { parameters: p, signature: chal.signature },
      solution: { counter, derivedKey: derivedHex, time: took },
    }))
    const body = `_token=${encodeURIComponent(token)}&access=0&altcha=${encodeURIComponent(payload)}`
    const realHtml = await postPage(pageUrl, body, undefined, { ...headers, 'Referer': pageUrl })
    if (realHtml && !/altcha-widget/i.test(realHtml)) return realHtml
    return null
  } catch (e) {
    console.warn('[Voe] ALTCHA gate failed:', e?.message)
    return null
  }
}

export function extractVoeSourceFromHtml(html) {
  if (!html) return null
  // Variant 1: <script type="application/json"> with encoded payload
  const jsonBlocks = reAll(html, /<script\s+type=["']application\/json["']>([\s\S]*?)<\/script>/, 's')
  for (const m of jsonBlocks) {
    const raw = m[1].trim()
    try {
      const parsed = JSON.parse(raw)
      const encoded = Array.isArray(parsed) ? parsed[0] : parsed
      if (typeof encoded !== 'string') continue
      const decoded = decodeVoeString(encoded)
      const src = decoded?.source || decoded?.file || decoded?.direct_access_url
      if (src && /^https?:/i.test(src)) return src
    } catch {}
  }

  // Variant 2: var a168c='<encoded>'
  const a168c = re1(html, /var a168c=["']([^'"]+)["']/, 'i')
  if (a168c) {
    try {
      const decoded = decodeVoeString(a168c)
      if (decoded?.source) return decoded.source
    } catch {}
  }

  // Variant 3: plain 'hls': '<url>'
  const hls = re1(html, /['"]hls['"]\s*:\s*['"]([^'"]+)['"]/, 'i')
  if (hls) return hls

  return null
}

// --- DOODSTREAM ---
// Ported from AniWorld-Downloader's doodstream.py
// Token-based handshake: extract pass_md5 URL + token, GET pass_md5 to get base URL,
// then assemble: {base_url}{random_10_chars}?token={token}&expiry={unix_timestamp}
addResolver('doodstream', [
  'dood.so', 'dood.pm', 'dood.ws', 'dood.cx', 'dood.la', 'dood.li', 'dood.to',
  'dood.watch', 'dood.yt', 'dood.re', 'dood.wf', 'dood.sh', 'dood.site',
  'doodstream.com', 'doodstream.co', 'doodstream.net', 'doodstream.org',
  'dood.stream', 'doodsearch.site', 'dooodster.com', 'doods.pro',
  'd0000d.com', 'd0o0d.com', 'do0od.com', 'dsvplay.com', 'doply.net',
  'vide0.net', 'vvide0.com', 'dood.video', 'd-s.io', 'playmogo.com',
], async (url) => {
  console.log('[Doodstream] Resolving:', url)
  const headers = {
    'User-Agent': UA_DESKTOP,
    'Referer': url,
  }
  let html = await fetchPage(url, undefined, headers)
  if (!html) return ''
  if (isDeadPage(html)) return DEAD_LINK

  // Follow redirect
  const redirect = re1(html, /window\.location\.href\s*=\s*['"]([^'"]+)['"]/)
  if (redirect) {
    const newUrl = absUrl(redirect, url)
    html = await fetchPage(newUrl, undefined, headers)
    url = newUrl
    if (isDeadPage(html)) return DEAD_LINK
  }

  // Extract pass_md5 URL: $.get('/pass_md5/...', cb) — la página real usa
  // path relativo y el callback va tras una coma, no un ')'.
  let passMd5Url = re1(html, /\$\.get\(['"]([^'"]*\/pass_md5\/[^'"]*)['"]/)
    || re1(html, /(https?:\/\/[^'"]*\/pass_md5\/[^'"]+)/)
    || re1(html, /['"]((?:\/)?pass_md5\/[^'"]+)['"]/)
  if (!passMd5Url) {
    // Fallback: look for video source directly
    const sources = scrapeSources(html)
    if (sources.length) return pickSource(sources)
    return ''
  }
  if (!passMd5Url.startsWith('http')) {
    passMd5Url = absUrl(passMd5Url, url)
  }

  // Extract token: token=([a-zA-Z0-9]+)
  const token = re1(html, /token=([a-zA-Z0-9]+)/)
  if (!token) {
    const sources = scrapeSources(html)
    if (sources.length) return pickSource(sources)
    return ''
  }

  // GET pass_md5 URL to get video base URL
  let md5Html = await fetchPage(passMd5Url, url, headers)
  if (!md5Html) {
    // AniWorld forces the canonical host: pass_md5 on dood.li is less guarded
    // than rotated domains (dood.to, dooodster.com, ...). Retry there.
    try {
      const p = new URL(passMd5Url)
      if (p.hostname !== 'dood.li') {
        p.hostname = 'dood.li'
        md5Html = await fetchPage(p.toString(), 'https://dood.li/', { 'User-Agent': UA_DESKTOP, 'Referer': 'https://dood.li/' })
      }
    } catch { /* keep empty */ }
  }
  if (!md5Html) return ''
  const videoBaseUrl = md5Html.trim()
  if (!videoBaseUrl) return ''

  // Generate 10-char random string
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let randomStr = ''
  for (let i = 0; i < 10; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  // Assemble direct link: {base_url}{random_str}?token={token}&expiry={timestamp}
  const expiry = Math.floor(Date.now() / 1000)
  const directLink = `${videoBaseUrl}${randomStr}?token=${token}&expiry=${expiry}`
  console.log('[Doodstream] Resolved:', directLink.substring(0, 80))
  return directLink
})

// --- STREAMTAPE ---
// Ported from Plurtasko/Alfa streamtape.py
// Uses obfuscated innerHTML with substring() calls to build the video URL
addResolver('streamtape', [
  'streamtape.com', 'streamtape.to', 'streamtape.net', 'streamtape.cc',
  'stpserver.com', 'streamta.pe', 'streamtape.xyz',
], async (url) => {
  const html = await fetchPage(url)
  if (!html) return ''

  // Pattern from Alfa: innerHTML = "//streamtape.com/get_vide" + ''+ ('...').substring(3).substring(1)
  // The last innerHTML match has the full URL construction
  const innerHTMLMatches = html.match(/innerHTML\s*=\s*([^;]+)/g) || []
  if (innerHTMLMatches.length > 0) {
    // Take the last match (like Alfa does)
    const lastMatch = innerHTMLMatches[innerHTMLMatches.length - 1]
    // Extract the get_video URL by evaluating the string operations
    // Pattern: '//streamtape.com/get_vide' + ''+ ('xnftb?id=...&token=...').substring(3).substring(1)
    // Or:    '//streamtape.com/get_vide'+ ('xyzao?id=...&token=...').substring(4)
    
    // Extract the base URL part
    const baseUrlMatch = lastMatch.match(/["']([^"']*get_vide[^"']*)["']/)
    // Extract the query string with substring operations
    const queryMatch = lastMatch.match(/\((['"])([^'"]+)(['"])\)\.substring\((\d+)\)(?:\.substring\((\d+)\))?/)
    
    if (baseUrlMatch && queryMatch) {
      let baseUrl = baseUrlMatch[1]
      let query = queryMatch[2]
      const sub1 = parseInt(queryMatch[4]) || 0
      const sub2 = parseInt(queryMatch[5]) || 0
      
      // Apply substring operations
      if (sub1 > 0) query = query.substring(sub1)
      if (sub2 > 0) query = query.substring(sub2)
      
      // Build full URL
      const fullUrl = `https:${baseUrl}${query}`
      // StreamTape redirects to the actual video URL
      return fullUrl
    }
  }

  // Fallback: get_video?id= pattern
  const getVideo = re1(html, /get_video\?id=([^&"'\s]+)/)
  if (getVideo) {
    const fullUrl = `https://${new URL(url).host}/get_video?id=${getVideo}`
    return fullUrl
  }

  // Fallback: direct link pattern — la URL del propio embed (/e/…/xxx.mp4)
  // también contiene "streamtape" y ".mp4"; excluir páginas /e//v//embed.
  const link = re1(html, /["']([^"']*streamtape[^"']*\.mp4[^"']*)["']/i)
  if (link && !/\/(e|v|embed)\//i.test(link)) return absUrl(link, url)

  // Try robot link
  const robotLink = re1(html, /robot\s*link.*?href=["']([^"']+)/)
  if (robotLink) return absUrl(robotLink, url)

  return ''
})

// --- FILEMOON / FILELIONS ---
addResolver('filemoon', [
  'filemoon.sx', 'filemoon.to', 'filemoon.nl', 'filemooon.link', 'filemooon.to',
  'moonstream.pro', 'moonplayer.pro', '9n8o.com', 'bysefujedu.com',
  'byseweb.com', 'bysexo.com', 'byses.org', 'kerapoxy.co',
], async (url) => {
  // Method 1: API-based AES-256-GCM decryption (like Alfa)
  // La SPA "Byse" llama a {origin}/api/videos/{id}/embed/playback — mismo origen.
  // Formatos vistos: /e/{id}, /d/{id}, /es/{id}/embed, /{id}/embed
  const idMatch = url.match(/\/(?:e|d|es|v)\/([a-zA-Z0-9]{12})(?:$|\/|\?)/)
    || url.match(/\/([a-zA-Z0-9]{12})\/embed(?:$|\/|\?)/)
  if (idMatch) {
    const origin = (() => { try { return new URL(url).origin } catch { return '' } })()
    const apiHosts = [origin, 'https://filemooon.link'].filter(Boolean)
    for (const host of apiHosts) {
      try {
        const playbackUrl = `${host}/api/videos/${idMatch[1]}/embed/playback`
        const playbackHtml = await fetchPage(playbackUrl, url)
        if (!playbackHtml) continue
        const data = JSON.parse(playbackHtml)
        const pb = data.playback || {}
        if (pb.algorithm === 'AES-256-GCM' && pb.key_parts?.length === 2) {
          const iv = b64uDecode(pb.iv)
          const payload = b64uDecode(pb.payload)
          const kp1 = b64uDecode(pb.key_parts[0])
          const kp2 = b64uDecode(pb.key_parts[1])
          let key = kp1 + kp2
          if (key.length !== 32) {
            const hash = await crypto.subtle.digest('SHA-256', key)
            key = new Uint8Array(hash)
          }
          // AES-256-GCM decrypt
          const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt'])
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, payload)
          const decJson = JSON.parse(new TextDecoder().decode(decrypted))
          const m3u8 = decJson.sources?.[0]?.url
          if (m3u8) return absUrl(m3u8, url)
        }
      } catch (e) {
        console.warn('[filemoon] API decryption failed:', e?.message)
      }
    }
  }

  // Method 2: Scrape sources from page — solo URLs de media reales: la página
  // enlaza /stream y /embed internos que scrapeSources capturaba como "source"
  // y el caller acababa recibiendo HTML en vez de vídeo.
  const html = await fetchPage(url)
  const sources = scrapeSources(html).filter(u => /\.(m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(u))
  if (sources.length) return pickSource(sources)
  // FileMoon often uses eval'd JS
  const evalMatch = re1(html, /eval\(function\(p,a,c,k,e,d\).*?\)\s*\)/s)
  if (evalMatch) {
    // Try to find m3u8/mp4 in the packed JS
    const packed = re1(html, /'([^']*\.m3u8[^']*)'/)
    if (packed) return absUrl(packed, url)
  }
  return ''
})

// Base64URL decode helper for filemoon
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad) s += '='.repeat(4 - pad)
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

addResolver('filelions', [
  'filelions.com', 'filelions.to', 'filelions.net', 'filelions.org',
  'ajmidyadfihayh.com', 'alhayabambi.com', 'moflix-stream.com',
  'azipcdn.com', 'guccihideout.com',
], async (url) => {
  const html = await fetchPage(url)
  // FileLions uses var links = {...}
  const linksMatch = re1(html, /var\s+links\s*=\s*({[^;]+})/)
  if (linksMatch) {
    try {
      const links = JSON.parse(linksMatch.replace(/'/g, '"'))
      const keys = Object.keys(links).sort((a, b) => parseInt(b) - parseInt(a))
      for (const k of keys) {
        if (links[k] && /\.m3u8|\.mp4/i.test(links[k])) return absUrl(links[k], url)
      }
    } catch {}
  }
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- MIXDROP ---
// Based on Alfa connector + mixdrop-direct-resolver (sharoon7171):
// the canonical domain is now miixdrop.net; the packed eval exposes
// MDCore.wurl = "//a-deliveryNN.mxcontent.net/v2/{id}.mp4?s=…" (signed,
// protocol-relative). The CDN 403s without Referer https://miixdrop.net/.
addResolver('mixdrop', [
  'mixdrop.co', 'mixdrop.to', 'mixdrop.sx', 'mixdrop.bz', 'mixdrop.ch',
  'mixdrp.co', 'mixdrp.to', 'mixdrop.ag', 'mixdrop.club', 'mixdrop.ps',
  'miixdrop.net', 'mixdrop23.net', 'mixdrop21.net', 'mixdrop20.net',
  'mxdrop.net', 'mixdrop.gl', 'mixdrop.my',
], async (url) => {
  // Alfa: /f/ → /e/ (embed page has the player)
  if (/\/f\//.test(url)) url = url.replace('/f/', '/e/')

  let html = await fetchPage(url)

  // Old mirrors redirect to miixdrop.net — follow either HTTP or JS redirect
  if (!html || html.length < 500) {
    const idMatch = url.match(/\/e\/([^\/?#]+)/i)
    if (idMatch && !/miixdrop\.net/i.test(url)) {
      url = `https://miixdrop.net/e/${idMatch[1]}`
      html = await fetchPage(url)
    }
  }
  const redirect = re1(html, /location\s*=\s*["']([^"']+)/)
  if (redirect) {
    url = absUrl(redirect, url)
    html = await fetchPage(url)
  }

  if (isDeadPage(html)) {
    console.warn('[Mixdrop] File not found')
    return DEAD_LINK
  }

  // Alfa approach: unpack packed JS and extract MDCore.xxx = "..."
  const decoded = decodePackedJs(html)
  if (decoded) {
    // Alfa: MDCore.\w+\s*=\s*"([^"]+)" — wurl is the canonical key
    const mdcoreMatches = reAll(decoded, /MDCore\.(\w+)\s*=\s*"([^"]+)"/)
    for (const m of mdcoreMatches) {
      const [, key, val] = m
      // Solo wurl o URLs de vídeo — MDCore.poster guarda el thumbnail en el
      // mismo CDN (mxcontent .jpg) y lo devolvía como si fuera el stream.
      const isVideo = /\.(mp4|m3u8|mkv|webm)(?:[?#]|$)/i.test(val)
      if (key === 'wurl' || isVideo || (/mxcontent/i.test(val) && !/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(val))) {
        let mediaUrl = val
        if (mediaUrl.startsWith('//')) mediaUrl = 'https:' + mediaUrl
        else if (!/^https?:/.test(mediaUrl)) mediaUrl = 'https:' + mediaUrl
        console.log('[Mixdrop] Found via MDcore.' + key + ':', mediaUrl.substring(0, 80))
        return mediaUrl
      }
    }
    // Any direct media URL in the unpacked code
    const media = decoded.match(/(?:https?:)?\/\/[^\s"']*mxcontent[^\s"']*\.mp4[^\s"']*/i)
      || decoded.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/i)
    if (media) {
      const u = media[0].startsWith('//') ? 'https:' + media[0] : media[0]
      return u
    }
  }

  // Fallback: vsr/wurl/surl variables (old Mixdrop)
  const videoUrl = re1(html, /(?:vsr|wurl|surl)[^=]*=\s*["']([^"']+)/)
  if (videoUrl) {
    const decoded2 = b64decode(videoUrl.split('').reverse().join(''))
    if (decoded2 && /^https?:\/\//.test(decoded2)) return decoded2
    if (videoUrl.startsWith('http')) return videoUrl
  }

  // Fallback: generic scrape
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- UPSTREAM ---
addResolver('upstream', [
  'upstream.to', 'upstreamvideo.co',
], async (url) => {
  const html = await fetchPage(url)
  // Upstream uses redirect_vid function
  const redirectMatch = re1(html, /redirect_vid\('([^']+)','([^']+)','([^']+)'/)
  if (redirectMatch) {
    // Need to fetch the direct link page
    const directPage = re1(html, /href="([^"]+)">Direct/)
    if (directPage) {
      const dhtml = await fetchPage(absUrl(directPage, url), url)
      const directUrl = re1(dhtml, /<a\s+href="([^"]+)"/)
      if (directUrl) return directUrl
    }
  }
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- UQLOAD ---
addResolver('uqload', [
  'uqload.com', 'uqload.io', 'uqload.co', 'uqload.is', 'uqload.ws',
  'uqload.net', 'uqload.cx', 'uqload.bz', 'uqload.org', 'uqload.vc',
], async (url) => {
  const html = await fetchPage(url)
  if (!html) return ''
  const sourceUrl = re1(html, /sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  // uqload packs the jwplayer setup with p.a.c.k.e.r
  const decoded = decodePackedJs(html)
  if (decoded) {
    const packedFile = re1(decoded, /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
    if (packedFile) return absUrl(packedFile, url)
    const fromUnpacked = extractFromUnpacked(decoded, url)
    if (fromUnpacked) return fromUnpacked
  }
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- MP4UPLOAD ---
// Ported from Plurtasko/Alfa mp4upload.py
// Uses packed JS (jsunpack) or direct src: pattern
addResolver('mp4upload', ['mp4upload.com'], async (url) => {
  const html = await fetchPage(url)
  if (!html) return ''

  // Try packed JS first (like Plurtasko)
  if (html.includes('p.a.c.k.e.r') || html.includes('eval(function')) {
    const decoded = decodePackedJs(html)
    if (decoded) {
      const src = re1(decoded, /src\s*:\s*"([^"]+)"/)
      if (src) return absUrl(src, url)
      const file = re1(decoded, /"file"\s*:\s*"([^"]+)"/)
      if (file) return absUrl(file, url)
    }
  }

  // Direct src: "..." pattern (common in mp4upload embeds)
  const sourceUrl = re1(html, /src\s*:\s*"([^"]+\.mp4[^"]*)"/)
  if (sourceUrl) return absUrl(sourceUrl, url)

  // Fallback: src("...")
  const srcParen = re1(html, /src\("([^"]+\.mp4[^"]*)"/)
  if (srcParen) return absUrl(srcParen, url)

  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- YOURUPLOAD ---
// Ported from Plurtasko/Alfa yourupload.py
// Extracts og:video meta tag or file: '...' pattern → direct MP4
addResolver('yourupload', ['yourupload.com'], async (url) => {
  const html = await fetchPage(url)
  if (!html) return ''

  // Pattern 1: og:video meta tag
  const ogVideo = re1(html, /<meta\s+property="og:video"\s+content="([^"]+)"/)
  if (ogVideo) return ogVideo

  // Pattern 2: file: '...' (single quotes)
  const fileMatch = re1(html, /file\s*:\s*'([^']+)'/)
  if (fileMatch) {
    const fullUrl = fileMatch.startsWith('http') ? fileMatch : `https://www.yourupload.com${fileMatch}`
    return fullUrl
  }

  // Pattern 3: file: "..." (double quotes)
  const fileMatch2 = re1(html, /file\s*:\s*"([^"]+)"/)
  if (fileMatch2) {
    const fullUrl = fileMatch2.startsWith('http') ? fileMatch2 : `https://www.yourupload.com${fileMatch2}`
    return fullUrl
  }

  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- STREAMWISH ---
// Ported from ResolveURL's streamwish.py
// Uses packer-style obfuscated JS with a `links` object containing hls2/hls3/hls4 URLs.
addResolver('streamwish', [
  'streamwish.to', 'streamwish.com', 'streamwish.site', 'streamwish.xyz',
  'flaswish.com', 'obeywish.com', 'sfastwish.com', 'strwish.com',
  'embedwish.com', 'mwish.com', 'awish.com', 'dwish.com', 'swish.to',
  'cdnwish.com', 'asnwish.com', 'playerwish.com', 'hlswish.com',
  'streamwishonly.com', 'streamwishsrv.com',
  // DMCA redirect hosts
  'hgplaycdn.com', 'hglamioz.com', 'niramirus.com', 'playnixes.com', 'medixiru.com',
  // Main hosts
  'hanerix.com', 'audinifer.com', 'vibuxer.com', 'masukestin.com',
  // Rules hosts (redirect to main)
  'dhcplay.com', 'hglink.to', 'hgcloud.to',
  // Rotating mirrors
  'swdyu.com', 'swhoi.com', 'jodwish.com', 'wishonly.site', 'swadyou.com',
], async (url) => {
  // If using a "rules" host, try each main host until one works
  const urlObj = (() => { try { return new URL(url) } catch { return null } })()
  if (urlObj && /dhcplay\.com|hglink\.to|hgcloud\.to/.test(urlObj.host)) {
    const mainHosts = ['hanerix.com', 'audinifer.com', 'vibuxer.com', 'masukestin.com']
    for (const host of mainHosts) {
      urlObj.host = host
      const tryUrl = urlObj.href
      const html = await fetchPage(tryUrl)
      if (!html || html.length < 1000) continue

      // Pattern 1: sources: [{file: "..."}]
      const sourceMatch = html.match(/sources:\s*\[{file:\s*["']([^"']+)/)
      if (sourceMatch) return absUrl(sourceMatch[1], tryUrl)

      // Pattern 2: decode packed JS and extract links.hls2
      const decoded = decodePackedJs(html)
      if (decoded) {
        const hls = extractHlsFromLinks(decoded, tryUrl)
        if (hls) return hls
        const m3u8 = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i)
        if (m3u8) return m3u8[0]
      }

      // Generic fallback
      const sources = scrapeSources(html)
      if (sources.length) return pickSource(sources)
    }
    return ''
  }

  const html = await fetchPage(url)
  if (!html) {
    console.log('[streamwish] Empty page from', url)
    return ''
  }
  console.log('[streamwish] Page from', url, 'len=' + html.length)

  // Pattern 1: sources: [{file: "..."}]
  const sourceMatch = html.match(/sources:\s*\[{file:\s*["']([^"']+)/)
  if (sourceMatch) {
    console.log('[streamwish] Found sources pattern:', sourceMatch[1].substring(0, 80))
    let result = absUrl(sourceMatch[1], url)
    // If it's a master m3u8, pick the best quality variant
    if (/master\.m3u8/i.test(result)) {
      result = await pickBestFromMasterM3u8(result, url)
    }
    return result
  }

  // Pattern 2: links with hls
  const hlsMatch = html.match(/links\s*=.+?hls[24]":\s*"([^"]+)/)
  if (hlsMatch) {
    console.log('[streamwish] Found hls links pattern:', hlsMatch[1].substring(0, 80))
    let result = absUrl(hlsMatch[1], url)
    if (/master\.m3u8/i.test(result)) {
      result = await pickBestFromMasterM3u8(result, url)
    }
    return result
  }

  // Pattern 3: decode packed JS and extract links.hls2
  const decoded = decodePackedJs(html)
  if (decoded) {
    console.log('[streamwish] Decoded packed JS, len=' + decoded.length)
    const hls = extractHlsFromLinks(decoded, url)
    if (hls) {
      console.log('[streamwish] Found HLS from packed JS:', hls.substring(0, 80))
      let result = hls
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, url)
      }
      return result
    }
    // Fallback: find m3u8 directly
    const m3u8 = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i)
    if (m3u8) {
      console.log('[streamwish] Found m3u8 in decoded JS:', m3u8[0].substring(0, 80))
      let result = m3u8[0]
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, url)
      }
      return result
    }
  } else {
    console.log('[streamwish] No packed JS found')
  }

  // Generic fallback
  const sources = scrapeSources(html)
  if (sources.length) {
    console.log('[streamwish] Generic sources found:', sources.length)
    return pickSource(sources)
  }
  console.log('[streamwish] All patterns failed for', url)
  return ''
})

// --- VIDHIDE ---
// Vidhide uses packer-style obfuscated JS
// with a `links` object containing hls2/hls4 URLs (same pattern as Streamwish).
addResolver('vidhide', [
  'vidhide.com', 'vidhide.to', 'vidhide.org', 'morencius.com',
  'acek-cdn.com', 'pixibay.cc', 'vidhidepro.com', 'vidhidefast.com',
  'vidhidevip.com', 'vidhideplus.com', 'vidhidehub.com', 'vidhide.fun',
  'vidhide.biz', 'vidhide.live', 'vidhide.fit', 'filelions.live',
], async (url) => {
  const html = await fetchPage(url)
  if (!html) return ''

  // Pattern 1: sources: [{file: "..."}]
  const sourceMatch = html.match(/sources:\s*\[{file:\s*["']([^"']+)/)
  if (sourceMatch) {
    // Keep the master URL intact; ExoPlayer selects the variant and the
    // signed Vidhide token must not be consumed by an extra fetch.
    return absUrl(sourceMatch[1], url)
  }

  // Pattern 2: decode packed JS and extract links.hls2
  const decoded = decodePackedJs(html)
  if (decoded) {
    const hls = extractHlsFromLinks(decoded, url)
    if (hls) return hls
    // Fallback: find m3u8 directly
    const m3u8 = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i)
    if (m3u8) return m3u8[0]
  }

  // Generic fallback
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- OK.RU ---
addResolver('okru', ['ok.ru', 'odnoklassniki.ru', 'okru.link'], async (url) => {
  // Method 1: POST to decoding API for okru.link/v2 URLs (like Alfa)
  if (/okru\.link\/v2/.test(url)) {
    try {
      const v = re1(url, /t=([\w.]+)/)
      if (v) {
        const apiUrl = 'https://apizz.okru.link/decoding'
        const body = `video=${encodeURIComponent(v)}`
        const apiHtml = await fetchPage(`${apiUrl}?${body}`, url)
        if (apiHtml) {
          const videoUrl = re1(apiHtml, /"url":"([^"]+)"/)
          if (videoUrl) return videoUrl.replace(/\\\//g, '/').replace(/\\u0026/g, '&')
        }
      }
    } catch {}
  }
  // Method 2: GET details.php for okru.link/embed URLs
  if (/okru\.link\/embed/.test(url)) {
    try {
      const v = re1(url, /t=(\w+)/)
      if (v) {
        const detailsHtml = await fetchPage(`https://okru.link/details.php?v=${v}`, url)
        if (detailsHtml) {
          try {
            const data = JSON.parse(detailsHtml)
            if (data.file) return data.file.replace(/\\\//g, '/').replace(/\\u0026/g, '&')
          } catch {}
        }
      }
    } catch {}
  }
  // Method 3: Standard OK.ru embed parsing
  const html = await fetchPage(url)
  if (!html || html.length > 500000) return '' // Evita OOM con páginas enormes
  // OK.ru stores data in data-options attribute
  const dataOptions = re1(html, /data-options="([^"]+)"/)
  if (dataOptions && dataOptions.length < 200000) {
    try {
      const decoded = JSON.parse(decodeURIComponent(dataOptions.replace(/"/g, '"').replace(/&/g, '&')))
      const videos = decoded?.flashvars?.metadata?.videos || []
      if (videos.length) {
        // Prefer highest quality
        const sorted = videos.sort((a, b) => (b.height || 0) - (a.height || 0))
        return sorted[0].url
      }
    } catch {}
  }
  // Fallback: direct URL patterns
  const mp4 = re1(html, /"url":"([^"]+\.mp4[^"]*)"/)
  if (mp4) return mp4.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  const hls = re1(html, /"hlsManifestUrl":"([^"]+)"/)
  if (hls) return hls.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  return ''
})

// --- KWIK ---
addResolver('kwik', ['kwik.cx', 'kwik.si'], async (url) => {
  const html = await fetchPage(url)
  const sourceUrl = re1(html, /const\s+source\s*=\s*'([^']+)/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- VIDMOLY ---
// Vidmoly uses Cloudflare Turnstile (captcha). Strategy based on Alfa & Balandro:
// 1. Normalize URL: /embed-{id}.html → /{id}.html (direct page has fewer restrictions)
// 2. Send cf_turnstile_demo_pass_{id}=1 cookie to bypass Turnstile
// 3. If captcha detected (>Security Check<), try alternate domain vidmoly.biz
// 4. Extract sources with multiple patterns (double/single quotes, packed JS)
addResolver('vidmoly', ['vidmoly.me', 'vidmoly.to', 'vidmoly.net', 'vidmoly.biz'], async (url) => {
  // Extract video ID from URL (handles /embed-{id}.html, /w/{id}, /d/{id}, /v/{id})
  const idMatch = url.match(/\/(?:embed-|w\/|d\/|v\/)([^\/?\.]+)/i)
  const videoId = idMatch ? idMatch[1] : ''

  // Build headers with Cloudflare Turnstile bypass cookie
  const buildHeaders = (id) => {
    const h = {
      ...HEADERS,
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    }
    if (id) h['Cookie'] = `cf_turnstile_demo_pass_${id}=1`
    return h
  }

  // Try to extract stream URL from HTML
  const extractFromHtml = async (html, pageUrl) => {
    if (!html) return ''

    // Detect captcha/security check
    if (/>Security Check</i.test(html) || /challenges\.cloudflare\.com/i.test(html)) {
      console.warn('[Vidmoly] Security check detected in response')
      return ''
    }

    // Pattern 1: {file:"..."...label:"..."} or {file:'...'...label:"..."} (Alfa style)
    const directMatch = html.match(/\{\s*file:\s*["']([^"']+)["']\s*\}.*?label:\s*["']([^"']+)["']/)
    if (directMatch) {
      let result = absUrl(directMatch[1], pageUrl)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, pageUrl)
      }
      return result
    }

    // Pattern 2: sources: [{file: "..."}] - flexible whitespace and quotes
    const sourceUrl = re1(html, /sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)/)
    if (sourceUrl) {
      let result = absUrl(sourceUrl, pageUrl)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, pageUrl)
      }
      return result
    }

    // Pattern 2b: sources:.*?file:.*?'...' (Balandro style, single quotes)
    const singleQuoteSource = re1(html, /sources:.*?file:.*?'([^']+)'/)
    if (singleQuoteSource && /m3u8|mp4/i.test(singleQuoteSource)) {
      let result = absUrl(singleQuoteSource, pageUrl)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, pageUrl)
      }
      return result
    }

    // Pattern 2c: sources:.*?file:.*?"..." (Balandro style, double quotes)
    const doubleQuoteSource = re1(html, /sources:.*?file:.*?"([^"]+)"/)
    if (doubleQuoteSource && /m3u8|mp4/i.test(doubleQuoteSource)) {
      let result = absUrl(doubleQuoteSource, pageUrl)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, pageUrl)
      }
      return result
    }

    // Pattern 3: unpack packed JS (like Alfa/Balandro)
    const decoded = decodePackedJs(html)
    if (decoded) {
      const blockMatch = decoded.match(/sources\s*:\s*\[(.*?)\]/)
      if (blockMatch) {
        const fileMatch = blockMatch[1].match(/file:\s*["']([^"']+)["']/)
        if (fileMatch) {
          let result = absUrl(fileMatch[1], pageUrl)
          if (/master\.m3u8/i.test(result)) {
            result = await pickBestFromMasterM3u8(result, pageUrl)
          }
          return result
        }
      }
    }

    // Pattern 4: master.m3u8 directly in HTML
    const masterMatch = html.match(/(https?:\/\/[^"'\s]+master\.m3u8[^"'\s]*)/i)
    if (masterMatch) {
      return await pickBestFromMasterM3u8(masterMatch[1], pageUrl)
    }

    const sources = scrapeSources(html)
    if (sources.length) return pickSource(sources)

    return ''
  }

  // Strategy 1: Try normalized direct page (Balandro approach)
  // /embed-{id}.html → /{id}.html (direct page has fewer restrictions)
  const directUrl = videoId
    ? url.replace(/\/embed-[^\/?\.]+\.html/i, `/${videoId}.html`)
        .replace(/\/(w|d|v)\//i, `/${videoId}.html`)
        .replace(/vidmoly\.(me|to|net)/i, 'vidmoly.me')
    : url

  const headers1 = buildHeaders(videoId)
  try {
    const controller1 = new AbortController()
    const timeout1 = setTimeout(() => controller1.abort(), 15000)
    const html1 = await fetchHtml(directUrl, controller1.signal, headers1)
    clearTimeout(timeout1)
    const result1 = await extractFromHtml(html1, directUrl)
    if (result1) {
      console.log('[Vidmoly] Resolved via direct page:', directUrl.substring(0, 80))
      return result1
    }
  } catch (e) {
    console.warn('[Vidmoly] Direct page failed:', e?.message)
  }

  // Strategy 2: Try original embed URL with cookie
  const headers2 = buildHeaders(videoId)
  try {
    const controller2 = new AbortController()
    const timeout2 = setTimeout(() => controller2.abort(), 15000)
    const html2 = await fetchHtml(url, controller2.signal, headers2)
    clearTimeout(timeout2)
    const result2 = await extractFromHtml(html2, url)
    if (result2) {
      console.log('[Vidmoly] Resolved via embed URL:', url.substring(0, 80))
      return result2
    }
  } catch (e) {
    console.warn('[Vidmoly] Embed URL failed:', e?.message)
  }

  // Strategy 3: Try alternate domain vidmoly.biz (Alfa/Balandro approach)
  if (videoId && !/vidmoly\.biz/i.test(url)) {
    const altUrl = `https://vidmoly.biz/embed-${videoId}.html`
    const headers3 = buildHeaders(videoId)
    try {
      const controller3 = new AbortController()
      const timeout3 = setTimeout(() => controller3.abort(), 15000)
      const html3 = await fetchHtml(altUrl, controller3.signal, headers3)
      clearTimeout(timeout3)
      const result3 = await extractFromHtml(html3, altUrl)
      if (result3) {
        console.log('[Vidmoly] Resolved via alternate domain vidmoly.biz')
        return result3
      }
    } catch (e) {
      console.warn('[Vidmoly] Alternate domain failed:', e?.message)
    }
  }

  return ''
})

// --- LULUSTREAM ---
addResolver('lulustream', [
  'lulustream.com', 'lulustream.to', 'luluvid.com', 'luluvdo.com',
  'luluvide.com', '732eg54de642sa.com', 'cdn1.lulustream.com',
  'streamhihi.com', 'd00ds.com',
], async (url) => {
  const html = await fetchPage(url)
  // Pattern 1: direct sources: [{file/src: "..."}]
  const sourceUrl = re1(html, /sources\s*:\s*\[\s*\{\s*(?:file|src)\s*:\s*["']([^"']+)/)
  if (sourceUrl) {
    let result = absUrl(sourceUrl, url)
    if (/master\.m3u8/i.test(result)) {
      result = await pickBestFromMasterM3u8(result, url)
    }
    return result
  }
  // Pattern 2: unpack packed JS (like Alfa)
  const decoded = decodePackedJs(html)
  if (decoded) {
    const matches = decoded.match(/sources\s*:\s*\[\s*\{(?:file|src)\s*:\s*"([^"]+)"/)
    if (matches) {
      let result = absUrl(matches[1], url)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, url)
      }
      return result
    }
  }
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- MAXSTREAM ---
addResolver('maxstream', ['maxstream.org'], async (url) => {
  const html = await fetchPage(url)
  const sourceUrl = re1(html, /file\s*:\s*"([^"]+)"/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- VIDOZA ---
addResolver('vidoza', ['vidoza.net', 'vidoza.co', 'videoza.net'], async (url) => {
  const html = await fetchPage(url)
  // Pattern 1: sourcesCode JSON-like array (like Alfa/Plurtasko)
  const sourcesCodeMatch = html.match(/sourcesCode\s*:\s*(\[\{.*?\}\])/)
  if (sourcesCodeMatch) {
    try {
      // Normalize JS object to JSON (src: → "src":, file: → "file":, etc.)
      const normalized = sourcesCodeMatch[1]
        .replace(/src:/g, '"src":')
        .replace(/file:/g, '"file":')
        .replace(/type:/g, '"type":')
        .replace(/label:/g, '"label":')
        .replace(/res:/g, '"res":')
      const data = JSON.parse(normalized)
      if (data && data.length) {
        // Prefer highest resolution
        const sorted = data.sort((a, b) => (b.res || b.label || 0) - (a.res || a.label || 0))
        const src = sorted[0].src || sorted[0].file
        if (src) return absUrl(src, url)
      }
    } catch {}
  }
  // Pattern 2: <source src="..." (like Plurtasko)
  const sourceTag = re1(html, /<source\s+src="([^"]+)"/)
  if (sourceTag) return absUrl(sourceTag, url)
  // Pattern 3: generic scrape
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  const sourceUrl = re1(html, /["']?\s*(?:file|src)\s*["']?\s*[:=,]?\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  return ''
})

// --- SUPERVIDEO ---
addResolver('supervideo', ['supervideo.tv', 'supervideo.cc'], async (url) => {
  const html = await fetchPage(url)
  // Try unpacking packed JS first (like Alfa)
  const decoded = decodePackedJs(html)
  if (decoded) {
    const sourceMatch = decoded.match(/\{(?:file|"hls\d+"|src):"([^"]+)"/)
    if (sourceMatch) {
      let result = absUrl(sourceMatch[1], url)
      if (/master\.m3u8/i.test(result)) {
        result = await pickBestFromMasterM3u8(result, url)
      }
      return result
    }
  }
  // Fallback: generic scrape
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  const sourceUrl = re1(html, /\{\s*file\s*:\s*"([^"]+)"/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  return ''
})

// --- FASTPLAY ---
addResolver('fastplay', ['fastplay.sx', 'fastplay.cc', 'fastplay.to'], async (url) => {
  const html = await fetchPage(url)
  // Unpack packed JS if present (like Plurtasko)
  let data = html
  if (html.includes('p,a,c,k,e,d')) {
    const decoded = decodePackedJs(html)
    if (decoded) data = decoded.replace(/\\/g, '')
  }
  // Extract file:"...",label:"..." pairs (like Plurtasko)
  const matches = reAll(data, /file\s*:\s*"([^"]+)"\s*,\s*label\s*:\s*"([^"]+)"/)
  if (matches.length) {
    // Pick highest quality
    const sorted = matches.sort((a, b) => (parseInt(b[2]) || 0) - (parseInt(a[2]) || 0))
    let result = absUrl(sorted[0][1], url)
    if (/master\.m3u8/i.test(result)) {
      result = await pickBestFromMasterM3u8(result, url)
    }
    return result
  }
  const sources = scrapeSources(data)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- FASTREAM ---
// Ported from Alfa/Balandro: unpack eval(...) and extract sources: [{file:"..."}]
// Return the master.m3u8 URL without consuming it (no pickBestFromMasterM3u8).
addResolver('fastream', ['fastream.to'], async (url) => {
  console.log('[Fastream] Resolving:', url)

  // emb.html?id= format uses a POST to /dl (CloudStream approach)
  const embMatch = url.match(/emb\.html\?([^=]+)=/)
  if (embMatch) {
    const fileId = embMatch[1]
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const body = `op=embed&file_code=${fileId}&auto=1`
      const dlResult = await postPage(`https://fastream.to/dl`, body, controller.signal)
      clearTimeout(timeout)
      if (dlResult) {
        if (/File is no longer available/i.test(dlResult)) return ''
        const decoded = decodePackedJs(dlResult)
        const hls = extractFromUnpacked(decoded, url)
        if (hls) {
          console.log('[Fastream] Found m3u8 via POST:', hls.substring(0, 80))
          return hls
        }
      }
    } catch (e) {
      console.warn('[Fastream] POST /dl failed:', e?.message)
    }
  }

  const html = await fetchPage(url, url, {
    'User-Agent': UA_DESKTOP,
    'Origin': 'https://fastream.to',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.5,en;q=0.3',
  })
  if (!html) {
    console.warn('[Fastream] No HTML returned for', hostOf(url))
    return ''
  }

  if (/File is no longer available/i.test(html)) {
    console.warn('[Fastream] File no longer available')
    return ''
  }

  const sources = scrapeSources(html)
  if (sources.length) {
    console.log('[Fastream] Found sources via scrapeSources:', sources.length)
    return pickSource(sources)
  }

  const decoded = decodePackedJs(html)
  if (!decoded) {
    console.warn('[Fastream] Failed to decode packed JS')
    return ''
  }
  console.log('[Fastream] Decoded JS length:', decoded.length)

  const hls = extractFromUnpacked(decoded, url)
  if (hls) {
    console.log('[Fastream] Found m3u8:', hls.substring(0, 80))
    return hls
  }

  const linksHls = extractHlsFromLinks(decoded, url)
  if (linksHls) {
    console.log('[Fastream] Found HLS via links object:', linksHls.substring(0, 80))
    return linksHls
  }

  const m3u8Match = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i)
  if (m3u8Match) {
    console.log('[Fastream] Found m3u8 via regex:', m3u8Match[0].substring(0, 80))
    return m3u8Match[0]
  }

  const fileMatch = decoded.match(/file\s*:\s*["']([^"']+)/)
  if (fileMatch && /m3u8|mp4|http/i.test(fileMatch[1])) {
    console.log('[Fastream] Found file via file: pattern:', fileMatch[1].substring(0, 80))
    return absUrl(fileMatch[1], url)
  }

  console.warn('[Fastream] No stream URL found')
  return ''
})

// --- TURBOVID ---
addResolver('turbovid', [
  'turbovid.eu', 'turbovid.to', 'turbovid.me', 'turbovid.co', 'turbovid.xyz',
  'emturbovid.com', 'turboVIplay.com', 'turboavi.com', 'turbovid.net',
], async (url) => {
  const html = await fetchPage(url)
  const apkey = re1(html, /const\s+apkey\s*=\s*"([^"]+)/)
  const xxid = re1(html, /const\s+xxid\s*=\s*"([^"]+)/)
  const origin = (() => { try { return new URL(url).origin } catch { return '' } })()
  if (apkey && xxid) {
    const apiUrl = `${origin}/api?apkey=${apkey}&xxid=${xxid}`
    const apiHtml = await fetchPage(apiUrl, url)
    const juice = re1(apiHtml, /juice":"([^"]+)"/)
    if (juice) {
      const dataUrl = `${origin}/${juice}`
      const dataHtml = await fetchPage(dataUrl, url)
      const videoUrl = re1(dataHtml, /data":"([^"]+)"/)
      if (videoUrl) return b64decode(videoUrl)
    }
  }
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- SENDVID ---
addResolver('sendvid', ['sendvid.com'], async (url) => {
  const html = await fetchPage(url)
  // Pattern 1: var video_source = "..." (like Alfa)
  const videoSource = re1(html, /var\s+video_source\s*=\s*"([^"]+)"/)
  if (videoSource) {
    // Alfa cache-1/cache-2 fallback: try both CDN caches
    if (/cache-1/.test(videoSource)) {
      return videoSource
    }
    if (/cache-2/.test(videoSource)) {
      return videoSource
    }
    return videoSource
  }
  // Pattern 2: source src="..."
  const sourceUrl = re1(html, /source\s+src="([^"]+)"/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- GOOGLEVIDEO (direct) ---
addResolver('gvideo', ['googleusercontent.com', 'google.com', 'docs.google.com'], async (url) => {
  // Google video URLs are usually already direct
  if (/videoplayback/.test(url)) return url
  const html = await fetchPage(url)
  const sources = reAll(html, /"([^"]*videoplayback[^"]+)"/g)
  if (sources.length) return sources[0][1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  return ''
})

// --- MEGA ---
addResolver('mega', ['mega.nz', 'mega.co.nz'], async (url) => {
  // Mega requires API calls - return embed URL for iframe playback
  return url
})

// --- VIMEO ---
addResolver('vimeo', ['vimeo.com', 'player.vimeo.com'], async (url) => {
  // Vimeo embed - return as embed for iframe
  if (/player\.vimeo\.com/.test(url)) return url
  const videoId = re1(url, /vimeo\.com\/(\d+)/)
  if (videoId) return `https://player.vimeo.com/video/${videoId}`
  return ''
})

// --- DAILYMOTION ---
addResolver('dailymotion', ['dailymotion.com', 'dai.ly'], async (url) => {
  const videoId = re1(url, /(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/)
  if (videoId) return `https://www.dailymotion.com/embed/video/${videoId}`
  return ''
})

// --- RUMBLE ---
addResolver('rumble', ['rumble.com'], async (url) => {
  const html = await fetchPage(url)
  const sourceUrl = re1(html, /"src":"([^"]+\.mp4[^"]*)"/)
  if (sourceUrl) return sourceUrl.replace(/\\\//g, '/')
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- VK ---
addResolver('vk', ['vk.com', 'vkontakte.ru', 'vk.ru'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  // VK stores video URL in data-attributes or JSON
  const cacheData = re1(html, /"cache(\d{3,4})":"([^"]+)"/g)
  if (cacheData) {
    const url2 = re1(html, /"cache\d{3,4}":"([^"]+)"/)
    if (url2) return url2.replace(/\\\//g, '/').replace(/\\u0026/g, '&')
  }
  return ''
})

// --- EMBEDGRAM ---
addResolver('embedgram', ['embedgram.com'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  const sourceUrl = re1(html, /file\s*:\s*["']([^"']+)/)
  if (sourceUrl) return absUrl(sourceUrl, url)
  return ''
})

// --- STREAMABLE ---
addResolver('streamable', ['streamable.com'], async (url) => {
  const videoId = re1(url, /streamable\.com\/(\w+)/)
  if (videoId) {
    const apiUrl = `https://api.streamable.com/videos/${videoId}`
    try {
      const html = await fetchPage(apiUrl)
      const data = JSON.parse(html)
      const mp4 = data?.files?.mp4?.url || data?.files?.mp4_mobile?.url
      if (mp4) return mp4
    } catch {}
  }
  return ''
})

// --- VIDFAST ---
addResolver('vidfast', ['vidfast.co'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- STREAMOUPLOAD ---
addResolver('streamoupload', ['streamoupload.org', 'streamoupload.com'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- EMBEDRISE ---
addResolver('embedrise', ['embedrise.com'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- ANONSTREAM ---
addResolver('anonstream', ['anonstream.com'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- HIGHSTREAM ---
addResolver('highstream', ['highstream.tv', 'highstream.co'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- STREAMRUBY ---
addResolver('streamruby', ['streamruby.com'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- GOOSTREAM ---
addResolver('gostream', ['gostream.to', 'gostream.site'], async (url) => {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- VIDARA ---
// La página /e/{filecode} monta JWPlayer tras un POST same-origin a
// /api/stream con {filecode, device}; la respuesta JSON trae streaming_url.
addResolver('vidara', [
  'vidara.to', 'vidara.so', 'vidara.su', 'vidara.io', 'vidara.net',
], async (url) => {
  const filecode = re1(url, /\/e\/([^\/?#]+)/i) || re1(url, /\/([A-Za-z0-9]+)(?:[?#]|$)/)
  if (!filecode) return ''
  let apiBase
  try { apiBase = new URL(url).origin } catch { return '' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const headers = { ...HEADERS, 'User-Agent': UA_DESKTOP, 'Referer': url }
    const data = await postPageJson(`${apiBase}/api/stream`, { filecode, device: 'web' }, controller.signal, headers)
    clearTimeout(timeout)
    if (data?.streaming_url) {
      console.log('[Vidara] Resolved:', String(data.streaming_url).substring(0, 80))
      return data.streaming_url
    }
  } catch (e) {
    clearTimeout(timeout)
    console.warn('[Vidara] API failed:', e?.message || e)
  }

  // Fallback: scrape the embed page
  const html = await fetchPage(url, undefined, { 'User-Agent': UA_DESKTOP })
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- VIDSONIC ---
// El embed ofusca la URL como hex separado por '|', decodificado por pares
// y luego invertido (const _0x1 = '34|70|6d|...' → decode → reverse).
addResolver('vidsonic', [
  'vidsonic.net', 'vidsonic.to', 'vidsonic.co', 'vidsonic.cc',
], async (url) => {
  const html = await fetchPage(url, undefined, { 'User-Agent': UA_DESKTOP })
  if (!html) return ''

  // Patrón: const _0x1 = 'hex|hex|hex...'; _decode() → pares hex → reverse
  const hexMatch = re1(html, /(?:const|let|var)\s+\w+\s*=\s*'([0-9a-fA-F]{2}(?:\|[0-9a-fA-F]{2}){10,})'/)
  if (hexMatch) {
    const clean = hexMatch.split('|').join('')
    let out = ''
    for (let i = 0; i + 1 < clean.length; i += 2) {
      out += String.fromCharCode(parseInt(clean.substr(i, 2), 16))
    }
    const decoded = out.split('').reverse().join('')
    if (/^https?:\/\//i.test(decoded) && /\.(m3u8|mp4)/i.test(decoded)) {
      console.log('[Vidsonic] Resolved:', decoded.substring(0, 80))
      return decoded
    }
  }

  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  const m3u8 = re1(html, /(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/i)
  if (m3u8) return m3u8
  return ''
})

// --- STREAMPLAY / POWVIDEO / VUDEO / WOLFSTREAM ---
// Hosts clónicos con el player dentro de eval(function(p,a,c,k,e,d)...)
// o con sources:[{file:"..."}] plano. Comparten el flujo genérico.
async function resolvePackedJsHost(url) {
  const html = await fetchPage(url, url, { 'User-Agent': UA_DESKTOP })
  if (!html) return ''
  if (isDeadPage(html)) return DEAD_LINK

  // 1. sources plano
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)

  // 2. JS empaquetado
  const decoded = decodePackedJs(html)
  if (decoded) {
    const hls = extractFromUnpacked(decoded, url) || extractHlsFromLinks(decoded, url)
    if (hls) return hls
    const m = decoded.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/i)
    if (m) return m[0]
  }

  // 3. unpackPackedScripts (multi-bloque eval)
  for (const block of unpackPackedScripts(html)) {
    const m = block.match(/(https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*)/i)
    if (m) return absUrl(m[1], url)
  }

  // 4. m3u8/mp4 suelto en la página
  const direct = re1(html, /(https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*)/i)
  if (direct) return direct
  return ''
}

addResolver('streamplay', [
  'streamplay.to', 'streamplay.me', 'streamplay.cc', 'streamplay.top',
  'streamplay.lol', 'stape.fun', 'watchadsontape.com',
], resolvePackedJsHost)

addResolver('powvideo', [
  'powvideo.org', 'powwideo.org', 'powvideo.net', 'powvideo.cc',
  'powvldeo.me', 'povwideo.cc',
], resolvePackedJsHost)

addResolver('vudeo', [
  'vudeo.io', 'vudeo.ws', 'vudeo.net', 'vudeo.co', 'vudeo.cc',
], resolvePackedJsHost)

addResolver('wolfstream', [
  'wolfstream.tv', 'wolfstream.se', 'wolf-stream.tv',
], resolvePackedJsHost)

// --- VIDGUARD / VGEMBED ---
// VidGuard sirve un blob hex en una etiqueta SVG/objet o un eval con
// `window.__` que la página decodifica en JS. Intentamos la ruta estática:
// decodePackedJs + sources; si no hay nada útil queda como embed.
addResolver('vidguard', [
  'vgembed.com', 'vid-guard.com', 'vembed.net', 'vgfplay.com',
  'bembed.net', 'listeamed.net', 'vidguard.to',
], async (url) => {
  const html = await fetchPage(url, undefined, { 'User-Agent': UA_DESKTOP })
  if (!html) return ''
  if (isDeadPage(html) || /Not Found/i.test(html.slice(0, 800))) return DEAD_LINK

  // decodePackedJs cubre la variante eval(function(p,a,c,k,e,d)...)
  const decoded = decodePackedJs(html)
  if (decoded) {
    const hls = extractHlsFromLinks(decoded, url) || extractFromUnpacked(decoded, url)
    if (hls) return hls
    const m = decoded.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i)
    if (m) return m[0]
  }

  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  return ''
})

// --- EMBED69 / CUEVANA EMBED ---
addResolver('embed69', ['embed69.org', 'cuevanapro.org'], async (url) => {
  const html = await fetchPage(url)

  // Extract PoW parameters
  const challenge = re1(html, /POW_CHALLENGE\s*=\s*'([^']+)'/)
  const difficulty = parseInt(re1(html, /POW_DIFFICULTY\s*=\s*(\d+)/) || '3', 10)
  const salt = re1(html, /POW_SALT\s*=\s*'([^']+)'/)

  if (!challenge || !salt) {
    // Fallback: try direct source extraction
    const sources = scrapeSources(html)
    if (sources.length) return pickSource(sources)
    return ''
  }

  // Extract dataLink JSON
  const dataLinkMatch = re1(html, /let\s+dataLink\s*=\s*(\[.*?\]);/)
  if (!dataLinkMatch) return ''

  let dataLink
  try {
    dataLink = JSON.parse(dataLinkMatch)
  } catch {
    return ''
  }

  // Solve PoW: find nonce such that SHA-256(challenge + nonce) starts with `difficulty` zeros
  // Then derive AES key from SHA-256(challenge + nonce + salt)
  const prefix = '0'.repeat(difficulty)
  let nonce = 0
  let aesKey = null

  for (let n = 0; n < 10000000; n++) {
    const powData = challenge + n
    const powHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(powData))
      )
    ).map(b => b.toString(16).padStart(2, '0')).join('')

    if (powHash.startsWith(prefix)) {
      nonce = n
      // AES key = SHA-256(challenge + nonce + salt)
      aesKey = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(challenge + n + salt))
      )
      break
    }
    // Yield to event loop every 1000 iterations
    if (n % 1000 === 0) await new Promise(r => setTimeout(r, 0))
  }

  if (!aesKey) return ''

  // Decrypt AES-CBC
  async function decryptAES(encryptedBase64) {
    try {
      const raw = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0))
      const iv = raw.slice(0, 16)
      const ciphertext = raw.slice(16)
      const key = await crypto.subtle.importKey('raw', aesKey.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt'])
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext)
      return new TextDecoder().decode(decrypted)
    } catch {
      return ''
    }
  }

  // Decrypt all links and collect resolved URLs
  const resolved = []
  for (const file of dataLink) {
    if (!file.sortedEmbeds) continue
    for (const embed of file.sortedEmbeds) {
      if (embed.link && typeof embed.link === 'string') {
        const decrypted = await decryptAES(embed.link)
        if (decrypted) {
          resolved.push({
            server: embed.servername,
            url: decrypted,
            lang: file.video_language,
          })
        }
      }
    }
  }

  // Return the first resolved URL (prefer voe > streamwish > others)
  const priority = ['voe', 'streamwish', 'filemoon', 'vidhide', 'doodstream']
  for (const p of priority) {
    const found = resolved.find(r => r.server === p)
    if (found) return found.url
  }
  if (resolved.length) return resolved[0].url
  return ''
})

// Export the full list of decrypted embed69 servers
export async function resolveEmbed69All(url) {
  const html = await fetchPage(url)

  if (!html) {
    console.log('[embed69] Empty page from', url)
    return []
  }

  // If the page has an iframe to embed69.org, follow it
  const iframeMatch = re1(html, /<iframe[^>]+src=["']([^"']*embed69\.org[^"']+)["']/i)
  if (iframeMatch) {
    console.log('[embed69] Found iframe to embed69.org, following:', iframeMatch.substring(0, 80))
    return resolveEmbed69All(absUrl(iframeMatch, url))
  }

  // Check for JS redirect to embed69.org
  const jsRedirect = re1(html, /(?:window\.location|location\.href|document\.location)\s*=\s*["']([^"']*embed69\.org[^"']+)["']/i)
  if (jsRedirect) {
    console.log('[embed69] Found JS redirect to embed69.org, following:', jsRedirect.substring(0, 80))
    return resolveEmbed69All(absUrl(jsRedirect, url))
  }

  // Check for meta refresh redirect
  const metaRefresh = re1(html, /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>]+)/i)
  if (metaRefresh && /embed69\.org/i.test(metaRefresh)) {
    console.log('[embed69] Found meta refresh to embed69.org, following:', metaRefresh.substring(0, 80))
    return resolveEmbed69All(absUrl(metaRefresh, url))
  }

  const challenge = re1(html, /POW_CHALLENGE\s*=\s*'([^']+)'/)
  const difficulty = parseInt(re1(html, /POW_DIFFICULTY\s*=\s*(\d+)/) || '3', 10)
  const salt = re1(html, /POW_SALT\s*=\s*'([^']+)'/)

  if (!challenge || !salt) {
    console.log('[embed69] No POW challenge found in', url, '(len=' + html.length + ')')
    // Fallback: try to extract direct video URLs from the page
    const sources = scrapeSources(html)
    if (sources.length) {
      console.log('[embed69] Found direct sources:', sources.length)
      return sources.map(s => ({ server: 'direct', url: s.url, lang: '' }))
    }
    return []
  }

  console.log('[embed69] POW challenge found, difficulty=' + difficulty + ', solving...')

  const dataLinkMatch = re1(html, /let\s+dataLink\s*=\s*(\[.*?\]);/)
  if (!dataLinkMatch) return []

  let dataLink
  try { dataLink = JSON.parse(dataLinkMatch) } catch { return [] }

  const prefix = '0'.repeat(difficulty)
  let aesKey = null

  for (let n = 0; n < 10000000; n++) {
    const powData = challenge + n
    const powHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(powData)))
    ).map(b => b.toString(16).padStart(2, '0')).join('')

    if (powHash.startsWith(prefix)) {
      aesKey = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(challenge + n + salt))
      )
      break
    }
    if (n % 1000 === 0) await new Promise(r => setTimeout(r, 0))
  }

  if (!aesKey) return []

  async function decryptAES(encryptedBase64) {
    try {
      const raw = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0))
      const iv = raw.slice(0, 16)
      const ciphertext = raw.slice(16)
      const key = await crypto.subtle.importKey('raw', aesKey.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt'])
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext)
      return new TextDecoder().decode(decrypted)
    } catch { return '' }
  }

  const resolved = []
  for (const file of dataLink) {
    if (!file.sortedEmbeds) continue
    for (const embed of file.sortedEmbeds) {
      if (embed.link && typeof embed.link === 'string') {
        const decrypted = await decryptAES(embed.link)
        if (decrypted) {
          resolved.push({ server: embed.servername, url: decrypted, lang: file.video_language })
        }
      }
    }
  }
  console.log('[embed69] Resolved', resolved.length, 'servers from', url)
  return resolved
}

// --- GENERIC FALLBACK ---
async function genericResolve(url) {
  const html = await fetchPage(url)
  const sources = scrapeSources(html)
  if (sources.length) return pickSource(sources)
  // Try video/source tags
  const videoSrc = re1(html, /<video[^>]+src=["']([^"']+)/) || re1(html, /<source[^>]+src=["']([^"']+)/)
  if (videoSrc) return absUrl(videoSrc, url)
  // Try m3u8/mp4 anywhere
  const directUrl = re1(html, /(https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*)/i)
  if (directUrl) return directUrl
  return ''
}

// ===================== PUBLIC API =====================

// Find resolver for a URL
function findResolver(url) {
  if (!url) return null
  let host
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  const labels = host.split('.')
  for (const r of resolvers) {
    if (r.domains.some(d => d.includes('.')
      ? host === d || host.endsWith(`.${d}`)
      : labels.some(label => label === d || label.startsWith(d)))) return r
  }
  return null
}

// Resolve an embed URL to a direct playable URL.
// Returns the direct URL string, or '' if resolution failed.
// Recursively resolves if the result is still an embed URL (up to 3 levels).
export async function resolveEmbed(url, depth = 0) {
  if (!url) return ''
  // Already direct
  if (/\.(?:m3u8|mp4|mkv)(\?|$)/i.test(url)) return url
  if (/magnet:/.test(url)) return url
  if (/videoplayback/.test(url)) return url
  // Prevent infinite recursion
  if (depth >= 3) return ''

  const resolver = findResolver(url)
  if (resolver) {
    try {
      // 30s timeout per resolver — the VOE ALTCHA gate legitimately needs
      // ~25s when the host has to be fetched through slow proxy fallbacks.
      const result = await Promise.race([
        resolver.resolve(url),
        new Promise(resolve => setTimeout(() => resolve(''), 30000)),
      ])
      if (result === DEAD_LINK) return DEAD_LINK
      if (result) {
        // If the result is still an embed URL, resolve recursively
        if (findResolver(result) && !/\.(?:m3u8|mp4|mkv)(\?|$)/i.test(result) && !/magnet:/.test(result)) {
          return await resolveEmbed(result, depth + 1)
        }
        return result
      }
    } catch (e) {
      console.warn(`[Resolver] ${resolver.name} failed:`, e?.message || e)
    }
  }

  // Generic fallback
  try {
    const result = await genericResolve(url)
    if (result) {
      if (findResolver(result) && !/\.(?:m3u8|mp4|mkv)(\?|$)/i.test(result) && !/magnet:/.test(result)) {
        return await resolveEmbed(result, depth + 1)
      }
      return result
    }
  } catch (e) {
    console.warn('[Resolver] Generic fallback failed:', e?.message || e)
  }

  return ''
}

// resolveEmbed + metadatos de la página del embed: { url, meta:{title,lang,quality} }
// La página final de la cadena (tras redirects/gates) es la más fiable.
export async function resolveEmbedWithMeta(url) {
  const start = recentPageMetas.length
  const direct = await resolveEmbed(url)
  const metas = recentPageMetas.slice(start)
  const meta = {}
  // Recorrer de la última página a la primera: la última es la página real
  // del player (los primeros hops suelen ser redirectores o gates).
  for (let i = metas.length - 1; i >= 0; i--) {
    const m = metas[i].meta
    if (!meta.title && m.title) meta.title = m.title
    if (!meta.lang && m.lang) meta.lang = m.lang
    if (!meta.quality && m.quality) meta.quality = m.quality
  }
  return { url: direct, meta }
}

// Lee la playlist m3u8 para sacar la calidad real (RESOLUTION máxima del
// master) en vez de adivinar por la URL. Timeout corto: es solo una etiqueta.
export async function probeM3u8Quality(m3u8Url, referer) {
  try {
    const body = await Promise.race([
      fetchPage(m3u8Url, referer),
      new Promise(r => setTimeout(() => r(''), 6000)),
    ])
    if (!body || !body.includes('#EXTM3U')) return ''
    let maxH = 0
    for (const m of body.matchAll(/RESOLUTION=\d+x(\d+)/g)) {
      const h = +m[1]
      if (h > maxH) maxH = h
    }
    if (!maxH) {
      // Playlist sin RESOLUTION: contar variantes → master multi-calidad
      const variants = body.match(/#EXT-X-STREAM-INF/g)
      if (variants && variants.length > 1) return 'HD'
      return ''
    }
    if (maxH >= 2000) return '4K'
    if (maxH >= 1000) return '1080P'
    if (maxH >= 700) return '720P'
    if (maxH >= 450) return '480P'
    return 'SD'
  } catch {
    return ''
  }
}

// Check if a URL is resolvable (has a known resolver or looks like embed)
export function isResolvable(url) {
  if (!url) return false
  if (/\.(?:m3u8|mp4|mkv)(\?|$)/i.test(url)) return true
  if (/magnet:/.test(url)) return true
  return findResolver(url) !== null
}

// List all resolver names (for debugging)
export function listResolvers() {
  return resolvers.map(r => r.name)
}
