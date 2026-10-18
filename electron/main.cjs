// Silence Fontconfig warnings (harmless on some Linux distros)
process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || '/etc/fonts'

const { app, BrowserWindow, shell, session, ipcMain, components } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const { spawn, execSync } = require('child_process')
const crypto = require('crypto')
const { URL } = require('url')
const { SyncServer } = require('./sync-server.cjs')
const Youtube = require('./youtube.cjs')
const Embed = require('./embed.cjs')
const Dlna = require('./dlna.cjs')
const Mpv = require('./mpv.cjs')
// El motor torrent llega bundleado (electron/torrent.bundle.mjs, generado
// por scripts/bundle-torrent.mjs) porque el asar no incluye node_modules;
// en dev sin bundle se usa el fuente (torrent.cjs + webtorrent de npm).
const torrentBundlePath = path.join(__dirname, 'torrent.bundle.mjs')
const torrentModulePath = fs.existsSync(torrentBundlePath) ? torrentBundlePath : null

// ─── Aether / WARP local proxy ──────────────────────────────────────────────
// El mismo cliente WARP userspace que en Android (CluvexStudio/Aether):
// SOCKS5 en 127.0.0.1:1819 y HTTP CONNECT en 127.0.0.1:1820. El binario se
// empaqueta en resources/aether (scripts/fetch-aether.mjs) y se lanza con
// las mismas variables de entorno que el plugin CloudProxy de Android.
// Cuando está conectado: (1) el renderer va por session proxy SOCKS5 y
// (2) el proxy local de Node rutea por el túnel — paridad total con Android.
const net = require('net')
const tls = require('tls')
const AETHER_SOCKS_HOST = '127.0.0.1'
const AETHER_SOCKS_PORT = 1819
const AETHER_HTTP_PORT = 1820

// Hosts que nunca van por el túnel — espejo de nonProxyHosts/bypass del
// plugin Android (TDT/RTVE/Mediaset/Google DAI dan errores bajo WARP, y la
// LAN debe ir directa para la sincronización OctoStream).
const AETHER_BYPASS_SUFFIX = /(^|\.)(tdtspain\.com|tdtchannels\.com|rtve\.es|mediaset\.net|mediasetinfinity\.es|atresplayer\.com|atresmedia\.com|doubleclick\.net|googlevideo\.com)$/i
const AETHER_BYPASS_CHROMIUM = [
  '<local>', 'localhost', '127.0.0.1', '*.local',
  '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '169.254.0.0/16',
  '*.tdtspain.com', '*.tdtchannels.com', '*.rtve.es', '*.mediaset.net',
  '*.mediasetinfinity.es', '*.atresplayer.com', '*.atresmedia.com',
  'dai.google.com', '*.doubleclick.net',
  '*.googlevideo.com',
].join(';')
function isAetherBypassHost(host) {
  return AETHER_BYPASS_SUFFIX.test(host || '') || /^dai\.google\.com$/i.test(host || '')
}

// Loopback y LAN privada — las fetches Node a hosts locales (remux del
// servidor torrent, otro OctoStream en la LAN) por el túnel harían CONNECT
// a una IP privada que el extremo remoto no puede alcanzar → fallo total.
// Misma lista que el bypass de Chromium/Android.
const LAN_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i
function isLanHost(host) { return LAN_HOST.test(host || '') }

const aetherState = { proc: null, connected: false, connecting: false, error: '' }
let mainWindow = null

function probePort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(400)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.connect(port, AETHER_SOCKS_HOST)
  })
}
function probeAether() { return probePort(AETHER_SOCKS_PORT) }
async function isAetherProxyUp() {
  return (await probePort(AETHER_SOCKS_PORT)) && (await probePort(AETHER_HTTP_PORT))
}

function resolveAether() {
  if (process.env.OCTOSTREAM_AETHER && fs.existsSync(process.env.OCTOSTREAM_AETHER)) {
    return process.env.OCTOSTREAM_AETHER
  }
  const exe = process.platform === 'win32' ? 'aether.exe' : 'aether'
  try {
    const bundled = path.join(process.resourcesPath || '', 'aether',
      `${process.platform}-${process.arch}`, exe)
    if (app.isPackaged && fs.existsSync(bundled)) return bundled
  } catch {}
  try {
    const devPath = path.resolve(__dirname, '..', 'build', 'aether',
      `${process.platform}-${process.arch}`, exe)
    if (fs.existsSync(devPath)) return devPath
  } catch {}
  // PATH del sistema (aether instalado aparte).
  return null // sin binario → no se lanza nada; un aether externo en :1819 sí se usa
}

// Rutea el renderer por el túnel (session proxy) y marca el estado para
// que el proxy local de Node use el agente SOCKS5 en sus fetches.
async function applyAetherRouting() {
  await session.defaultSession.setProxy({
    proxyRules: `socks5://${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`,
    proxyBypassRules: AETHER_BYPASS_CHROMIUM,
  })
  aetherState.connected = true
  Embed.applySessionRouting()
  console.log('[Aether] routing via WARP — renderer SOCKS5 + proxy local')
}

async function clearAetherRouting() {
  aetherState.connected = false
  try { await session.defaultSession.setProxy({ mode: 'direct' }) } catch {}
  Embed.applySessionRouting()
}

async function configureAetherProxy() {
  // Arranque: si un aether ya corre (externo o lanzado antes), adoptar el
  // túnel existente — el plugin Android también reutiliza el proceso vivo.
  if (!(await isAetherProxyUp())) {
    console.log('[Aether] No SOCKS5 proxy on 127.0.0.1:1819 — direct traffic')
    return false
  }
  try {
    await applyAetherRouting()
    return true
  } catch (e) {
    console.error('[Aether] Failed to set proxy:', e.message)
    return false
  }
}

async function aetherConnect() {
  if (aetherState.connected && await isAetherProxyUp()) {
    return { status: 'connected', socks: `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`, http: `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}` }
  }
  if (aetherState.connecting) {
    // Otro connect en curso (auto-connect de App.jsx + request bloqueada):
    // esperar al resultado en vez de fallar con "already in progress".
    const deadline = Date.now() + 70000
    while (aetherState.connecting && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
    }
    if (aetherState.connected) {
      return { status: 'connected', socks: `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`, http: `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}` }
    }
    throw new Error('WARP connection failed')
  }
  aetherState.connecting = true
  aetherState.error = ''
  try {
    // Un aether externo ya corriendo en :1819 se adopta sin lanzar otro.
    if (await isAetherProxyUp()) {
      await applyAetherRouting()
      return { status: 'connected', socks: `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`, http: `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}` }
    }
    const exe = resolveAether()
    if (!exe) throw new Error('binario aether no encontrado (build/aether o resources)')
    // Matar un proceso viejo primero — aether puede quedar vivo con el
    // túnel caído reintentando y dos instancias compiten por :1819/:1820.
    if (aetherState.proc) { try { aetherState.proc.kill('SIGKILL') } catch {} aetherState.proc = null }
    const workDir = app.getPath('userData')
    const env = {
      ...process.env,
      AETHER_PROTOCOL: 'masque',
      AETHER_SCAN: 'ironclad',
      AETHER_IP: 'v4',
      AETHER_NOIZE: 'aggressive',
      AETHER_LOG_LEVEL: 'warn',
      AETHER_SOCKS: `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`,
      AETHER_HTTP_PROXY: `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}`,
      AETHER_CONFIG: path.join(workDir, 'aether.toml'),
      AETHER_QUICK_RECONNECT: '1',
      AETHER_PEER: '162.159.198.1:443',
      AETHER_QUIC_V2: '1',
      AETHER_ROUTE_SNIFF: '1',
      TMPDIR: os.tmpdir(),
    }
    const proc = spawn(exe, [], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    aetherState.proc = proc
    proc.on('exit', (code) => {
      console.warn('[Aether] proceso salió code=', code)
      if (aetherState.proc === proc) {
        aetherState.proc = null
        aetherState.connected = false
        // El session proxy queda apuntando al puerto muerto → fail-closed,
        // las requests fallan en vez de filtrar la IP real (como Android).
      }
    })
    let stderrTail = ''
    const onLog = (c) => {
      const s = c.toString()
      stderrTail = (stderrTail + s).slice(-4096)
      for (const line of s.split('\n')) {
        if (/error|warn|listening|expos/i.test(line)) console.log('[Aether]', line.trim())
      }
    }
    proc.stdout.on('data', onLog)
    proc.stderr.on('data', onLog)

    // Esperar a que suban ambos proxies (máx. 60s, igual que Android) con
    // salida anticipada si el proceso muere.
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break
      if (await isAetherProxyUp()) {
        await applyAetherRouting()
        return { status: 'connected', socks: `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`, http: `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}` }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`aether no respondió en 60s${stderrTail ? ': ' + stderrTail.slice(-200) : ''}`)
  } catch (e) {
    aetherState.error = e.message
    if (aetherState.proc) { try { aetherState.proc.kill('SIGKILL') } catch {} aetherState.proc = null }
    await clearAetherRouting()
    throw e
  } finally {
    aetherState.connecting = false
  }
}

async function aetherDisconnect(keepProxy) {
  aetherState.connecting = false
  const proc = aetherState.proc
  aetherState.proc = null
  if (proc) {
    try { proc.kill('SIGKILL') } catch {}
  }
  // Frontera de generación: vaciar los pools keep-alive para que ningún
  // socket del túnel viejo sobreviva ni se reutilice tras un reconnect.
  try { warpHttpAgent.destroy() } catch {}
  try { warpHttpsAgent.destroy() } catch {}
  if (keepProxy) {
    // Desconexión en background: el proxy queda apuntando al puerto muerto →
    // las requests fallan en vez de filtrar la IP real durante el repose.
    aetherState.connected = false
  } else {
    await clearAetherRouting()
  }
  return { status: 'disconnected' }
}

// ─── Agente SOCKS5 para las fetches Node del proxy local ────────────────────
// Node no soporta SOCKS de serie: handshake CONNECT mínimo (RFC 1928,
// sin auth) y TLS por encima para https. Así las requests del proxy local
// van por WARP igual que el renderer — paridad con OkHttp/ExoPlayer.
function socksHandshake(host, port, cb) {
  const sock = net.connect(AETHER_SOCKS_PORT, AETHER_SOCKS_HOST)
  let done = false
  const fail = (e) => {
    if (done) return
    done = true
    try { sock.destroy() } catch {}
    cb(e)
  }
  const succeed = () => {
    if (done) return
    done = true
    sock.setTimeout(0) // desarmar el timer del handshake — ahora es del agente
    sock.removeAllListeners('error')
    sock.removeAllListeners('timeout')
    sock.removeAllListeners('data')
    cb(null, sock)
  }
  sock.setTimeout(15000, () => fail(new Error('socks5 timeout')))
  sock.once('error', fail)
  sock.once('connect', () => {
    // Saludo: ver 5, 1 método, sin auth.
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    sock.once('data', (greet) => {
      if (greet.length < 2 || greet[0] !== 0x05 || greet[1] !== 0x00) {
        return fail(new Error('socks5 greeting rejected'))
      }
      // CONNECT host:port (domain form — el DNS lo resuelve el túnel).
      const hostBuf = Buffer.from(host, 'ascii')
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([port >> 8, port & 0xff]),
      ]))
      let buf = Buffer.alloc(0)
      const onReply = (d) => {
        buf = Buffer.concat([buf, d])
        if (buf.length < 4) return
        if (buf[0] !== 0x05) return fail(new Error('socks5: bad reply version'))
        if (buf[1] !== 0x00) return fail(new Error('socks5 connect failed: ' + buf[1]))
        // Esperar a que llegue el reply completo según atyp.
        const need = buf[3] === 0x01 ? 10 : buf[3] === 0x03 ? 5 + buf[4] + 2 : buf[3] === 0x04 ? 22 : 10
        if (buf.length < need) return
        succeed()
      }
      sock.on('data', onReply)
    })
  })
}

const warpHttpAgent = new http.Agent({ keepAlive: true })
warpHttpAgent.createConnection = (opts, cb) => socksHandshake(opts.host, +opts.port, cb)
const warpHttpsAgent = new https.Agent({ keepAlive: true })
warpHttpsAgent.createConnection = (opts, cb) => {
  socksHandshake(opts.host, +opts.port, (err, sock) => {
    if (err) return cb(err)
    cb(null, tls.connect({
      socket: sock,
      servername: opts.servername || opts.host,
      ALPNProtocols: opts.ALPNProtocols,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    }))
  })
}

// Agente para fetches Node: WARP cuando está conectado salvo hosts bypass.
function agentFor(target, isHttps) {
  if (!aetherState.connected || isLanHost(target.hostname) || isAetherBypassHost(target.hostname)) {
    return isHttps ? secureHttpsAgent : undefined
  }
  return isHttps ? warpHttpsAgent : warpHttpAgent
}

// Get local network IP (for Chromecast access to proxy)
function getLocalIP() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

const secureHttpsAgent = new https.Agent({ keepAlive: true })

// ─── YouTube (yt-dlp) ──────────────────────────────────────────────────────
// Equivalente desktop de NewPipeExtractor (Android). El binario se empaqueta
// en resources/ytdlp (scripts/fetch-ytdlp.mjs).
function resolveYtdlp() {
  if (process.env.OCTOSTREAM_YTDLP && fs.existsSync(process.env.OCTOSTREAM_YTDLP)) {
    return process.env.OCTOSTREAM_YTDLP
  }
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  try {
    const bundled = path.join(process.resourcesPath || '', 'ytdlp',
      `${process.platform}-${process.arch}`, exe)
    if (app.isPackaged && fs.existsSync(bundled)) return bundled
  } catch { /* sin resourcesPath en dev */ }
  try {
    const devPath = path.resolve(__dirname, '..', 'build', 'ytdlp',
      `${process.platform}-${process.arch}`, exe)
    if (fs.existsSync(devPath)) return devPath
  } catch { /* sin build/ytdlp */ }
  return exe // PATH
}

Youtube.init({
  resolver: resolveYtdlp,
  agentFor: (url) => {
    try {
      const u = new URL(url)
      return agentFor(u, u.protocol === 'https:')
    } catch { return undefined }
  },
  getWarpProxyUrl: () => aetherState.connected
    ? `socks5h://${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}` : null,
})

// ─── Local stream proxy ────────────────────────────────────────────────────
// Solves CORS + SSL issues: fetches streams server-side (Node) and serves
// them to the renderer via http://127.0.0.1:PROXY_PORT/proxy?url=...
// The proxy injects provider-specific headers while retaining normal TLS
// certificate validation.

const PROXY_PORT = 19588
const LOCAL_IP = getLocalIP()
const PROXY_TOKEN = process.env.OCTOSTREAM_PROXY_TOKEN || crypto.randomBytes(32).toString('hex')
// Proxy prefix for renderer (localhost) and for Chromecast (LAN IP)
const PROXY_PREFIX_LOCAL = `http://127.0.0.1:${PROXY_PORT}/proxy?token=${PROXY_TOKEN}&url=`
// Playlists (m3u8/mpd) se acumulan enteros para reescribir URLs — tope anti-DoS.
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
const PROXY_PREFIX_LAN = `http://${LOCAL_IP}:${PROXY_PORT}/proxy?token=${PROXY_TOKEN}&url=`
let proxyServer = null

function validProxyTarget(rawUrl) {
  try {
    const target = new URL(rawUrl)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0' || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^fc|^fd|^fe80:/i.test(host)) return null
    return target
  } catch {
    return null
  }
}

// Log only host:port — stream URLs carry signed tokens/cookies.
function hostOf(url) {
  try { const u = new URL(url); return u.host } catch { return 'unknown' }
}

function headersForHost(host) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': '*/*',
  }
  if (/rtve/i.test(host)) {
    headers['Origin'] = 'https://www.rtve.es'
    headers['Referer'] = 'https://www.rtve.es/'
  } else if (/atresplayer|atresmedia|atres-live|nogeovod/i.test(host)) {
    headers['Origin'] = 'https://www.atresplayer.com'
    headers['Referer'] = 'https://www.atresplayer.com/'
  } else if (/mediaset|widevine\.entitlement\.theplatform\.eu/i.test(host)) {
    headers['Origin'] = 'https://www.mediasetinfinity.es'
    headers['Referer'] = 'https://www.mediasetinfinity.es/'
  } else if (/doubleclick\.net/i.test(host)) {
    // Google DAI streams used by Mediaset
    headers['Origin'] = 'https://www.mediasetinfinity.es'
    headers['Referer'] = 'https://www.mediasetinfinity.es/'
  } else if (/tdtchannels/i.test(host)) {
    headers['Referer'] = 'https://www.tdtchannels.com/'
  } else if (/tdtspain/i.test(host)) {
    headers['Referer'] = 'https://www.tdtspain.com/'
  }
  return headers
}

// Whitelist para el param ?headers= (JSON). Sin ella, un cliente LAN con el
// token podría inyectar Host/Content-Length arbitrarios (smuggling).
const PROXY_REQ_HEADER_ALLOW =
  /^(accept|accept-language|authorization|cache-control|cookie|origin|pragma|range|referer|user-agent|x-[a-z0-9_-]+)$/i

function sanitizeProxyHeaders(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  let count = 0
  for (const [k, v] of Object.entries(obj)) {
    if (count >= 20) break
    if (typeof v !== 'string' || v.length > 2048 || /[\r\n]/.test(v)) continue
    if (!PROXY_REQ_HEADER_ALLOW.test(k)) continue
    out[k] = v
    count++
  }
  return out
}

function proxyFetch(targetUrl, res, proxyPrefix, extraHeaders, clientHeaders) {
  const prefix = proxyPrefix || PROXY_PREFIX_LOCAL
  console.log('[Proxy] fetching:', hostOf(targetUrl))
  const target = validProxyTarget(targetUrl)
  if (!target) {
    if (!res.headersSent) { res.writeHead(400); res.end('Invalid or forbidden url') }
    return
  }

  // Headers del resolver (Referer/cookies/UA) ganan a los defaults por host.
  const headers = { ...headersForHost(target.hostname), ...sanitizeProxyHeaders(extraHeaders) }
  // Range del player (seek en mp4 debrid): antes se descartaba → el CDN
  // devolvía 200 con el archivo entero y el seek no funcionaba.
  if (clientHeaders?.range && !headers['Range']) {
    headers['Range'] = clientHeaders.range
  }
  // Sufijo que propaga esos headers a segmentos/subplaylists reescritos —
  // sin él el manifest pasaba pero los .ts seguían dando 403.
  const hdrSuffix = extraHeaders && Object.keys(extraHeaders).length
    ? '&headers=' + encodeURIComponent(JSON.stringify(sanitizeProxyHeaders(extraHeaders)))
    : ''
  const isHttps = target.protocol === 'https:'
  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
  }

  options.agent = agentFor(target, isHttps)

  const lib = isHttps ? https : http

  const proxyReq = lib.request(options, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = proxyRes.headers.location
      const absoluteRedirect = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, targetUrl).href
      console.log('[Proxy] redirect', proxyRes.statusCode, '->', hostOf(absoluteRedirect))
      res.writeHead(302, { 'Location': `${prefix}${encodeURIComponent(absoluteRedirect)}${hdrSuffix}` })
      res.end()
      return
    }

    const contentType = proxyRes.headers['content-type'] || ''
    const isM3u8 = /\.m3u8/i.test(targetUrl) || /mpegurl|vnd\.apple\.mpeg/i.test(contentType)
    const isMpd = /\.mpd/i.test(targetUrl) || /dash\+xml/i.test(contentType)
    const isGzJson = /\.gz$/i.test(targetUrl) || /gzip/i.test(contentType)
    console.log('[Proxy] response', proxyRes.statusCode, contentType, isM3u8 ? '(m3u8)' : '', isMpd ? '(mpd)' : '', isGzJson ? '(gz)' : '', hostOf(targetUrl))

    const respHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }

    if (isGzJson) {
      // Decompress gzip and return as JSON
      const chunks = []
      proxyRes.on('data', (chunk) => chunks.push(chunk))
      proxyRes.on('end', () => {
        try {
          const zlib = require('zlib')
          const buf = Buffer.concat(chunks)
          const decompressed = zlib.gunzipSync(buf)
          const body = decompressed.toString('utf8')
          respHeaders['Content-Type'] = 'application/json; charset=utf-8'
          respHeaders['Content-Length'] = Buffer.byteLength(body)
          res.writeHead(proxyRes.statusCode || 200, respHeaders)
          res.end(body)
        } catch (e) {
          console.error('[Proxy] gzip decompress error:', e.message)
          respHeaders['Content-Type'] = 'application/json; charset=utf-8'
          res.writeHead(502, respHeaders)
          res.end(JSON.stringify({ error: 'gzip decompress failed', detail: e.message }))
        }
      })
      return
    }

    respHeaders['Content-Type'] = contentType || 'application/octet-stream'
    if (proxyRes.headers['content-length']) {
      respHeaders['Content-Length'] = proxyRes.headers['content-length']
    }
    // Respuestas parciales (206) para que el seek funcione de verdad.
    for (const h of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (proxyRes.headers[h]) respHeaders[h] = proxyRes.headers[h]
    }

    if (isM3u8) {
      // Rewrite m3u8: convert relative/absolute segment URLs to proxy URLs.
      // Capado: el playlist se acumula entero en memoria — sin tope un "m3u8"
      // malicioso agotaría la RAM del proceso principal.
      let body = ''
      let bodyLen = 0
      proxyRes.on('data', (chunk) => {
        bodyLen += chunk.length
        if (bodyLen > MAX_PLAYLIST_BYTES) { proxyRes.destroy(); return }
        body += chunk.toString()
      })
      proxyRes.on('end', () => {
        if (bodyLen > MAX_PLAYLIST_BYTES) {
          res.writeHead(413, respHeaders)
          res.end('Playlist too large')
          return
        }
        const lines = body.split('\n')
        const rewritten = lines.map(line => {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) {
            // Rewrite URI= in #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA and #EXT-X-SESSION-DATA tags
            if (/^#EXT-X-(KEY|MAP|MEDIA|SESSION-DATA)/.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
              const uriMatch = trimmed.match(/URI="([^"]+)"/)
              if (uriMatch) {
                const originalUri = uriMatch[1]
                const absoluteUri = originalUri.startsWith('http') ? originalUri : new URL(originalUri, targetUrl).href
                return trimmed.replace(uriMatch[0], `URI="${prefix}${encodeURIComponent(absoluteUri)}${hdrSuffix}"`)
              }
            }
            // Also rewrite URL= in #EXT-X-I-FRAME-STREAM-INF tags
            if (/^#EXT-X-I-FRAME-STREAM-INF/.test(trimmed) && /URL="([^"]+)"/.test(trimmed)) {
              const urlMatch = trimmed.match(/URL="([^"]+)"/)
              if (urlMatch) {
                const originalUri = urlMatch[1]
                const absoluteUri = originalUri.startsWith('http') ? originalUri : new URL(originalUri, targetUrl).href
                return trimmed.replace(urlMatch[0], `URL="${prefix}${encodeURIComponent(absoluteUri)}${hdrSuffix}"`)
              }
            }
            return line
          }
          // It's a segment URL (relative or absolute)
          if (/^https?:\/\//.test(trimmed)) {
            return `${prefix}${encodeURIComponent(trimmed)}${hdrSuffix}`
          }
          // Relative URL: resolve against the m3u8 base URL
          try {
            const absolute = new URL(trimmed, targetUrl).href
            return `${prefix}${encodeURIComponent(absolute)}${hdrSuffix}`
          } catch {
            return line
          }
        })
        const rewrittenBody = rewritten.join('\n')
        // El body reescrito incrusta el token del proxy — no loguearlo en claro.
        console.log('[Proxy] m3u8 rewritten (first 500 chars):\n',
          rewrittenBody.substring(0, 500).split(PROXY_TOKEN).join('[TOKEN]'))
        delete respHeaders['Content-Length']
        respHeaders['Content-Length'] = Buffer.byteLength(rewrittenBody)
        res.writeHead(proxyRes.statusCode || 200, respHeaders)
        res.end(rewrittenBody)
      })
    } else if (isMpd) {
      // Rewrite MPD: convert <BaseURL> to proxy URL so segments resolve through proxy
      let body = ''
      let bodyLen = 0
      proxyRes.on('data', (chunk) => {
        bodyLen += chunk.length
        if (bodyLen > MAX_PLAYLIST_BYTES) { proxyRes.destroy(); return }
        body += chunk.toString()
      })
      proxyRes.on('end', () => {
        if (bodyLen > MAX_PLAYLIST_BYTES) {
          res.writeHead(413, respHeaders)
          res.end('Playlist too large')
          return
        }
        // Rewrite <BaseURL> elements - segments are relative to BaseURL
        let rewritten = body.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, url) => {
          try {
            const absolute = url.startsWith('http') ? url : new URL(url, targetUrl).href
            return `<BaseURL>${prefix}${encodeURIComponent(absolute)}${hdrSuffix}</BaseURL>`
          } catch { return match }
        })
        // Also rewrite any absolute http(s) URLs in initialization/media/sourceURL attributes
        rewritten = rewritten.replace(/(initialization|media|sourceURL)="(https?:\/\/[^"]+)"/g, (match, attr, url) => {
          return `${attr}="${prefix}${encodeURIComponent(url)}${hdrSuffix}"`
        })
        console.log('[Proxy] mpd rewritten (first 500 chars):\n',
          rewritten.substring(0, 500).split(PROXY_TOKEN).join('[TOKEN]'))
        delete respHeaders['Content-Length']
        respHeaders['Content-Length'] = Buffer.byteLength(rewritten)
        res.writeHead(proxyRes.statusCode || 200, respHeaders)
        res.end(rewritten)
      })
    } else {
      // Binary content (TS segments, keys, etc.) - pipe directly
      res.writeHead(proxyRes.statusCode || 200, respHeaders)
      proxyRes.pipe(res)
    }
  })

  proxyReq.on('error', (e) => {
    console.error('[Proxy] error fetching', hostOf(targetUrl), e.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message, url: targetUrl }))
    }
  })

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Gateway timeout', url: targetUrl }))
    }
  })

  proxyReq.end()
}

function proxyPost(targetUrl, postBody, postHeaders, res) {
  const target = validProxyTarget(targetUrl)
  if (!target) {
    if (!res.headersSent) { res.writeHead(400); res.end('Invalid or forbidden url') }
    return
  }
  console.log('[Proxy] POST:', target.hostname + target.pathname)

  const baseHeaders = headersForHost(target.hostname)
  const headers = { ...baseHeaders, ...postHeaders }
  const bodyData = Buffer.isBuffer(postBody) ? postBody : (typeof postBody === 'string' ? postBody : JSON.stringify(postBody))
  headers['Content-Length'] = Buffer.byteLength(bodyData)
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const isHttps = target.protocol === 'https:'
  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: 'POST',
    headers,
  }

  options.agent = agentFor(target, isHttps)
  const lib = isHttps ? https : http

  const proxyReq = lib.request(options, (proxyRes) => {
    const respHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': proxyRes.headers['content-type'] || 'application/json',
    }
    // Use Buffer for binary responses (Widevine license is binary)
    const chunks = []
    proxyRes.on('data', (chunk) => { chunks.push(chunk) })
    proxyRes.on('end', () => {
      const buf = Buffer.concat(chunks)
      const statusCode = proxyRes.statusCode || 200
      console.log('[Proxy] POST response:', statusCode, target.hostname + target.pathname, respHeaders['Content-Type'], buf.length)
      if (statusCode >= 400 && /json|text/i.test(respHeaders['Content-Type'])) {
        const safeError = buf.toString('utf8', 0, 500)
          .replace(/("?token"?\s*[:=]\s*"?)[^"&\s]+/gi, '$1[REDACTED]')
          .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
        console.error('[Proxy] POST error response:', safeError)
      }
      respHeaders['Content-Length'] = buf.length
      res.writeHead(statusCode, respHeaders)
      res.end(buf)
    })
  })

  proxyReq.on('error', (e) => {
    console.error('[Proxy] POST error:', e.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Gateway timeout' }))
    }
  })

  proxyReq.write(bodyData)
  proxyReq.end()
}

// ─── Reproductores externos (mpv / VLC) ────────────────────────────────────
// En desktop los esquemas vlc:// / mpv:// no existen — se lanza el binario
// real con la URL del stream (que puede ser la del proxy local, con headers).
function findExe(candidates) {
  for (const c of candidates) {
    if (c.includes(path.sep) || /^[A-Za-z]:[\\/]/.test(c)) {
      if (fs.existsSync(c)) return c
    } else {
      try {
        execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} "${c}"`, { stdio: 'ignore' })
        return c
      } catch {}
    }
  }
  return null
}

function openExternalPlayer({ player, url, headers, title }) {
  if (!/^https?:\/\//.test(url || '')) return { ok: false, error: 'URL no válida' }
  const progs = {
    mpv: {
      names: process.platform === 'win32'
        ? ['mpv', 'C:\\Program Files\\mpv\\mpv.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe')]
        : ['mpv', '/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv', '/var/lib/flatpak/exports/bin/io.mpv.Mpv'],
      args: (exe, u) => {
        const a = [`--force-media-title=${title || 'OctoStream'}`, '--fs']
        // mpv acepta headers HTTP arbitrarios (Referer exigido por muchos CDN).
        const h = sanitizeProxyHeaders(headers)
        for (const [k, v] of Object.entries(h)) a.push(`--http-header-fields-append=${k}: ${v}`)
        a.push(u)
        return a
      },
    },
    vlc: {
      names: process.platform === 'win32'
        ? ['vlc', 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe']
        : ['vlc', '/usr/bin/vlc', '/usr/local/bin/vlc', '/snap/bin/vlc', '/var/lib/flatpak/exports/bin/org.videolan.VLC'],
      args: (exe, u) => {
        const a = ['--play-and-exit', `--meta-title=${title || 'OctoStream'}`]
        const h = sanitizeProxyHeaders(headers)
        if (h['Referer'] || h['referer']) a.push(`--http-referrer=${h['Referer'] || h['referer']}`)
        if (h['User-Agent'] || h['user-agent']) a.push(`--http-user-agent=${h['User-Agent'] || h['user-agent']}`)
        a.push(u)
        return a
      },
    },
  }
  const p = progs[player]
  if (!p) return { ok: false, error: 'player desconocido' }
  const exe = findExe(p.names)
  if (!exe) return { ok: false, error: `${player} no está instalado` }
  try {
    const child = spawn(exe, p.args(exe, url), { detached: true, stdio: 'ignore' })
    child.unref()
    console.log('[External]', player, '→', hostOf(url))
    return { ok: true, exe }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function servePackagedApp(pathname, res) {
  const distDir = path.resolve(__dirname, '..', 'dist')
  const relativePath = pathname === '/app' || pathname === '/app/'
    ? 'index.html'
    : pathname.replace(/^\/app\//, '').replace(/^\//, '')
  const filePath = path.resolve(distDir, relativePath)
  if (!filePath.startsWith(distDir + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false
  }
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
  }
  res.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': fs.statSync(filePath).size,
  })
  fs.createReadStream(filePath).pipe(res)
  return true
}

function startProxyServer() {
  if (proxyServer) return

  proxyServer = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${PROXY_PORT}`)
    const clientIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'

    if (req.method === 'GET' && isLocal && (parsed.pathname.startsWith('/app') || parsed.pathname.startsWith('/assets/'))) {
      if (!servePackagedApp(parsed.pathname, res)) {
        res.writeHead(404)
        res.end('Not found')
      }
      return
    }

    // Assets públicos de raíz (logo-symbol.png usado por LogoLoader, sidebar,
    // splash, favicon…): sin esto las imágenes con src="/logo-*.png" daban
    // 404/403 en el empaquetado y los loaders se veían vacíos. Solo archivos
    // existentes en dist/ — si no existe se sigue con el routing normal.
    if (req.method === 'GET' && isLocal && parsed.pathname.length > 1 &&
        !parsed.pathname.slice(1).includes('/')) {
      if (servePackagedApp(parsed.pathname, res)) return
    }

    if (parsed.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const suppliedToken = parsed.searchParams.get('token') || req.headers['x-octostream-proxy-token']
    if (suppliedToken !== PROXY_TOKEN) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (parsed.pathname === '/post') {
      // POST proxy: read URL from ?url=, headers from ?headers= (JSON), body from request body
      const targetUrl = parsed.searchParams.get('url')
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
        res.writeHead(400)
        res.end('Missing or invalid url param')
        return
      }
      // Parse headers from query param
      let extraHeaders = {}
      const headersParam = parsed.searchParams.get('headers')
      if (headersParam) {
        try { extraHeaders = JSON.parse(headersParam) } catch {}
      }
      // Also check X-Proxy-Header-* for backwards compat
      for (const [key, val] of Object.entries(req.headers)) {
        if (key.startsWith('x-proxy-header-')) {
          const realName = key.substring('x-proxy-header-'.length).replace(/_/g, '-')
          extraHeaders[realName] = val
        }
      }
      // Collect body (capped — token-protected but LAN-reachable)
      let body = ''
      let tooLarge = false
      req.on('data', (chunk) => {
        if (tooLarge) return
        body += chunk.toString()
        if (body.length > 1024 * 1024) {
          tooLarge = true
          res.writeHead(413)
          res.end('Payload too large')
          req.destroy()
        }
      })
      req.on('end', () => {
        if (!tooLarge) proxyPost(targetUrl, body, extraHeaders, res)
      })
      return
    }

    if (parsed.pathname === '/embed-relay') {
      // Relay de origen para CDNs ligados al documento del embed
      // (DLive/tiestep): el fetch se hace con la sesión del BrowserWindow del
      // embed (TLS Chromium + sus cookies) — espejo del playRelay de Android.
      // Misma validación de destino que /proxy (loopback/LAN fuera — SSRF).
      const relayTarget = parsed.searchParams.get('u')
      if (!relayTarget || !validProxyTarget(relayTarget)) {
        res.writeHead(400)
        res.end('Invalid or forbidden url')
        return
      }
      Embed.handleRelayRequest(parsed, res)
      return
    }

    if (req.url.startsWith('/raw/')) {
      // Raw proxy: everything after /raw/ is the target URL (preserves query params)
      const targetUrl = req.url.substring(5) // strip '/raw/'
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
        res.writeHead(400)
        res.end('Invalid url')
        return
      }
      console.log('[Proxy] raw:', hostOf(targetUrl))
      const clientIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
      const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'
      const prefix = isLocal ? PROXY_PREFIX_LOCAL : PROXY_PREFIX_LAN
      proxyFetch(targetUrl, res, prefix, null, req.headers)
      return
    }

    if (parsed.pathname !== '/proxy') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const targetUrl = parsed.searchParams.get('url')
    if (!targetUrl) {
      res.writeHead(400)
      res.end('Missing url param')
      return
    }

    // Headers extra del stream (Referer/cookies/UA de los resolvers), como en /post.
    let extraHeaders = {}
    const headersParam = parsed.searchParams.get('headers')
    if (headersParam) {
      try { extraHeaders = JSON.parse(headersParam) } catch { /* JSON inválido: sin headers extra */ }
    }

    // Determine which proxy prefix to use based on client IP
    // If request comes from localhost (renderer), use 127.0.0.1
    // If from LAN (Chromecast), use the machine's LAN IP
    const prefix = isLocal ? PROXY_PREFIX_LOCAL : PROXY_PREFIX_LAN
    if (!isLocal) {
      console.log('[Proxy] LAN request from', clientIp, '- using LAN prefix')
    }

    // If POST, forward as POST (used by Widevine license requests)
    if (req.method === 'POST') {
      const chunks = []
      req.on('data', (chunk) => { chunks.push(chunk) })
      req.on('end', () => {
        const contentType = req.headers['content-type'] || 'application/octet-stream'
        proxyPost(targetUrl, Buffer.concat(chunks),
          { ...sanitizeProxyHeaders(extraHeaders), 'Content-Type': contentType }, res)
      })
      return
    }

    proxyFetch(targetUrl, res, prefix, extraHeaders, req.headers)
  })

  // Listen on all interfaces so Chromecast can reach the proxy
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Proxy] Stream proxy running on http://0.0.0.0:${PROXY_PORT}`)
    console.log(`[Proxy] Local:    http://127.0.0.1:${PROXY_PORT}`)
    console.log(`[Proxy] LAN:      http://${LOCAL_IP}:${PROXY_PORT}`)
  })

  proxyServer.on('error', (e) => {
    console.error('[Proxy] failed to start:', e.message)
  })
}

// ─── App setup ─────────────────────────────────────────────────────────────

// IPC handler: return LAN-accessible proxy URL for Chromecast
ipcMain.handle('get-lan-proxy-url', () => {
  return PROXY_PREFIX_LAN
})
ipcMain.on('get-proxy-config', (event) => {
  event.returnValue = {
    port: PROXY_PORT,
    url: PROXY_PREFIX_LOCAL,
    base: `http://127.0.0.1:${PROXY_PORT}`,
  }
})

// Abrir el stream en un reproductor externo instalado (mpv/VLC).
ipcMain.handle('player:open-external', (_event, arg) => openExternalPlayer(arg || {}))

// Cloud-proxy WARP — misma superficie que el plugin CloudProxy de Android.
ipcMain.handle('cloud:connect', () => aetherConnect())
ipcMain.handle('cloud:disconnect', () => aetherDisconnect(false))
ipcMain.handle('cloud:disconnect-background', () => aetherDisconnect(true))
ipcMain.handle('cloud:status', async () => {
  const alive = aetherState.proc ? aetherState.proc.exitCode === null : false
  const up = aetherState.connected && await isAetherProxyUp()
  if (aetherState.connected && !up && !alive) aetherState.connected = false
  return {
    connected: up,
    connecting: aetherState.connecting,
    socks: up ? `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}` : '',
    http: up ? `${AETHER_SOCKS_HOST}:${AETHER_HTTP_PORT}` : '',
    error: aetherState.error,
  }
})

// YouTube — misma superficie que el plugin Youtube de Android.
for (const [method, fn] of Object.entries({
  'youtube:resolve': 'resolve',
  'youtube:search': 'search',
  'youtube:search-more': 'searchMore',
  'youtube:suggest': 'suggest',
  'youtube:get-channel': 'getChannel',
  'youtube:get-channel-info': 'getChannelInfo',
})) {
  ipcMain.handle(method, (_event, arg) => Youtube[fn](arg || {}))
}

// Torrent P2P — misma superficie que el plugin TorrentEngine de Android
// (jlibtorrent) implementado con WebTorrent en el main.
let torrentEngine = null
async function getTorrentEngine() {
  if (!torrentEngine) {
    let mod
    if (torrentModulePath) {
      let bundlePath = torrentModulePath
      // import() desde app.asar puede fallar según la versión de Electron;
      // además el bundle hace createRequire(import.meta.url), que exige una
      // URL file:// real. Se extrae a temp y se importa desde disco.
      if (bundlePath.includes('app.asar')) {
        const dest = path.join(app.getPath('temp'), 'octostream-torrent.bundle.mjs')
        try {
          if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(bundlePath).size) {
            fs.copyFileSync(bundlePath, dest)
          }
        } catch { /* si ya existe lo usamos igual */ }
        bundlePath = fs.existsSync(dest) ? dest : bundlePath
      }
      mod = await import(require('url').pathToFileURL(bundlePath).href)
    } else {
      mod = require('./torrent.cjs')
    }
    const E = mod.TorrentEngine || mod.default?.TorrentEngine
    torrentEngine = new E({
      sendEvent: (name, data) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('torrent-event', { name, data }) } catch {}
        }
      },
      downloadDir: path.join(app.getPath('temp'), 'octostream-torrent'),
    })
  }
  return torrentEngine
}
ipcMain.handle('torrent:start', async (_e, arg) => (await getTorrentEngine()).start(arg || {}))
ipcMain.handle('torrent:stop', async () => (await getTorrentEngine()).stop())
ipcMain.handle('torrent:status', async () => (await getTorrentEngine()).status())

// Pantalla completa de la ventana: la app Android reproduce siempre a
// pantalla completa; en escritorio el player se comporta igual.
ipcMain.handle('win:fullscreen', (event, on) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  win.setFullScreen(!!on)
  return win.isFullScreen()
})
ipcMain.handle('win:fullscreen-state', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
})

// IPC handler: log messages from renderer to terminal
ipcMain.on('renderer-log', (_event, msg) => {
  console.log('[Renderer]', msg)
})

// ─── Sync server LAN ───────────────────────────────────────────────────────
// Mismo servicio que el plugin Android (@optopus/sync-server) corriendo en el
// proceso principal: HTTP :8765, descubrimiento UDP :8766 (multicast
// 239.255.60.60 + broadcast). El renderer habla con él por IPC igual que en
// Android habla con el plugin Capacitor — la UI es idéntica en ambos.
let syncServer = null
function getSync() {
  if (!syncServer) {
    syncServer = new SyncServer({
      dataDir: app.getPath('userData'),
      sendEvent: (name, data) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('sync-event', { name, data }) } catch {}
        }
      },
    })
  }
  return syncServer
}

const SYNC_IPC = {
  'sync:start': (s) => s.start(),
  'sync:stop': (s) => s.stop(),
  'sync:device-info': (s) => s.getDeviceInfo(),
  'sync:set-local-data': (s, a) => s.setLocalData(a || {}),
  'sync:received-data': (s) => s.getReceivedData(),
  'sync:clear-received': (s) => s.clearReceivedData(),
  'sync:allow-device': (s, a) => s.allowDevice(a || {}),
  'sync:answer-pair': (s, a) => s.answerPair(a || {}),
  'sync:paired-devices': (s) => s.getPairedDevices(),
  'sync:forget-devices': (s) => s.forgetDevices(),
  'sync:discovered': (s) => s.getDiscoveredDevices(),
}
for (const [channel, fn] of Object.entries(SYNC_IPC)) {
  ipcMain.handle(channel, (_event, arg) => Promise.resolve(fn(getSync(), arg)))
}

// ─── Embeds WAF (paridad con el WebView oculto/relay de Android) ─────────────
Embed.init({
  getProxyBase: () => `http://127.0.0.1:${PROXY_PORT}`,
  getProxyToken: () => PROXY_TOKEN,
  getRouting: () => aetherState.connected
    ? { proxyRules: `socks5://${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`, proxyBypassRules: AETHER_BYPASS_CHROMIUM }
    : null,
  sendState: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('embed:state', payload) } catch {}
    }
  },
})
ipcMain.handle('embed:resolve', (_e, arg) => Embed.resolve(arg || {}))
ipcMain.handle('embed:play', (_e, arg) => Embed.play(arg || {}))
ipcMain.handle('embed:relay', (_e, arg) => Embed.relay(arg || {}))
ipcMain.handle('embed:relay-stop', (_e, arg) => Embed.stopRelay(arg?.id || arg))
ipcMain.handle('embed:close-all', () => Embed.closeAll())

// ─── DLNA "Enviar a TV" (paridad con openDlna de Android) ────────────────────
ipcMain.handle('cast:dlna-scan', (_e, arg) => Dlna.scan(arg?.timeout || 3500))
ipcMain.handle('cast:dlna', (_e, arg) => Dlna.scanAndPlay(arg || {}))

// ─── Reproductor nativo mpv (paridad con el plugin ExoPlayer de Android) ────
// Ventana propia controlada por JSON IPC (--input-ipc-server): la app manda
// play/pause/seek/switch y recibe position/ended/closed/zap como playbackState.
let mpvSession = null
function mpvSendToRenderer(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('player:event', ev) } catch {}
  }
}
function getMpv() {
  if (mpvSession?.running) return mpvSession
  if (mpvSession) { try { mpvSession.close() } catch {} mpvSession = null }
  return null
}
const MPV_URL_OK = (u) => /^https?:\/\//i.test(u || '')

// mpv embebido en la ventana de la app (--wid): X11 y Windows. En Wayland
// nativo --wid no existe → ventana flotante (misma UI vía nuestro OSC).
function mpvEmbedWid(event) {
  if (process.platform !== 'linux' && process.platform !== 'win32') return 0
  if (process.platform === 'linux') {
    const wayland = process.env.XDG_SESSION_TYPE === 'wayland' &&
      (process.argv.includes('--ozone-platform=wayland') ||
        process.env.ELECTRON_OZONE_PLATFORM_HINT === 'wayland')
    if (wayland) return 0
  }
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    const h = win?.getNativeWindowHandle?.()
    if (!h || !h.length) return 0
    const id = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0)
    return Number.isSafeInteger(id) && id > 0 ? id : 0
  } catch { return 0 }
}

ipcMain.handle('player:status', () => ({
  available: !!Mpv.findMpv(),
  playing: !!mpvSession?.running,
  exe: Mpv.findMpv() || '',
}))
ipcMain.handle('player:open', async (e, arg = {}) => {
  if (!MPV_URL_OK(arg.url)) return { status: 'error', error: 'URL no válida' }
  const exe = Mpv.findMpv()
  if (!exe) return { status: 'unavailable', error: 'mpv no está instalado (instala el paquete mpv o vlc)' }
  const wid = mpvEmbedWid(e)
  console.log('[Mpv] IPC open', hostOf(arg.url), 'prevSession:', !!mpvSession, 'running:', !!mpvSession?.running, 'wid:', wid || 'no')
  // Cerrar SIEMPRE la sesión anterior (viva o muriendo): un doble-open
  // (StrictMode, re-resolve rápido) dejaba dos mpv pegados al mismo --wid.
  if (mpvSession) { try { mpvSession.close() } catch {} mpvSession = null }
  const session = new Mpv.MpvSession(exe, mpvSendToRenderer, () => { mpvSession = null })
  mpvSession = session
  arg.wid = wid
  const r = await session.open(arg)
  return { ...r, embedded: !!wid }
})
ipcMain.handle('player:switch', async (_e, arg = {}) => {
  if (!MPV_URL_OK(arg.url)) return { status: 'error', error: 'URL no válida' }
  const s = getMpv()
  console.log('[Mpv] IPC switch', hostOf(arg.url), 'session:', !!s)
  if (!s) return { status: 'error', error: 'no hay sesión' }
  const r = await s.switch(arg)
  if (r && r.embedded === undefined) r.embedded = !!s.embedWid
  return r
})
ipcMain.handle('player:pause', () => { getMpv()?.pause() })
ipcMain.handle('player:resume', () => { getMpv()?.resume() })
ipcMain.handle('player:seek', (_e, arg = {}) => { if (Number.isFinite(arg.sec)) getMpv()?.seek(arg.sec) })
ipcMain.handle('player:rate', (_e, arg = {}) => { if (Number.isFinite(arg.rate)) getMpv()?.setRate(arg.rate) })
ipcMain.handle('player:volume', (_e, arg = {}) => { if (Number.isFinite(arg.v)) getMpv()?.setVolume(arg.v) })
ipcMain.handle('player:mute', (_e, arg = {}) => { getMpv()?.setMute(arg.m) })
ipcMain.handle('player:text', (_e, arg = {}) => { getMpv()?.showText(arg.text) })
ipcMain.handle('player:sub-delay', (_e, arg = {}) => { if (Number.isFinite(arg.sec)) getMpv()?.setSubDelay(arg.sec) })
ipcMain.handle('player:sub-off', () => { getMpv()?.subOff() })
ipcMain.handle('player:set-channels', (_e, arg = {}) => { getMpv()?.setChannels(arg.channels, arg.channelIndex) })
// Input y estado para el OSC cuando mpv está embebido en la ventana.
ipcMain.handle('player:mouse', (_e, arg = {}) => { getMpv()?.mouse(arg.x, arg.y) })
ipcMain.handle('player:key', (_e, arg = {}) => { getMpv()?.key(arg.name) })
ipcMain.handle('player:osc-state', (_e, arg = {}) => { getMpv()?.oscPush('state', arg) })
ipcMain.handle('player:osc-menu', (_e, arg = {}) => { getMpv()?.oscPush('menu', arg) })
ipcMain.handle('player:stop', () => { console.log('[Mpv] IPC stop, session:', !!mpvSession); const s = getMpv(); if (s) { s.close(); mpvSession = null } })
// Búsqueda de subtítulos en el addon público de Stremio
// (opensubtitles-v3.strem.io): sin API key ni login, indexa por IMDB id.
// Película: /subtitles/movie/ttXXX.json — Serie: ttXXX:temp:epi. Se hace en
// el proceso principal para esquivar CORS del renderer.
ipcMain.handle('player:search-subs', async (_e, arg = {}) => {
  const { imdbId } = arg
  if (!imdbId) return { subs: [] }
  const season = Number(arg.season) || 0
  const episode = Number(arg.episode) || 0
  const isSeries = season > 0 && episode > 0
  const id = isSeries ? `${imdbId}:${season}:${episode}` : imdbId
  try {
    const res = await fetch(
      `https://opensubtitles-v3.strem.io/subtitles/${isSeries ? 'series' : 'movie'}/${id}.json`,
      { headers: { 'User-Agent': 'OctoStream' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { subs: [] }
    const data = await res.json()
    const rank = (l) => (/^(spa|esp)/i.test(l) ? 0 : /^eng/i.test(l) ? 1 : 2)
    const subs = (data.subtitles || [])
      .map(s => ({
        id: s.id,
        lang: s.lang || '',
        name: s.subtitleFileName || s.movieReleaseName || 'Subtítulo',
        url: s.url || '',
      }))
      .filter(s => s.url && /^https?:/i.test(s.url))
      .sort((a, b) => rank(a.lang) - rank(b.lang))
      .slice(0, 60)
    return { subs }
  } catch { return { subs: [] } }
})

// Subtítulo externo (OpenSubtitles): la app pasa `url` (descarga en main,
// sin CORS y con decodificación CP1252 de subs antiguos) o `content` en
// texto. Se escribe a un temporal con la extensión real (srt/vtt) y se
// añade con sub-add — mpv no puede leer blob: URLs.
ipcMain.handle('player:add-sub', async (_e, arg = {}) => {
  const s = getMpv()
  if (!s) return { ok: false }
  try {
    let content = typeof arg.content === 'string' && arg.content ? arg.content : null
    if (!content && typeof arg.url === 'string') {
      const u = new URL(arg.url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false }
      const res = await fetch(u, {
        headers: { 'User-Agent': 'OctoStream' }, signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return { ok: false }
      const buf = Buffer.from(await res.arrayBuffer())
      content = buf.toString('utf8')
      // Subs antiguos en CP1252: los caracteres rotos se detectan por el
      // marcador de sustitución UTF-8 y se re-decodifica.
      if (content.includes('�')) {
        content = new TextDecoder('windows-1252').decode(buf)
      }
    }
    if (!content) return { ok: false }
    const ext = /^\s*WEBVTT/i.test(content) ? 'vtt' : 'srt'
    const file = path.join(os.tmpdir(), `octo-sub-${Date.now()}.${ext}`)
    fs.writeFileSync(file, content, 'utf8')
    s.addSubtitle(file, arg.label || 'Subtítulo', arg.lang || '')
    return { ok: true }
  } catch { return { ok: false } }
})

// ─── Update check escritorio (paridad con appUpdater de Android) ─────────────
// Mismo manifiesto version.json del repo; el diálogo abre la release en el
// navegador (no hay auto-update firmado sin electron-updater).
ipcMain.handle('update:check', async () => {
  try {
    const resp = await fetch('https://api.github.com/repos/octostream-project/OctoStream/releases/latest', {
      headers: { 'User-Agent': 'OctoStream', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return { available: false }
    const rel = await resp.json()
    const tag = String(rel.tag_name || '').replace(/^v/, '')
    const cur = String(app.getVersion() || '').replace(/^v/, '')
    const newer = tag.split('.').map(Number)
    const now = cur.split('.').map(Number)
    let isNewer = false
    for (let i = 0; i < Math.max(newer.length, now.length); i++) {
      const a = newer[i] || 0, b = now[i] || 0
      if (a > b) { isNewer = true; break }
      if (a < b) break
    }
    return {
      available: isNewer,
      version: rel.tag_name || tag,
      notes: String(rel.body || '').slice(0, 2000),
      url: rel.html_url || 'https://github.com/octostream-project/OctoStream/releases/latest',
    }
  } catch {
    return { available: false }
  }
})
ipcMain.handle('update:open', (_e, arg) => {
  const url = typeof arg === 'string' ? arg : arg?.url
  if (url && /^https:\/\//i.test(url)) return shell.openExternal(url)
  return Promise.resolve()
})

app.whenReady().then(async () => {
  if (components?.whenReady) {
    try {
      await components.whenReady([components.WIDEVINE_CDM_ID])
      console.log('[Widevine] ECS component status:', JSON.stringify(components.status()))
    } catch (error) {
      console.error('[Widevine] ECS component installation failed:', error?.message || error)
      if (error?.errors) console.error('[Widevine] Component errors:', JSON.stringify(error.errors))
    }
  } else {
    console.error('[Widevine] Castlabs ECS components API is unavailable')
  }

  startProxyServer()

  // Route renderer traffic through Aether/WARP SOCKS5 if present (anti-leak)
  await configureAetherProxy()

  // Also set permission request handler for media
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  // La inyección de Origin/Referer/UA vive en el listener de createWindow():
  // webRequest solo admite UN listener por evento y sesión, y la ventana usa
  // defaultSession — un listener aquí quedaría reemplazado (código muerto).

  createWindow()
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'OctoStream',
    icon: path.join(__dirname, '..', 'dist', 'logo-symbol.png'),
    autoHideMenuBar: true, // sin barra de menú — misma apariencia que la app móvil
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })

  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen-changed', true))
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen-changed', false))

  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = (() => { try { return new URL(url) } catch { return null } })()
    const allowed = ['http:', 'https:', 'vlc:', 'mpv:', 'magnet:']
    if (parsed && allowed.includes(parsed.protocol)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://localhost:5173') || url.startsWith('file://')) return
    event.preventDefault()
  })

  // Intercept requests to inject correct Origin/Referer and bypass CORS
  win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
    const url = details.url || ''
    const headers = { ...details.requestHeaders }
    // Inject correct Origin/Referer for known providers
    if (/atresplayer\.com|atresmedia\.com|atres-live/i.test(url)) {
      headers['Origin'] = 'https://www.atresplayer.com'
      headers['Referer'] = 'https://www.atresplayer.com/'
    } else if (/mediaset|widevine\.entitlement\.theplatform\.eu|doubleclick\.net\/ssai|dai\.google\.com/i.test(url)) {
      headers['Origin'] = 'https://www.mediasetinfinity.es'
      headers['Referer'] = 'https://www.mediasetinfinity.es/'
    } else if (/rtve\.es|rtvelivestream/i.test(url)) {
      headers['Origin'] = 'https://www.rtve.es'
      headers['Referer'] = 'https://www.rtve.es/'
    } else if (/tdtchannels\.com/i.test(url)) {
      headers['Referer'] = 'https://www.tdtchannels.com/'
    } else if (/tdtspain\.com/i.test(url)) {
      headers['Referer'] = 'https://www.tdtspain.com/'
    } else if (/dailymotion\.com|geo\.dailymotion/i.test(url)) {
      headers['Origin'] = 'https://geo.dailymotion.com'
      headers['Referer'] = 'https://geo.dailymotion.com/'
    }
    // Always set a user agent
    if (!headers['User-Agent'] || headers['User-Agent'].includes('Electron')) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    }
    cb({ cancel: false, requestHeaders: headers })
  })

  // Strip CORS headers from responses so renderer can access them
  win.webContents.session.webRequest.onCompleted({ urls: ['https://widevine.entitlement.theplatform.eu/*'] }, (details) => {
    const licensePath = (() => { try { return new URL(details.url).pathname } catch { return '' } })()
    console.log('[Widevine] License HTTP response:', details.statusCode, licensePath)
  })

  win.webContents.session.webRequest.onErrorOccurred({ urls: ['https://widevine.entitlement.theplatform.eu/*'] }, (details) => {
    const licensePath = (() => { try { return new URL(details.url).pathname } catch { return '' } })()
    console.error('[Widevine] License network error:', details.error, licensePath)
  })

  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders }
    const url = details.url || ''
    // Solo la app necesita el bypass de CORS. Si se reescribe ACAO en TODAS las
    // respuestas de la sesión, un iframe de proveedor (no confiable) podría
    // leer respuestas cross-origin — incluidos hosts de la LAN del usuario.
    // Las peticiones iniciadas por iframes de terceros llevan referrer del
    // propio embed: esas conservan la política CORS original.
    const ref = details.referrer || ''
    const isAppInitiated = !ref ||
      ref.startsWith('http://localhost:5173') ||
      ref.startsWith(`http://127.0.0.1:${PROXY_PORT}`) ||
      ref.startsWith('file://')
    if (!isAppInitiated) {
      cb({ cancel: false, responseHeaders: headers })
      return
    }
    // Iframes de embed iniciados por la app: X-Frame-Options/CSP frame-ancestors
    // bloquearían el fallback iframe de los providers — se retiran (solo para
    // respuestas solicitadas desde el frame de la app, no para terceros).
    if (details.resourceType === 'subFrame' || details.resourceType === 'subframe') {
      for (const k of Object.keys(headers)) {
        if (/^x-frame-options$/i.test(k)) delete headers[k]
        if (/^content-security-policy/i.test(k)) {
          headers[k] = headers[k].map(v => v.replace(/frame-ancestors[^;]*(;|$)/gi, '')).filter(v => v.trim())
        }
      }
    }
    // For Mediaset/DAI CDN streams (rawvod, link.api), preserve specific origin
    // for cookies (hdntl). For API calls (services-ott-prod-fe), use * so the
    // renderer can make POST requests (login, playback check) without CORS errors.
    if (/rawvod\.mediaset|link\.api\.eu\.theplatform|dai\.google\.com|doubleclick\.net/i.test(url)) {
      headers['Access-Control-Allow-Origin'] = ['https://www.mediasetinfinity.es']
      headers['Access-Control-Allow-Credentials'] = ['true']
    } else {
      headers['Access-Control-Allow-Origin'] = ['*']
    }
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS']
    headers['Access-Control-Allow-Headers'] = ['*']
    // Remove lowercase duplicates
    delete headers['access-control-allow-origin']
    delete headers['access-control-allow-methods']
    delete headers['access-control-allow-headers']
    delete headers['access-control-allow-credentials']
    cb({ cancel: false, responseHeaders: headers })
  })

  const isDev = !app.isPackaged

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadURL(`http://127.0.0.1:${PROXY_PORT}/app/`)
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  if (aetherState.proc) {
    try { aetherState.proc.kill('SIGKILL') } catch {}
    aetherState.proc = null
    aetherState.connected = false
  }
  if (proxyServer) {
    proxyServer.close()
    proxyServer = null
  }
  if (syncServer) {
    syncServer.stop().catch(() => {})
    syncServer = null
  }
  if (torrentEngine) {
    torrentEngine.stop().catch(() => {})
    torrentEngine = null
  }
  if (mpvSession) {
    try { mpvSession.close() } catch {}
    mpvSession = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
