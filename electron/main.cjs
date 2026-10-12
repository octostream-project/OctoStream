// Silence Fontconfig warnings (harmless on some Linux distros)
process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || '/etc/fonts'

const { app, BrowserWindow, shell, session, ipcMain, components } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const crypto = require('crypto')
const { URL } = require('url')
const { SyncServer } = require('./sync-server.cjs')

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
const AETHER_BYPASS_SUFFIX = /(^|\.)(tdtspain\.com|tdtchannels\.com|rtve\.es|mediaset\.net|mediasetinfinity\.es|doubleclick\.net)$/i
const AETHER_BYPASS_CHROMIUM = [
  '<local>', 'localhost', '127.0.0.1', '*.local',
  '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '169.254.0.0/16',
  '*.tdtspain.com', '*.tdtchannels.com', '*.rtve.es', '*.mediaset.net',
  '*.mediasetinfinity.es', 'dai.google.com', '*.doubleclick.net',
].join(';')
function isAetherBypassHost(host) {
  return AETHER_BYPASS_SUFFIX.test(host || '') || /^dai\.google\.com$/i.test(host || '')
}

const aetherState = { proc: null, connected: false, connecting: false, error: '' }

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
  console.log('[Aether] routing via WARP — renderer SOCKS5 + proxy local')
}

async function clearAetherRouting() {
  aetherState.connected = false
  try { await session.defaultSession.setProxy({ mode: 'direct' }) } catch {}
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
  if (!aetherState.connected || isAetherBypassHost(target.hostname)) {
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

// ─── ffmpeg remux ──────────────────────────────────────────────────────────
// Chromium no reproduce contenedores .mkv/.avi/.ts… El endpoint /ffmpeg
// remultiplexa a fMP4 en streaming: vídeo por copia (sin recodificar) y audio
// a AAC (barato, cubre AC3/DTS/E-AC3 que Chromium tampoco decodifica).
const { spawn, execSync } = require('child_process')

function resolveFfmpeg() {
  if (process.env.OCTOSTREAM_FFMPEG && fs.existsSync(process.env.OCTOSTREAM_FFMPEG)) {
    return process.env.OCTOSTREAM_FFMPEG
  }
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  // Binario estático empaquetado (scripts/fetch-ffmpeg.mjs → extraResources).
  try {
    const bundled = path.join(process.resourcesPath || '', 'ffmpeg',
      `${process.platform}-${process.arch}`, exe)
    if (app.isPackaged && fs.existsSync(bundled)) return bundled
  } catch {}
  // En desarrollo: build/ffmpeg/ dentro del repo, luego PATH del sistema.
  try {
    const devPath = path.resolve(__dirname, '..', 'build', 'ffmpeg',
      `${process.platform}-${process.arch}`, exe)
    if (fs.existsSync(devPath)) return devPath
  } catch {}
  return exe // PATH
}

// El fetch lo hace Node (TLS ya probado por el proxy, con redirects y los
// headers del resolver); ffmpeg lee el stream de stdin. Así el binario
// estático nunca toca TLS — los builds con gnutls crashean contra algunos
// servidores (Cloudflare) durante el handshake.
function remuxFetch(targetUrl, headers, depth, cb) {
  if (depth > 5) return cb(new Error('too many redirects'))
  const target = validProxyTarget(targetUrl)
  if (!target) return cb(new Error('forbidden url'))
  const isHttps = target.protocol === 'https:'
  const lib = isHttps ? https : http
  const req = lib.request({
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
    agent: agentFor(target, isHttps),
    timeout: 30000,
  }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      const loc = up.headers.location
      const abs = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href
      up.resume()
      return remuxFetch(abs, headers, depth + 1, cb)
    }
    cb(null, up)
  })
  req.on('timeout', () => { req.destroy(new Error('fetch timeout')) })
  req.on('error', cb)
  req.end()
}

function remuxStream(targetUrl, extraHeaders, res) {
  const target = validProxyTarget(targetUrl)
  if (!target) {
    res.writeHead(400); res.end('Invalid or forbidden url')
    return
  }
  const hdrs = { ...headersForHost(target.hostname), ...sanitizeProxyHeaders(extraHeaders) }
  console.log('[ffmpeg] remux:', hostOf(targetUrl))
  remuxFetch(targetUrl, hdrs, 0, (err, up) => {
    if (err) {
      console.error('[ffmpeg] fetch error:', err.message)
      if (!res.headersSent) res.writeHead(502)
      res.end()
      return
    }
    if (up.statusCode !== 200 && up.statusCode !== 206) {
      console.warn('[ffmpeg] upstream', up.statusCode)
      up.resume()
      if (!res.headersSent) res.writeHead(up.statusCode)
      res.end()
      return
    }
    const ffmpeg = resolveFfmpeg()
    const args = [
      '-v', 'warning',
      '-fflags', '+genpts+igndts',
      '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ]
    let child
    try {
      child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      up.destroy()
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `ffmpeg no disponible: ${e.message}` }))
      return
    }
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192) })
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })
    up.pipe(child.stdin)
    child.stdout.pipe(res)
    const kill = () => {
      try { child.kill('SIGKILL') } catch {}
      try { up.destroy() } catch {}
    }
    res.on('close', kill)
    child.stdin.on('error', () => { try { up.destroy() } catch {} })
    up.on('error', () => kill())
    up.on('end', () => { try { child.stdin.end() } catch {} })
    reqIdleKill(child, res)
    child.on('error', (e) => {
      console.error('[ffmpeg] spawn error:', e.message)
      kill()
      if (!res.headersSent) { res.writeHead(503) }
      res.end()
    })
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn('[ffmpeg] exit', code, stderr.slice(-300))
      }
      res.end()
    })
  })
}

// Mata el ffmpeg si queda sin lector (cliente cerró) o si no produce datos.
function reqIdleKill(child, res) {
  let last = Date.now()
  child.stdout.on('data', () => { last = Date.now() })
  const iv = setInterval(() => {
    if (res.destroyed || res.closed || Date.now() - last > 45000) {
      clearInterval(iv)
      try { child.kill('SIGKILL') } catch {}
      try { res.end() } catch {}
    }
  }, 10000)
  iv.unref()
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

    if (parsed.pathname === '/ffmpeg') {
      // Remux ffmpeg → fMP4 para contenedores que Chromium no soporta
      // (mkv/avi/ts…). Mismo esquema ?url=&headers= que /proxy.
      const targetUrl = parsed.searchParams.get('url')
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
        res.writeHead(400)
        res.end('Missing or invalid url param')
        return
      }
      let ffHeaders = {}
      const ffHeadersParam = parsed.searchParams.get('headers')
      if (ffHeadersParam) {
        try { ffHeaders = JSON.parse(ffHeadersParam) } catch {}
      }
      remuxStream(targetUrl, ffHeaders, res)
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
    ffmpegUrl: `http://127.0.0.1:${PROXY_PORT}/ffmpeg?token=${PROXY_TOKEN}&url=`,
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
  }
  if (proxyServer) {
    proxyServer.close()
    proxyServer = null
  }
  if (syncServer) {
    syncServer.stop().catch(() => {})
    syncServer = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
