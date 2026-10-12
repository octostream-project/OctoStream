// Port a Node del plugin Android SyncServer (capacitor-plugins/sync-server).
// Mismo protocolo para que Windows/Linux se comporten como un OctoStream
// más en la LAN: HTTP :8765 (/ping, /pair, /sync, /play, /stop), auth por
// X-Device-Id + X-Pair-Token, y descubrimiento UDP :8766 por multicast
// 239.255.60.60 + broadcast 255.255.255.255 (estilo LocalSend).
'use strict'

const http = require('http')
const dgram = require('dgram')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = 8765
const DISC_PORT = 8766
const DISC_GROUP = '239.255.60.60'
const ANNOUNCE_MS = 2500
const DISC_TTL_MS = 20000
const REPLY_MIN_MS = 45000
const MAX_BODY = 4 * 1024 * 1024

const ALIAS_ADJ = [
  'Sabio', 'Veloz', 'Curioso', 'Valiente', 'Tranquilo', 'Alegre',
  'Astuto', 'Noble', 'Sereno', 'Agil', 'Amable', 'Brillante',
  'Audaz', 'Dormilon', 'Fiel', 'Inquieto',
]
const ALIAS_ANIMAL = [
  'Pulpo', 'Calamar', 'Medusa', 'Delfin', 'Orca', 'Ballena',
  'Cangrejo', 'Tortuga', 'Tiburon', 'Mantarraya', 'Foca',
  'Caballito', 'Erizo', 'Estrella', 'Camaron', 'Pez Luna',
]

const randomHex = (len) => crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)

function fingerprintOf(secret) {
  const hex = crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4)}`
}

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return '127.0.0.1'
}

// Anti-CSRF idéntico al plugin Java: cliente nativo (sin Origin) o origen
// local (capacitor/localhost/IP privada literal). Otros orígenes → rechazo.
function isPrivateIpLiteral(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const p = h.split('.')
  if (p.length !== 4 || p.some(o => !/^\d{1,3}$/.test(o) || +o > 255)) return false
  const [a, b] = p.map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254)
}

function isLocalOrigin(origin) {
  if (!origin) return true
  const o = String(origin).toLowerCase()
  if (o.startsWith('capacitor://') || o.startsWith('ionic://')) return true
  let host
  try { host = new URL(o).hostname } catch { return false }
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isPrivateIpLiteral(host)
}

class SyncServer {
  // dataDir: donde persistir identidad + emparejados (userData en Electron).
  // sendEvent(name, data): eventos hacia el renderer (pairRequest, playReceived…).
  constructor({ dataDir, sendEvent }) {
    this.dataDir = dataDir || os.tmpdir()
    this.sendEvent = typeof sendEvent === 'function' ? sendEvent : () => {}
    this.stateFile = path.join(this.dataDir, 'sync-state.json')
    this.localData = null
    this.receivedData = null
    this.pairedDevices = new Map()   // deviceId → {alias, fingerprint, token, ts}
    this.pendingPairs = new Map()    // deviceId → {ip, alias, fingerprint, ts}
    this.deniedDevices = new Set()
    this.allowedIps = new Set()      // whitelist legacy por IP
    this.deniedIps = new Set()
    this.pairCooldown = new Map()    // ip → ts (anti-spam 30s)
    this.discovered = new Map()      // deviceId → anuncio + ts
    this.repliedAt = new Map()       // deviceId → ts
    this.server = null
    this.discSocket = null
    this.announceTimer = null
    this._loadState()
  }

  _loadState() {
    let st = {}
    try { st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } catch {}
    const id = st.identity || {}
    if (!id.deviceId || !id.alias || !id.secret) {
      this.deviceId = crypto.randomUUID()
      this.deviceAlias = ALIAS_ANIMAL[crypto.randomInt(ALIAS_ANIMAL.length)]
        + ' ' + ALIAS_ADJ[crypto.randomInt(ALIAS_ADJ.length)]
      this.deviceSecret = randomHex(32)
    } else {
      this.deviceId = id.deviceId
      this.deviceAlias = id.alias
      this.deviceSecret = id.secret
    }
    this.deviceFingerprint = fingerprintOf(this.deviceSecret)
    for (const [k, v] of Object.entries(st.paired || {})) {
      this.pairedDevices.set(k, v)
    }
    for (const ip of st.allowedIps || []) this.allowedIps.add(ip)
    this._saveState()
  }

  _saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify({
        identity: {
          deviceId: this.deviceId, alias: this.deviceAlias, secret: this.deviceSecret,
        },
        paired: Object.fromEntries(this.pairedDevices),
        allowedIps: [...this.allowedIps],
      }))
    } catch {}
  }

  _isAuthorized(req) {
    const devId = req.headers['x-device-id']
    const token = req.headers['x-pair-token']
    if (devId && token) {
      const d = this.pairedDevices.get(devId)
      if (d && d.token === token) return true
    }
    return this.allowedIps.has(this._remoteIp(req))
  }

  _remoteIp(req) {
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  }

  // Avisa al renderer de que un dispositivo no emparejado quiere interactuar
  // (cooldown anti-spam por IP como en el plugin Java).
  _notifyPairRequest(ip, endpoint, data, extra) {
    const now = Date.now()
    const last = this.pairCooldown.get(ip)
    if (last && now - last < 30000 && !extra) return
    this.pairCooldown.set(ip, now)
    this.sendEvent('pairRequest', { ip, endpoint, ...(data != null ? { data } : {}), ...(extra || {}) })
  }

  _json(res, status, obj, origin, open) {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': open ? '*' : (origin || 'null'),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Pair-Token',
      ...(open ? {} : { Vary: 'Origin' }),
    })
    res.end(body)
  }

  _serve(req, res) {
    const uri = req.url.split('?')[0]
    const method = req.method
    const origin = req.headers.origin
    const open = uri === '/ping' // descubrimiento: no expone datos sensibles

    if (!open && !isLocalOrigin(origin)) {
      this._json(res, 403, { ok: false, badOrigin: true }, origin)
      return
    }
    if (method === 'OPTIONS') {
      this._json(res, 200, {}, origin, open)
      return
    }
    const remoteIp = this._remoteIp(req)

    if (uri === '/pair' && method === 'POST') {
      this._readBody(req, res, (body) => {
        let j
        try { j = JSON.parse(body) } catch { j = null }
        const devId = j?.deviceId
        if (!devId) { this._json(res, 400, { ok: false }, origin); return }
        const known = this.pairedDevices.get(devId)
        if (known) {
          this._json(res, 200, {
            ok: true, token: known.token,
            deviceId: this.deviceId, alias: this.deviceAlias, fingerprint: this.deviceFingerprint,
          }, origin)
        } else if (this.deniedDevices.has(devId)) {
          this._json(res, 403, { ok: false, denied: true }, origin)
        } else {
          if (!this.pendingPairs.has(devId)) {
            const now = Date.now()
            for (const [k, v] of this.pendingPairs) {
              if (now - (v.ts || 0) > 120000) this.pendingPairs.delete(k)
            }
            if (this.pendingPairs.size < 64) {
              this.pendingPairs.set(devId, {
                ip: remoteIp, alias: j.alias || '', fingerprint: j.fingerprint || '', ts: now,
              })
              this._notifyPairRequest(remoteIp, 'pair', null,
                { deviceId: devId, alias: j.alias || '', fingerprint: j.fingerprint || '' })
            }
          }
          this._json(res, 202, { ok: false, pending: true }, origin)
        }
      })
      return
    }
    if (uri === '/sync' && method === 'GET') {
      if (!this._isAuthorized(req)) {
        if (!this.deniedIps.has(remoteIp)) this._notifyPairRequest(remoteIp, 'sync', null)
        this._json(res, 403, { ok: false, needsPair: true }, origin)
        return
      }
      this._json(res, 200, JSON.parse(this.localData || '{}'), origin)
      return
    }
    if (uri === '/sync' && method === 'POST') {
      this._readBody(req, res, (body) => {
        if (!this._isAuthorized(req)) {
          if (!this.deniedIps.has(remoteIp)) this._notifyPairRequest(remoteIp, 'sync', body)
          this._json(res, 403, { ok: false, needsPair: true }, origin)
          return
        }
        this.receivedData = body
        this.sendEvent('syncDataReceived', { data: body })
        this._json(res, 200, { ok: true }, origin)
      })
      return
    }
    if (uri === '/play' && method === 'POST') {
      this._readBody(req, res, (body) => {
        if (!this._isAuthorized(req)) {
          // El body viaja en el evento: si el usuario acepta, el renderer lo
          // reproduce directamente sin reintento del emisor.
          if (!this.deniedIps.has(remoteIp)) this._notifyPairRequest(remoteIp, 'play', body)
          this._json(res, 403, { ok: false, needsPair: true }, origin)
          return
        }
        try {
          const j = JSON.parse(body)
          this.sendEvent('playReceived', {
            url: j.url || '', title: j.title || '', type: j.type || 'hls',
            mode: j.mode || 'live', imdbId: j.imdbId || '',
            season: j.season || 0, episode: j.episode || 0,
          })
        } catch {}
        this._json(res, 200, { ok: true }, origin)
      })
      return
    }
    if (uri === '/stop' && method === 'POST') {
      if (!this._isAuthorized(req)) {
        this._json(res, 403, { ok: false, needsPair: true }, origin) // sin prompt
        return
      }
      this.sendEvent('stopReceived', {})
      this._json(res, 200, { ok: true }, origin)
      return
    }
    if (uri === '/ping' && method === 'GET') {
      this._json(res, 200, {
        ok: true, name: this.deviceAlias, alias: this.deviceAlias,
        deviceId: this.deviceId, fingerprint: this.deviceFingerprint,
        model: `${os.type()} ${os.hostname()}`.slice(0, 80), port: PORT,
      }, origin, true)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }

  _readBody(req, res, cb) {
    let len = 0
    const chunks = []
    req.on('data', (c) => {
      len += c.length
      if (len > MAX_BODY) {
        res.writeHead(413); res.end('Body too large'); req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (len <= MAX_BODY) cb(Buffer.concat(chunks).toString('utf8')) })
  }

  // ── Descubrimiento UDP ──────────────────────────────────────────────────

  _announcement() {
    return Buffer.from(JSON.stringify({
      app: 'octostream', v: 1,
      deviceId: this.deviceId, alias: this.deviceAlias,
      fingerprint: this.deviceFingerprint, port: PORT,
    }))
  }

  _startDiscovery() {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this.discSocket = sock
      sock.on('error', (e) => console.warn('[Sync] discovery socket:', e.message))
      sock.on('message', (msg, rinfo) => this._onAnnounce(msg, rinfo))
      sock.bind(DISC_PORT, () => {
        try {
          sock.setBroadcast(true)
          // Unirse al grupo en cada interfaz IPv4 utilizable.
          for (const list of Object.values(os.networkInterfaces())) {
            for (const ni of list || []) {
              if (ni.family === 'IPv4' && !ni.internal) {
                try { sock.addMembership(DISC_GROUP, ni.address) } catch {}
              }
            }
          }
          try { sock.addMembership(DISC_GROUP) } catch {}
        } catch {}
      })
      const payload = this._announcement()
      const send = () => {
        if (!this.discSocket) return
        for (const target of [DISC_GROUP, '255.255.255.255']) {
          try { this.discSocket.send(payload, DISC_PORT, target) } catch {}
        }
      }
      send()
      this.announceTimer = setInterval(send, ANNOUNCE_MS)
    } catch (e) {
      console.warn('[Sync] discovery start:', e.message)
    }
  }

  _stopDiscovery() {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null }
    if (this.discSocket) { try { this.discSocket.close() } catch {} ; this.discSocket = null }
  }

  _onAnnounce(msg, rinfo) {
    let j
    try { j = JSON.parse(msg.toString('utf8')) } catch { return }
    if (j?.app !== 'octostream') return
    const devId = j.deviceId
    if (!devId || devId === this.deviceId) return
    const d = {
      deviceId: devId, alias: j.alias || '', fingerprint: j.fingerprint || '',
      ip: rinfo.address, port: j.port || PORT,
      url: `http://${rinfo.address}:${j.port || PORT}`,
      ts: Date.now(),
    }
    const isNew = !this.discovered.has(devId)
    this.discovered.set(devId, d)
    if (isNew) this.sendEvent('deviceFound', d)
    // Respuesta dirigida una vez por dispositivo (o cada 45s): acelera el
    // descubrimiento mutuo sin tormenta de paquetes.
    const now = Date.now()
    const last = this.repliedAt.get(devId)
    if (this.repliedAt.size > 256) {
      for (const [k, v] of this.repliedAt) if (now - v > 120000) this.repliedAt.delete(k)
    }
    if (!last || now - last > REPLY_MIN_MS) {
      this.repliedAt.set(devId, now)
      try { this.discSocket?.send(this._announcement(), DISC_PORT, rinfo.address) } catch {}
    }
  }

  // ── API pública (mismo contrato que los @PluginMethod del Java) ─────────

  async start() {
    if (!this.server) {
      this.server = http.createServer((req, res) => this._serve(req, res))
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(PORT, '0.0.0.0', resolve)
      })
    }
    this._startDiscovery()
    return this.getIpAddress()
  }

  async stop() {
    this._stopDiscovery()
    if (this.server) {
      const s = this.server
      this.server = null
      await new Promise((r) => s.close(r))
    }
  }

  getIpAddress() {
    const ip = localIp()
    return {
      ip, port: PORT, url: `http://${ip}:${PORT}`,
      deviceId: this.deviceId, alias: this.deviceAlias, fingerprint: this.deviceFingerprint,
    }
  }

  getDeviceInfo() { return this.getIpAddress() }

  setLocalData({ data }) { this.localData = typeof data === 'string' ? data : '{}' }

  getReceivedData() { return { data: this.receivedData || '{}' } }

  clearReceivedData() { this.receivedData = null }

  allowDevice({ ip, allow = true }) {
    if (!ip) return
    if (allow) { this.deniedIps.delete(ip); this.allowedIps.add(ip) }
    else this.deniedIps.add(ip)
    this._saveState()
  }

  answerPair({ deviceId, allow = true }) {
    if (!deviceId) return
    const pp = this.pendingPairs.get(deviceId)
    this.pendingPairs.delete(deviceId)
    if (allow) {
      this.pairedDevices.set(deviceId, {
        alias: pp?.alias || '', fingerprint: pp?.fingerprint || '',
        token: randomHex(24), ts: Date.now(),
      })
      this._saveState()
    } else {
      this.deniedDevices.add(deviceId)
    }
  }

  getPairedDevices() {
    const devices = []
    for (const [deviceId, d] of this.pairedDevices) {
      devices.push({ deviceId, alias: d.alias || '', fingerprint: d.fingerprint || '' })
    }
    for (const ip of this.allowedIps) devices.push({ ip })
    return { devices }
  }

  forgetDevices() {
    this.allowedIps.clear()
    this.deniedIps.clear()
    this.pairedDevices.clear()
    this.deniedDevices.clear()
    this._saveState()
  }

  getDiscoveredDevices() {
    const now = Date.now()
    const devices = []
    for (const [devId, d] of this.discovered) {
      if (now - d.ts > DISC_TTL_MS) { this.discovered.delete(devId); continue }
      devices.push(d)
    }
    return { devices }
  }
}

module.exports = { SyncServer, PORT, DISC_PORT, DISC_GROUP }
