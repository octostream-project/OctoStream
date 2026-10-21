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
  constructor({ sendEvent, downloadDir, offlineDir } = {}) {
    this.sendEvent = typeof sendEvent === 'function' ? sendEvent : () => {}
    this.downloadDir = downloadDir || path.join(os.tmpdir(), 'octostream-torrent')
    // Descargas offline: persistente (no temp). Main pasa ~/Downloads/OctoStream.
    this.offlineDir = offlineDir || path.join(os.homedir(), 'Downloads', 'OctoStream')
    this.client = null
    this.torrent = null
    this.file = null
    this.server = null
    this.timer = null
    this.state = 'idle'
    this.httpReq = null
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

  _addTorrent(client, source, { deselect = false, path: addPath } = {}) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Timeout buscando metadata del torrent (45s) — puede no tener seeds')), META_TIMEOUT_MS)
      let t
      try {
        t = client.add(source, { path: addPath || this.downloadDir, deselect })
      } catch (e) {
        clearTimeout(to)
        return reject(e)
      }
      // Si el torrent ya estaba añadido (reuse desde listFiles), 'ready' puede
      // no volver a disparar — comprobar el flag.
      if (t.ready) { clearTimeout(to); return resolve(t) }
      t.once('ready', () => { clearTimeout(to); resolve(t) })
      t.once('error', (e) => { clearTimeout(to); reject(e instanceof Error ? e : new Error(String(e))) })
    })
  }

  // Lista los archivos de vídeo sin descargar (deselect). El torrent queda
  // vivo en this.metaTorrent para que start() lo reutilice — sin esto el
  // picker de archivos pagaba el fetch de metadata del magnet dos veces.
  async listFiles({ url } = {}) {
    if (!url || typeof url !== 'string') throw new Error('URL de torrent vacía')
    if (!/^magnet:/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new Error('Solo magnet: o URL http(s) de .torrent')
    }
    const client = await this._getClient()
    if (this.metaTorrent && this.metaUrl !== url) {
      try { await new Promise(r => this.metaTorrent.destroy(r)) } catch { /* no-op */ }
      this.metaTorrent = null
    }
    let source = url
    if (!/^magnet:/i.test(url)) source = await fetchTorrentFile(url)
    const torrent = await this._addTorrent(client, source, { deselect: true })
    this.metaTorrent = torrent
    this.metaUrl = url
    return {
      files: torrent.files.map((f, i) => ({ index: i, name: f.path || f.name, size: f.length })),
      infoHash: torrent.infoHash,
      numFiles: torrent.files.length,
    }
  }

  async start({ url, season, episode, fileIndex } = {}) {
    // Reutilizar el torrent de listFiles (si el usuario eligió archivo):
    // stop() lo destruiría — guardarlo antes.
    const reuse = (this.metaTorrent && this.metaUrl === url) ? this.metaTorrent : null
    this.metaTorrent = null
    this.metaUrl = null
    await this.stop()
    if (!url || typeof url !== 'string') throw new Error('URL de torrent vacía')
    if (!/^magnet:/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new Error('Solo magnet: o URL http(s) de .torrent')
    }

    const client = await this._getClient()
    this.state = 'connecting'
    this._progress()
    this.timer = setInterval(() => this._progress(), PROGRESS_MS)

    let torrent
    if (reuse && !reuse.destroyed) {
      torrent = reuse
    } else {
      let source = url
      if (!/^magnet:/i.test(url)) {
        const buf = await fetchTorrentFile(url)
        source = buf
      }
      torrent = await this._addTorrent(client, source)
    }

    this.torrent = torrent
    this.state = 'metadata'

    const file = (fileIndex != null && torrent.files[fileIndex])
      ? torrent.files[fileIndex]
      : pickFile(torrent.files, { season, episode })
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

  // Descarga offline: misma superficie que el plugin Android — baja el
  // archivo elegido a offlineDir y el progreso sale por 'torrentProgress'.
  // Comparte el slot del motor con start().
  async download({ url, season, episode, fileIndex } = {}) {
    await this.stop()
    if (!url || typeof url !== 'string') throw new Error('URL de torrent vacía')
    if (!/^magnet:/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new Error('Solo magnet: o URL http(s) de .torrent')
    }
    const client = await this._getClient()
    let source = url
    if (!/^magnet:/i.test(url)) source = await fetchTorrentFile(url)
    const torrent = await this._addTorrent(client, source, { deselect: true, path: this.offlineDir })
    const file = (fileIndex != null && torrent.files[fileIndex])
      ? torrent.files[fileIndex]
      : pickFile(torrent.files, { season, episode })
    if (!file) throw new Error('El torrent no contiene archivos')
    torrent.files.forEach(f => { try { f.deselect() } catch { /* no-op */ } })
    file.select()

    this.torrent = torrent
    this.file = file
    this.state = 'downloading'
    this._progress()
    this.timer = setInterval(() => {
      if (this.file && this.file.downloaded >= this.file.length) this.state = 'finished'
      this._progress()
    }, PROGRESS_MS)

    return {
      name: file.path || file.name,
      path: path.join(this.offlineDir, file.path || file.name),
      sizeBytes: file.length,
      infoHash: torrent.infoHash,
      fileIndex: torrent.files.indexOf(file),
      complete: file.downloaded >= file.length,
    }
  }

  _walkVideos(dir, root, out) {
    let children
    try { children = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const c of children) {
      const p = path.join(dir, c.name)
      if (c.isDirectory()) { this._walkVideos(p, root, out); continue }
      if (!VIDEO_EXT.test(c.name)) continue
      let size = 0
      try { size = fs.statSync(p).size } catch { continue }
      if (size <= 0) continue
      out.push({ name: path.relative(root, p), path: p, size })
    }
  }

  // Carpeta de descarga elegida por el usuario (main persiste el path).
  setOfflineDir(dir) {
    if (dir && typeof dir === 'string') this.offlineDir = dir
    return { path: this.offlineDir }
  }

  listDownloads() {
    const files = []
    this._walkVideos(this.offlineDir, this.offlineDir, files)
    return { files }
  }

  // Descarga directa http(s): vídeo progresivo (mp4/mkv, debrid). Mismo
  // directorio y eventos 'torrentProgress' que la descarga torrent.
  async downloadHttp({ url, name, headers } = {}) {
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('url http(s) requerida')
    await this.stop()
    fs.mkdirSync(this.offlineDir, { recursive: true })

    const sanitize = (s) => (s || '').replace(/[\\/:*?"<>|]/g, ' ').trim().replace(/\s+/g, ' ')
    const baseOf = (u) => {
      try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || '') } catch { return '' }
    }
    let fname = sanitize(name) || sanitize(baseOf(url)) || 'video'
    const urlExt = (baseOf(url).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()
    const nameExt = (fname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()
    if (!nameExt || !VIDEO_EXT.test('x.' + nameExt)) {
      fname = fname.replace(/\.[^.]*$/, '') + '.' + (urlExt && VIDEO_EXT.test('x.' + urlExt) ? urlExt : 'mp4')
    }
    const out = path.join(this.offlineDir, fname)
    const part = out + '.part'
    const root = path.resolve(this.offlineDir)
    if (!path.resolve(out).startsWith(root + path.sep)) throw new Error('ruta fuera del directorio de descargas')

    const emit = (state, progress, done, total, rate) => {
      const ev = {
        state, progress, downloadRate: rate || 0, uploadRate: 0, peers: 0, seeds: 0,
        totalDone: done, totalSize: total, fileName: fname,
      }
      this.lastStatus = ev
      this.sendEvent('torrentProgress', ev)
    }

    const res = await new Promise((resolve, reject) => {
      const hop = (current, depth) => {
        if (depth > 5) return reject(new Error('demasiados redirects'))
        let u
        try { u = new URL(current) } catch { return reject(new Error('URL inválida')) }
        const lib = u.protocol === 'https:' ? https : http
        const req = lib.get({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          headers: { 'User-Agent': 'OctoStream/1.0', ...(headers || {}) },
          timeout: 30000,
        }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume()
            const loc = r.headers.location
            return hop(loc.startsWith('http') ? loc : new URL(loc, current).href, depth + 1)
          }
          if (r.statusCode < 200 || r.statusCode >= 300) {
            r.resume()
            return reject(new Error(`HTTP ${r.statusCode}`))
          }
          resolve(r)
        })
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
        this.httpReq = req
      }
      hop(url, 0)
    })

    this.httpReq = null
    this.httpRes = res
    const total = Number(res.headers['content-length'] || 0)
    const stat = fs.existsSync(out) ? fs.statSync(out) : null
    if (stat && total > 0 && stat.size === total) {
      res.resume()
      return { name: fname, path: out, sizeBytes: stat.size, complete: true }
    }
    try { fs.rmSync(out, { force: true }); fs.rmSync(part, { force: true }) } catch { /* no-op */ }

    emit('downloading', 0, 0, total, 0)
    this.state = 'downloading'

    const done = await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(part)
      let bytes = 0, lastEmit = 0, lastBytes = 0
      res.on('data', (c) => {
        bytes += c.length
        const now = Date.now()
        if (now - lastEmit >= 1000) {
          emit('downloading', total ? Math.min(bytes / total, 1) : 0, bytes, total,
            Math.round((bytes - lastBytes) * 1000 / Math.max(now - lastEmit, 1)))
          lastEmit = now; lastBytes = bytes
        }
      })
      res.on('error', (e) => { ws.destroy(); reject(e) })
      ws.on('error', reject)
      ws.on('finish', () => resolve(bytes))
      res.pipe(ws)
    })
    this.httpRes = null
    if (total > 0 && done < total) {
      try { fs.rmSync(part, { force: true }) } catch { /* no-op */ }
      throw new Error(`descarga incompleta: ${done} de ${total}`)
    }
    fs.renameSync(part, out)
    this.state = 'finished'
    emit('finished', 1, done, Math.max(total, done), 0)
    return { name: fname, path: out, sizeBytes: done, complete: false }
  }

  deleteDownload({ path: p } = {}) {
    if (!p || typeof p !== 'string') throw new Error('path requerido')
    const root = path.resolve(this.offlineDir)
    const target = path.resolve(p)
    if (!target.startsWith(root + path.sep)) throw new Error('ruta fuera del directorio de descargas')
    let deleted = false
    try { deleted = fs.existsSync(target) && (fs.rmSync(target), true) } catch { /* no-op */ }
    // Limpiar carpetas vacías del pack.
    let parent = path.dirname(target)
    while (parent !== root && parent.startsWith(root)) {
      try { if (fs.readdirSync(parent).length) break; fs.rmdirSync(parent) } catch { break }
      parent = path.dirname(parent)
    }
    return { deleted }
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.httpReq) { try { this.httpReq.destroy() } catch { /* no-op */ } this.httpReq = null }
    if (this.httpRes) { try { this.httpRes.destroy() } catch { /* no-op */ } this.httpRes = null }
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
    // Torrent "sólo metadata" dejado por un listFiles cuyo start nunca llegó.
    if (this.metaTorrent) {
      const m = this.metaTorrent
      this.metaTorrent = null
      this.metaUrl = null
      try { await new Promise(r => m.destroy(r)) } catch { /* no-op */ }
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
