// Silence Fontconfig warnings (harmless on some Linux distros)
process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || '/etc/fonts'

const { app, BrowserWindow, shell, session, ipcMain } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')
const os = require('os')
const { URL } = require('url')

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

// Custom HTTPS agent that ignores certificate errors.
// Electron's Node.js (BoringSSL) requires this approach instead of
// passing rejectUnauthorized in request options.
const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
})

// ─── Local stream proxy ────────────────────────────────────────────────────
// Solves CORS + SSL issues: fetches streams server-side (Node) and serves
// them to the renderer via http://127.0.0.1:PROXY_PORT/proxy?url=...
// The proxy injects correct headers (User-Agent, Referer, Origin) and
// ignores certificate errors.

const PROXY_PORT = 19588
const LOCAL_IP = getLocalIP()
// Proxy prefix for renderer (localhost) and for Chromecast (LAN IP)
const PROXY_PREFIX_LOCAL = `http://127.0.0.1:${PROXY_PORT}/proxy?url=`
const PROXY_PREFIX_LAN = `http://${LOCAL_IP}:${PROXY_PORT}/proxy?url=`
let proxyServer = null

function headersForHost(host) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': '*/*',
  }
  if (/rtve\./i.test(host)) {
    headers['Origin'] = 'https://www.rtve.es'
    headers['Referer'] = 'https://www.rtve.es/'
  } else if (/atresplayer\.|atresmedia\./i.test(host)) {
    headers['Origin'] = 'https://www.atresplayer.com'
    headers['Referer'] = 'https://www.atresplayer.com/'
  } else if (/mediaset\./i.test(host)) {
    headers['Origin'] = 'https://www.mediasetinfinity.es'
    headers['Referer'] = 'https://www.mediasetinfinity.es/'
  } else if (/tdtchannels\./i.test(host)) {
    headers['Referer'] = 'https://www.tdtchannels.com/'
  } else if (/tdtspain\./i.test(host)) {
    headers['Referer'] = 'https://www.tdtspain.com/'
  }
  return headers
}

function proxyFetch(targetUrl, res, proxyPrefix) {
  const prefix = proxyPrefix || PROXY_PREFIX_LOCAL
  console.log('[Proxy] fetching:', targetUrl.substring(0, 120))
  let target
  try {
    target = new URL(targetUrl)
  } catch {
    if (!res.headersSent) { res.writeHead(400); res.end('Invalid url') }
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

  // Use insecure agent for HTTPS to bypass certificate verification
  if (isHttps) {
    options.agent = insecureAgent
  }

  const lib = isHttps ? https : http

  const proxyReq = lib.request(options, (proxyRes) => {
    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = proxyRes.headers.location
      const absoluteRedirect = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, targetUrl).href
      console.log('[Proxy] redirect', proxyRes.statusCode, '->', absoluteRedirect.substring(0, 100))
      res.writeHead(302, { 'Location': `/proxy?url=${encodeURIComponent(absoluteRedirect)}` })
      res.end()
      return
    }

    const contentType = proxyRes.headers['content-type'] || ''
    const isM3u8 = /\.m3u8/i.test(targetUrl) || /mpegurl|vnd\.apple\.mpeg/i.test(contentType)
    const isGzJson = /\.gz$/i.test(targetUrl) || /gzip/i.test(contentType)
    console.log('[Proxy] response', proxyRes.statusCode, contentType, isM3u8 ? '(m3u8)' : '', isGzJson ? '(gz)' : '', targetUrl.substring(0, 80))

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
        console.log('[Proxy] m3u8 content (first 500 chars):\n', body.substring(0, 500))
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
        console.log('[Proxy] m3u8 rewritten (first 500 chars):\n', rewrittenBody.substring(0, 500))
        delete respHeaders['Content-Length']
        respHeaders['Content-Length'] = Buffer.byteLength(rewrittenBody)
        res.writeHead(proxyRes.statusCode || 200, respHeaders)
        res.end(rewrittenBody)
      })
    } else {
      // Binary content (TS segments, keys, etc.) - pipe directly
      res.writeHead(proxyRes.statusCode || 200, respHeaders)
      proxyRes.pipe(res)
    }
  })

  proxyReq.on('error', (e) => {
    console.error('[Proxy] error fetching', targetUrl, e.message)
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

function startProxyServer() {
  if (proxyServer) return

  proxyServer = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${PROXY_PORT}`)

    if (parsed.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (parsed.pathname === '/raw') {
      // Raw proxy: takes the entire path after /raw/ as the target URL
      // This avoids encoding issues with query params in the target URL
      const targetUrl = req.url.replace(/^\/raw\//, '')
      if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
        res.writeHead(400)
        res.end('Invalid url')
        return
      }
      const clientIp = req.socket.remoteAddress.replace(/^::ffff:/, '')
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
    const clientIp = req.socket.remoteAddress.replace(/^::ffff:/, '')
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'
    const prefix = isLocal ? PROXY_PREFIX_LOCAL : PROXY_PREFIX_LAN
    if (!isLocal) {
      console.log('[Proxy] LAN request from', clientIp, '- using LAN prefix')
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

app.whenReady().then(() => {
  startProxyServer()

  // Ignore ALL certificate errors for all requests (renderer + proxy)
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0) // 0 = accept
  })

  // Also set permission request handler for media
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  // Inject custom headers for API calls (not proxied streams)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url
    if (/rtve\.|atresplayer\.|mediaset\.|tdtchannels\.|tdtspain\./i.test(url) && !url.includes('127.0.0.1')) {
      if (!details.requestHeaders['User-Agent']) {
        details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      }
      if (/rtve\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.rtve.es'
        details.requestHeaders['Referer'] = 'https://www.rtve.es/'
      } else if (/atresplayer\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.atresplayer.com'
        details.requestHeaders['Referer'] = 'https://www.atresplayer.com/'
      } else if (/mediaset\./i.test(url)) {
        details.requestHeaders['Origin'] = 'https://www.mediasetinfinity.es'
        details.requestHeaders['Referer'] = 'https://www.mediasetinfinity.es/'
      } else if (/tdtchannels\./i.test(url)) {
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
    title: 'Optopus Stream',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
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

  const isDev = !app.isPackaged

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
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
