// Equivalente Electron del kit de embeds del plugin Android:
//  - resolve(): BrowserWindow OCULTA carga la página del embed, ejecuta el
//    challenge JS (WAF/anti-bot), auto-reproduce y captura la URL de vídeo
//    que la propia página pide por red — como el headless resolver Android.
//  - relay(): ventana oculta mantiene el documento del embed vivo y el proxy
//    local sirve /embed-relay haciendo ses.fetch() con la SESIÓN del embed
//    (TLS Chromium + cookies propias de la página) — los CDNs ligados al
//    origen del documento (DLive/tiestep) solo sirven así; es el playRelay.
//  - play(): ventana VISIBLE — resolución interactiva (playback:false) o
//    reproducción dentro de la propia ventana (playback:true, el último
//    fallback del WebView visible de Android).

const { BrowserWindow, session } = require('electron')
const { Readable } = require('stream')

const PARTITION = 'persist:octo-embed'
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
const MAX_WAIT_MS = 2 * 60 * 60 * 1000 // tope absoluto para waitUntil (pre-partido)

// Estado inyectado por main.cjs (evita dependencias circulares).
let getProxyBase = null // () => 'http://127.0.0.1:PORT'
let getProxyToken = null
let getRouting = null  // () => ({proxyRules, proxyBypassRules} | null)
let sendState = null   // (payload) => webContents.send('embed:state', payload)

let embedSession = null
let requestSeq = 0
// webContentsId → { onMedia, sendHeaders }
const watchers = new Map()
// Últimos requestHeaders vistos por URL (para replicarlos en el relay).
const sentHeaders = new Map()
// id → { win, ses, url, referer, headers, mode, createdAt }
const relaySessions = new Map()
let relaySeq = 0
// Ventanas vivas de resolve/play — closeAll() las destruye al parar playback.
const liveWindows = new Set()

// ─── Session compartida de embeds ────────────────────────────────────────────
// Una sola partición persistente: las cookies/clearance anti-bot que gana un
// resolve sirven al siguiente (y al relay), igual que el cookie jar del
// WebView Android.

function embedSes() {
  if (embedSession) return embedSession
  embedSession = session.fromPartition(PARTITION)
  embedSession.setUserAgent(CHROME_UA)
  // Un solo listener por evento (límite de webRequest): fan-out a los
  // watchers registrados por webContentsId.
  embedSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (details.webContentsId && watchers.has(details.webContentsId)) {
      sentHeaders.set(details.url, { ...details.requestHeaders })
      if (sentHeaders.size > 500) {
        const first = sentHeaders.keys().next().value
        sentHeaders.delete(first)
      }
    }
    cb({ cancel: false, requestHeaders: details.requestHeaders })
  })
  embedSession.webRequest.onBeforeRequest((details, cb) => {
    const w = details.webContentsId && watchers.get(details.webContentsId)
    if (w && isMediaUrl(details.url, details.resourceType)) {
      w.onMedia(details.url)
    }
    cb({ cancel: false })
  })
  return embedSession
}

function applySessionRouting() {
  const ses = embedSession
  if (!ses || !getRouting) return
  const r = getRouting()
  ses.setProxy(r ? { proxyRules: r.proxyRules, proxyBypassRules: r.proxyBypassRules } : { mode: 'direct' })
    .catch(() => {})
}

// URL de vídeo "real": manifest HLS/DASH o archivo progresivo que la página
// pide por <video>/XHR — excluye publicidad rastreando por tipo de recurso.
function isMediaUrl(url, resourceType) {
  if (!/^https?:\/\//i.test(url)) return false
  if (/\.m3u8|\.mpd([?/#]|$)/i.test(url)) return true
  if (resourceType === 'media' && /\.(mp4|webm|mkv|mov)([?/#]|$)/i.test(url)) return true
  if ((resourceType === 'xhr' || resourceType === 'fetch') && /\.m3u8|\.mpd/i.test(url)) return true
  return false
}

function streamTypeFor(url) {
  if (/\.m3u8([?/#]|$)/i.test(url)) return 'hls'
  if (/\.mpd([?/#]|$)/i.test(url)) return 'dash'
  return 'file'
}

// Auto-play en el documento del embed: click en overlays de play + play() de
// los <video> (muteado para saltar la política de autoplay de Chromium).
const AUTOPLAY_JS = `(() => {
  try {
    for (const v of document.querySelectorAll('video')) {
      try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}) } catch {}
    }
    const sel = '.vjs-big-play-button,.jw-icon-play,.play-button,#play,.play,[class*="play-btn"],[id*="play"]';
    for (const el of document.querySelectorAll(sel)) {
      try { el.click() } catch {}
    }
  } catch {}
  return true
})()`

function makeWindow({ visible, title }) {
  embedSes()
  applySessionRouting()
  const win = new BrowserWindow({
    show: visible === true,
    width: visible ? 1120 : 1280,
    height: visible ? 630 : 720,
    title: title || 'OctoStream',
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false, // el relay/resolver debe seguir vivo oculto
    },
  })
  // Los embeds intentan abrir popups de publicidad — se bloquean todos.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

async function cookiesFor(urls) {
  try {
    const seen = new Map()
    for (const u of urls) {
      const list = await embedSes().cookies.get({ url: u }).catch(() => [])
      for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c.value)
    }
    return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  } catch {
    return ''
  }
}

// watchId: registra el callback de detección de media para una webContentsId.
function watchWindow(win, onMedia) {
  watchers.set(win.webContents.id, { onMedia })
}

function unwatchWindow(win) {
  try { watchers.delete(win.webContents.id) } catch {}
}

// ─── API ─────────────────────────────────────────────────────────────────────

function init(opts) {
  getProxyBase = opts.getProxyBase
  getProxyToken = opts.getProxyToken
  getRouting = opts.getRouting
  sendState = opts.sendState
}

// Resolución headless: devuelve {status:'resolved', url, referer,
// requestHeaders, cookies, streamType} | {status:'timeout'|'failed'}.
async function resolve({ url, referer = '', timeout = 20000, waitUntil = 0 } = {}) {
  if (!/^https?:\/\//i.test(url || '')) return { status: 'failed', message: 'invalid url' }
  const deadline = Math.min(
    Math.max(timeout || 20000, waitUntil > Date.now() ? waitUntil - Date.now() : 0),
    MAX_WAIT_MS)
  const win = makeWindow({ visible: false })
  liveWindows.add(win)
  const id = ++requestSeq
  try {
    return await new Promise((resolvePromise) => {
      let done = false
      let autoplayTimer = null
      const finish = (result) => {
        if (done) return
        done = true
        clearInterval(autoplayTimer)
        clearTimeout(timer)
        unwatchWindow(win)
        try { win.destroy() } catch {}
        resolvePromise(result)
      }
      const timer = setTimeout(() => finish({ status: 'timeout' }), deadline)
      const onMedia = async (mediaUrl) => {
        const headers = sentHeaders.get(mediaUrl) || {}
        const cookies = await cookiesFor([mediaUrl, url])
        finish({
          status: 'resolved',
          url: mediaUrl,
          referer: url,
          requestHeaders: headers,
          cookies,
          streamType: streamTypeFor(mediaUrl),
        })
      }
      watchWindow(win, (u) => { onMedia(u).catch(() => finish({ status: 'resolved', url: u, referer: url })) })
      win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(AUTOPLAY_JS).catch(() => {})
      })
      win.on('closed', () => finish({ status: 'closed' }))
      // Autoplay periódico: el botón puede aparecer tras anuncios/cuenta atrás.
      autoplayTimer = setInterval(() => {
        if (!win.isDestroyed()) win.webContents.executeJavaScript(AUTOPLAY_JS).catch(() => {})
      }, 2500)
      console.log('[Embed] resolve #' + id + ':', (() => { try { return new URL(url).host } catch { return '?' } })())
      win.loadURL(url, referer ? { httpReferrer: referer } : {}).catch((e) => {
        finish({ status: 'failed', message: String(e?.message || e) })
      })
    })
  } finally {
    unwatchWindow(win)
    liveWindows.delete(win)
    if (!win.isDestroyed()) try { win.destroy() } catch {}
  }
}

// Reproducción dentro de una ventana propia o resolución interactiva:
//   playback:true  → la ventana ES el reproductor (último fallback);
//                    resuelve {status:'closed'} al cerrarla el usuario.
//   playback:false → el usuario puede resolver captchas/clicks; al detectar
//                    el vídeo se cierra y devuelve {status:'resolved', url,...}.
async function play({ url, title = '', referer = '', playback = false, timeout = 0, waitUntil = 0 } = {}) {
  if (!/^https?:\/\//i.test(url || '')) return { status: 'failed', message: 'invalid url' }
  const win = makeWindow({ visible: true, title })
  liveWindows.add(win)
  applySessionRouting()
  const deadline = Math.min(
    Math.max(timeout || 0, waitUntil > Date.now() ? waitUntil - Date.now() : 0),
    MAX_WAIT_MS)
  try {
    return await new Promise((resolvePromise) => {
      let done = false
      let autoplayTimer = null
      let timer = null
      const finish = (result) => {
        if (done) return
        done = true
        clearInterval(autoplayTimer)
        if (timer) clearTimeout(timer)
        unwatchWindow(win)
        if (!win.isDestroyed()) try { win.destroy() } catch {}
        resolvePromise(result)
      }
      if (deadline > 0) timer = setTimeout(() => finish({ status: 'timeout' }), deadline)
      watchWindow(win, async (mediaUrl) => {
        if (playback) {
          // Modo player: quedarse abierto; avisar al renderer de que ya suena.
          try { sendState?.({ state: 'embed_webview_playing', url: mediaUrl }) } catch {}
          return
        }
        const headers = sentHeaders.get(mediaUrl) || {}
        const cookies = await cookiesFor([mediaUrl, url])
        finish({ status: 'resolved', url: mediaUrl, referer: url, requestHeaders: headers, cookies, streamType: streamTypeFor(mediaUrl) })
      })
      win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(AUTOPLAY_JS).catch(() => {})
        if (playback) {
          // Aviso optimista: la ventana cargó y se considera "reproduciendo".
          try { sendState?.({ state: 'embed_webview_playing', url: '' }) } catch {}
        }
      })
      autoplayTimer = setInterval(() => {
        if (!win.isDestroyed()) win.webContents.executeJavaScript(AUTOPLAY_JS).catch(() => {})
      }, 3000)
      win.on('closed', () => finish({ status: 'closed' }))
      win.loadURL(url, referer ? { httpReferrer: referer } : {}).catch((e) => {
        finish({ status: 'failed', message: String(e?.message || e) })
      })
    })
  } finally {
    unwatchWindow(win)
    liveWindows.delete(win)
    if (!win.isDestroyed()) try { win.destroy() } catch {}
  }
}

// Relay de origen: ventana oculta en el documento del embed; /embed-relay
// sirve las peticiones con la sesión del embed (cookies + TLS Chromium +
// mismos headers que usó la página). Devuelve la URL loopback a reproducir.
async function relay({ url, referer = '', mode = 'live', waitUntil = 0 } = {}) {
  const target = /^https?:\/\//i.test(url || '') ? url : ''
  const doc = /^https?:\/\//i.test(referer || '') ? referer : target
  if (!target || !doc) return { status: 'failed', message: 'invalid url' }
  const ses = embedSes()
  const win = makeWindow({ visible: false })
  const id = `r${++relaySeq}`
  const entry = { win, ses, url: target, referer: doc, headers: null, mode, createdAt: Date.now(), ttlMs: 0 }
  if (waitUntil > Date.now()) entry.ttlMs = Math.min(waitUntil - Date.now() + 5 * 60 * 1000, MAX_WAIT_MS)
  // Los headers exactos que la página usa para el propio medio (Referer,
  // Origin, UA) son los que replicamos en cada fetch del relay.
  watchWindow(win, (mediaUrl) => {
    const h = sentHeaders.get(mediaUrl)
    if (h && !entry.headers) entry.headers = pickRelayHeaders(h)
  })
  relaySessions.set(id, entry)
  const cleanup = () => stopRelay(id)
  win.on('closed', cleanup)
  try {
    await Promise.race([
      win.loadURL(doc),
      new Promise((r) => setTimeout(r, 10000)),
    ])
  } catch { /* doc colgado/WAF: la sesión ya tiene cookies parciales */ }
  // TTL por defecto: los directos deportivos no duran más de 3 h; los VOD,
  // 45 min desde la última petición servida (se renueva en cada fetch).
  entry.ttlMs = entry.ttlMs || (mode === 'live' ? 3 * 60 * 60 * 1000 : 45 * 60 * 1000)
  entry.expiresAt = Date.now() + entry.ttlMs
  const base = getProxyBase()
  const token = getProxyToken()
  const relayUrl = `${base}/embed-relay?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&u=${encodeURIComponent(target)}`
  console.log('[Embed] relay', id, '→', (() => { try { return new URL(target).host } catch { return '?' } })())
  return { status: 'playing', id, url: relayUrl }
}

// Headers que el CDN del medio exige: se copian de la petición real que hizo
// la página, restringidos a los seguros de replay.
function pickRelayHeaders(requestHeaders) {
  const out = {}
  for (const [k, v] of Object.entries(requestHeaders || {})) {
    if (/^(referer|origin|user-agent|accept|accept-language|sec-[a-z-]+|range)$/i.test(k) && typeof v === 'string') {
      out[k] = v
    }
  }
  return out
}

function stopRelay(id) {
  const entry = relaySessions.get(id)
  if (!entry) return { stopped: false }
  relaySessions.delete(id)
  unwatchWindow(entry.win)
  try { if (!entry.win.isDestroyed()) entry.win.destroy() } catch {}
  console.log('[Embed] relay', id, 'stopped')
  return { stopped: true }
}

function closeAll() {
  for (const id of [...relaySessions.keys()]) stopRelay(id)
  for (const win of liveWindows) {
    unwatchWindow(win)
    try { if (!win.isDestroyed()) win.destroy() } catch {}
  }
  liveWindows.clear()
  return { closed: true }
}

// Sirve GET /embed-relay?id=&u= — fetch con la sesión del embed y reescritura
// de playlists para que segmentos/subplaylists/claves sigan por el relay.
async function handleRelayRequest(parsed, res) {
  const id = parsed.searchParams.get('id')
  const u = parsed.searchParams.get('u')
  const entry = id && relaySessions.get(id)
  const target = u && /^https?:\/\//i.test(u) ? u : null
  if (!entry || !target || entry.win.isDestroyed()) {
    res.writeHead(entry ? 410 : 404)
    res.end(entry ? 'Relay closed' : 'Unknown relay')
    return
  }
  entry.expiresAt = Date.now() + entry.ttlMs // renueva el TTL por actividad
  const headers = { ...(entry.headers || {}) }
  if (!headers['Referer'] && !headers['referer']) {
    try {
      const ref = new URL(entry.referer)
      headers['Referer'] = entry.referer
      headers['Origin'] = ref.origin
    } catch {}
  }
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = CHROME_UA
  let resp
  try {
    resp = await entry.ses.fetch(target, { headers, credentials: 'include' })
  } catch (e) {
    res.writeHead(502)
    res.end('Relay fetch failed: ' + String(e?.message || e))
    return
  }
  const ct = String(resp.headers.get('content-type') || '')
  const isPlaylist = /mpegurl|vnd\.apple|dash\+xml/i.test(ct) || /\.m3u8|\.mpd([?/#]|$)/i.test(target)
  if (isPlaylist) {
    let text = ''
    try {
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_PLAYLIST_BYTES) {
        res.writeHead(413)
        res.end('Playlist too large')
        return
      }
      text = buf.toString('utf8')
    } catch (e) {
      res.writeHead(502)
      res.end('Playlist read failed')
      return
    }
    const base = getProxyBase()
    const token = getProxyToken()
    const wrap = (uri) => {
      try {
        const abs = new URL(uri, target).href
        return `${base}/embed-relay?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&u=${encodeURIComponent(abs)}`
      } catch { return uri }
    }
    const rewritten = text.split('\n').map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) {
        // URI="..." en #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA.
        return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${wrap(uri)}"`)
      }
      return wrap(t)
    }).join('\n')
    res.writeHead(resp.status, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(rewritten)
    return
  }
  const outHeaders = {
    'Content-Type': ct || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  }
  const cl = resp.headers.get('content-length')
  if (cl) outHeaders['Content-Length'] = cl
  const cr = resp.headers.get('content-range')
  if (cr) outHeaders['Content-Range'] = cr
  res.writeHead(resp.status, outHeaders)
  if (!resp.body) { res.end(); return }
  Readable.fromWeb(resp.body).pipe(res)
}

// GC periódico de relays expirados (TTL renovado por actividad).
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of relaySessions) {
    if (entry.expiresAt && now > entry.expiresAt) stopRelay(id)
  }
}, 60 * 1000).unref?.()

module.exports = { init, resolve, play, relay, stopRelay, closeAll, handleRelayRequest, applySessionRouting }
