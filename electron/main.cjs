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

// ─── Aether / WARP local proxy detection ─────────────────────────────────────
// On this dev machine Aether (Cloudflare WARP userspace client) listens as a
// SOCKS5 proxy on 127.0.0.1:1819. When present, route ALL renderer traffic
// through it so provider requests go via WARP — mirroring the Android app's
// anti-leak behaviour (system proxy → Aether → WARP tunnel).
const AETHER_SOCKS_HOST = '127.0.0.1'
const AETHER_SOCKS_PORT = 1819

function probeAether() {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)()
    socket.setTimeout(400)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.connect(AETHER_SOCKS_PORT, AETHER_SOCKS_HOST)
  })
}

async function configureAetherProxy() {
  const aetherUp = await probeAether()
  if (!aetherUp) {
    console.log('[Aether] No SOCKS5 proxy on 127.0.0.1:1819 — direct traffic')
    return false
  }
  try {
    // Route all renderer fetch/XHR through Aether SOCKS5, except localhost
    // (app assets, Capacitor bridge, stream proxy on 19588).
    await session.defaultSession.setProxy({
      proxyRules: `socks5://${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`,
      proxyBypassRules: '<local>;127.0.0.1;localhost',
    })
    console.log('[Aether] SOCKS5 proxy detected — renderer traffic routed via WARP (127.0.0.1:1819)')
    return true
  } catch (e) {
    console.error('[Aether] Failed to set proxy:', e.message)
    return false
  }
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
const PROXY_TOKEN = crypto.randomBytes(32).toString('hex')
// Proxy prefix for renderer (localhost) and for Chromecast (LAN IP)
const PROXY_PREFIX_LOCAL = `http://127.0.0.1:${PROXY_PORT}/proxy?token=${PROXY_TOKEN}&url=`
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

function proxyFetch(targetUrl, res, proxyPrefix) {
  const prefix = proxyPrefix || PROXY_PREFIX_LOCAL
  console.log('[Proxy] fetching:', hostOf(targetUrl))
  const target = validProxyTarget(targetUrl)
  if (!target) {
    if (!res.headersSent) { res.writeHead(400); res.end('Invalid or forbidden url') }
    return
  }

  const headers = headersForHost(target.hostname)
  const isHttps = target.protocol === 'https:'
  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
  }

  if (isHttps) options.agent = secureHttpsAgent

  const lib = isHttps ? https : http

  const proxyReq = lib.request(options, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = proxyRes.headers.location
      const absoluteRedirect = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, targetUrl).href
      console.log('[Proxy] redirect', proxyRes.statusCode, '->', hostOf(absoluteRedirect))
      res.writeHead(302, { 'Location': `${prefix}${encodeURIComponent(absoluteRedirect)}` })
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

    if (isM3u8) {
      // Rewrite m3u8: convert relative/absolute segment URLs to proxy URLs
      let body = ''
      proxyRes.on('data', (chunk) => { body += chunk.toString() })
      proxyRes.on('end', () => {
      const rewritten = lines.map(line => {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) {
            // Rewrite URI= in #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA and #EXT-X-SESSION-DATA tags
            if (/^#EXT-X-(KEY|MAP|MEDIA|SESSION-DATA)/.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
              const uriMatch = trimmed.match(/URI="([^"]+)"/)
              if (uriMatch) {
                const originalUri = uriMatch[1]
                const absoluteUri = originalUri.startsWith('http') ? originalUri : new URL(originalUri, targetUrl).href
                return trimmed.replace(uriMatch[0], `URI="${prefix}${encodeURIComponent(absoluteUri)}"`)
              }
            }
            // Also rewrite URL= in #EXT-X-I-FRAME-STREAM-INF tags
            if (/^#EXT-X-I-FRAME-STREAM-INF/.test(trimmed) && /URL="([^"]+)"/.test(trimmed)) {
              const urlMatch = trimmed.match(/URL="([^"]+)"/)
              if (urlMatch) {
                const originalUri = urlMatch[1]
                const absoluteUri = originalUri.startsWith('http') ? originalUri : new URL(originalUri, targetUrl).href
                return trimmed.replace(urlMatch[0], `URL="${prefix}${encodeURIComponent(absoluteUri)}"`)
              }
            }
            return line
          }
          // It's a segment URL (relative or absolute)
          if (/^https?:\/\//.test(trimmed)) {
            return `${prefix}${encodeURIComponent(trimmed)}`
          }
          // Relative URL: resolve against the m3u8 base URL
          try {
            const absolute = new URL(trimmed, targetUrl).href
            return `${prefix}${encodeURIComponent(absolute)}`
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
      proxyRes.on('data', (chunk) => { body += chunk.toString() })
      proxyRes.on('end', () => {
        // Rewrite <BaseURL> elements - segments are relative to BaseURL
        let rewritten = body.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, url) => {
          try {
            const absolute = url.startsWith('http') ? url : new URL(url, targetUrl).href
            return `<BaseURL>${prefix}${encodeURIComponent(absolute)}</BaseURL>`
          } catch { return match }
        })
        // Also rewrite any absolute http(s) URLs in initialization/media/sourceURL attributes
        rewritten = rewritten.replace(/(initialization|media|sourceURL)="(https?:\/\/[^"]+)"/g, (match, attr, url) => {
          return `${attr}="${prefix}${encodeURIComponent(url)}"`
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

  if (isHttps) options.agent = secureHttpsAgent
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
      proxyFetch(targetUrl, res, prefix)
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
        proxyPost(targetUrl, Buffer.concat(chunks), { 'Content-Type': contentType }, res)
      })
      return
    }

    proxyFetch(targetUrl, res, prefix)
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

// IPC handler: log messages from renderer to terminal
ipcMain.on('renderer-log', (_event, msg) => {
  console.log('[Renderer]', msg)
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

  // Inject custom headers for API calls (not proxied streams)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url
    if (/rtve|atresplayer|atresmedia|mediaset|widevine\.entitlement\.theplatform\.eu|doubleclick\.net\/ssai|tdtchannels|tdtspain/i.test(url) && !url.includes('127.0.0.1')) {
      if (!details.requestHeaders['User-Agent']) {
        details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      }
      if (/rtve/i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.rtve.es'
        details.requestHeaders['Referer'] = 'https://www.rtve.es/'
      } else if (/atresplayer|atresmedia/i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.atresplayer.com'
        details.requestHeaders['Referer'] = 'https://www.atresplayer.com/'
      } else if (/mediaset|widevine\.entitlement\.theplatform\.eu|doubleclick\.net\/ssai/i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.mediasetinfinity.es'
        details.requestHeaders['Referer'] = 'https://www.mediasetinfinity.es/'
      } else if (/tdtchannels/i.test(url)) {
        details.requestHeaders['Referer'] = 'https://www.tdtchannels.com/'
      }
    }
    callback({ requestHeaders: details.requestHeaders })
  })

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

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
  if (proxyServer) {
    proxyServer.close()
    proxyServer = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
