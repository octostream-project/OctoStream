// Motor P2P para desktop — equivalente de jlibtorrent en Android
// (capacitor-plugins/torrent-engine) usando WebTorrent en el proceso
// principal: TCP/UDP/DHT/trackers + web seeds, y un servidor HTTP local
// con Range requests que el <video>/mpv lee como stream progresivo.
// Misma superficie que el plugin Capacitor: start/stop/status +
// eventos 'torrentProgress'.
'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { URL } = require('url')

const META_TIMEOUT_MS = 45000
const PROGRESS_MS = 1000

// ── Port de pickTorrentEntries (src/utils/torrentPick.js) ──────────────────
const VIDEO_EXT = /\.(?:mkv|mp4|m4v|avi|wmv|mov|ts|webm|mpg|mpeg)$/i
const SAMPLE_JUNK = /\b(?:sample|trailer|extra|bonus|deleted\.scene|behind\.the\.scenes)\b/i

function episodePatterns(season, episode) {
  const s = Number(season), e = Number(episode)
  if (!s || !e) return []
  return [
    new RegExp(`s0*${s}[ ._-]*e0*${e}(?!\\d)`, 'i'),
    new RegExp(`\\b${s}x0*${e}(?!\\d)`, 'i'),
    new RegExp(`season[ ._-]*0*${s}[ ._-]*episode[ ._-]*0*${e}(?!\\d)`, 'i'),
    ...(s === 1 ? [
      new RegExp(`\\b(?:ep(?:isode)?|cap(?:itulo)?)[ ._-]*0*${e}(?!\\d)`, 'i'),
      new RegExp(`\\b0*${e}(?!\\d)\\s*-\\s*`, 'i'),
    ] : []),
  ]
}

function pickFile(files, { season, episode } = {}) {
  const videos = files.filter(f => VIDEO_EXT.test(f.name || '') && !SAMPLE_JUNK.test(f.name || ''))
  if (!videos.length) return files.reduce((a, b) => (b.length > a.length ? b : a), files[0])
  const pats = episodePatterns(season, episode)
  if (pats.length) {
    const match = videos.filter(f => pats.some(p => p.test(f.name)))
    if (match.length) {
      match.sort((a, b) => b.length - a.length)
      return match[0]
    }
  }
  return videos.reduce((a, b) => (b.length > a.length ? b : a))
}

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mov: 'video/quicktime',
  ts: 'video/mp2t', webm: 'video/webm', mpg: 'video/mpeg', mpeg: 'video/mpeg',
}

// ── Fetch de .torrent (http/https con redirects) ───────────────────────────
function fetchTorrentFile(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('demasiados redirects'))
    let u
    try { u = new URL(url) } catch { return reject(new Error('URL inválida')) }
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'OctoStream/1.0', Accept: 'application/x-bittorrent,application/octet-stream,*/*' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const loc = res.headers.location
        return resolve(fetchTorrentFile(loc.startsWith('http') ? loc : new URL(loc, url).href, depth + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

class TorrentEngine {
  constructor({ sendEvent, downloadDir } = {}) {
    this.sendEvent = typeof sendEvent === 'function' ? sendEvent : () => {}
    this.downloadDir = downloadDir || path.join(os.tmpdir(), 'octostream-torrent')
    this.client = null
    this.torrent = null
    this.file = null
    this.server = null
    this.timer = null
    this.state = 'idle'
  }

  async _getClient() {
    if (!this.client) {
      const { default: WebTorrent } = await import('webtorrent')
      this.client = new WebTorrent({ maxConns: 80 })
    }
    return this.client
  }

  _progress() {
    const t = this.torrent
    const ev = {
      state: this.state,
      progress: t ? t.progress : 0,
      downloadRate: t ? t.downloadSpeed : 0,
      uploadRate: t ? t.uploadSpeed : 0,
      peers: t ? t.numPeers : 0,
      seeds: t ? t.numPeers : 0, // webtorrent no distingue seed de peer
      totalDone: t ? t.downloaded : 0,
      totalSize: this.file ? this.file.length : 0,
      fileName: this.file ? this.file.name : '',
    }
    this.lastStatus = ev
    this.sendEvent('torrentProgress', ev)
  }

  async start({ url, season, episode } = {}) {
    await this.stop()
    if (!url || typeof url !== 'string') throw new Error('URL de torrent vacía')
    if (!/^magnet:/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new Error('Solo magnet: o URL http(s) de .torrent')
    }

    const client = await this._getClient()
    this.state = 'connecting'
    this._progress()
    this.timer = setInterval(() => this._progress(), PROGRESS_MS)

    let source = url
    if (!/^magnet:/i.test(url)) {
      const buf = await fetchTorrentFile(url)
      source = buf
    }

    const torrent = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Timeout buscando metadata del torrent (45s) — puede no tener seeds')), META_TIMEOUT_MS)
      let t
      try {
        t = client.add(source, { path: this.downloadDir })
      } catch (e) {
        clearTimeout(to)
        return reject(e)
      }
      t.once('ready', () => { clearTimeout(to); resolve(t) })
      t.once('error', (e) => { clearTimeout(to); reject(e instanceof Error ? e : new Error(String(e))) })
    })

    this.torrent = torrent
    this.state = 'metadata'

    const file = pickFile(torrent.files, { season, episode })
    if (!file) throw new Error('El torrent no contiene archivos')
    this.file = file
    // Prioriza este archivo y sus piezas bajo demanda; los demás no se bajan.
    torrent.files.forEach(f => { try { f.deselect() } catch { /* no-op */ } })
    file.select()

    await this._serve()
    this.state = 'downloading'
    this._progress()

    const fileIndex = torrent.files.indexOf(file)
    return {
      url: `http://127.0.0.1:${this.server.address().port}/stream`,
      fileName: file.name,
      sizeBytes: file.length,
      infoHash: torrent.infoHash,
      fileIndex,
      numFiles: torrent.files.length,
    }
  }

  _serve() {
    return new Promise((resolve, reject) => {
      const file = this.file
      const srv = http.createServer((req, res) => {
        if (!req.url.startsWith('/stream')) {
          res.writeHead(404); res.end('Not found'); return
        }
        const total = file.length
        const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
        let start = 0, end = total - 1
        let status = 200
        if (range && (range[1] || range[2])) {
          if (range[1]) start = parseInt(range[1], 10)
          if (range[2]) end = Math.min(parseInt(range[2], 10), total - 1)
          status = 206
        }
        if (start >= total || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` })
          res.end()
          return
        }
        const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || ''
        res.writeHead(status, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        if (req.method === 'HEAD') { res.end(); return }
        const stream = file.createReadStream({ start, end })
        stream.on('error', (e) => { try { res.destroy(e) } catch { /* cerrado */ } })
        res.on('close', () => { try { stream.destroy() } catch { /* no-op */ } })
        stream.pipe(res)
      })
      srv.once('error', reject)
      // Solo loopback — el stream va firmado por nada; no se expone a la LAN.
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv
        resolve()
      })
    })
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.server) {
      const s = this.server
      this.server = null
      await new Promise(r => s.close(r))
    }
    if (this.torrent) {
      const t = this.torrent
      this.torrent = null
      this.file = null
      await new Promise(r => t.destroy({ destroyStore: true }, r))
    }
    // Limpia el directorio de descarga si quedó.
    try { fs.rmSync(this.downloadDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    this.state = 'idle'
  }

  status() {
    return this.lastStatus || {
      state: this.state, progress: 0, downloadRate: 0, uploadRate: 0,
      peers: 0, seeds: 0, totalDone: 0, totalSize: 0, fileName: '',
    }
  }
}

module.exports = { TorrentEngine }
