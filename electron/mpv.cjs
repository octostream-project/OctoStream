// Reproductor nativo de escritorio vía mpv + JSON IPC — paridad ExoPlayer.
//
// Los bindings de libvlc para Node están abandonados (WebChimera/NW.js, ~2018)
// y el vlc.js wasm es experimental; mpv expone --input-ipc-server (socket de
// líneas JSON) que es la vía estándar (Stremio, SMPlayer, Jellyfin Desktop).
// Reproduce todo lo que ExoPlayer cubre y más (mkv/AC3/DTS/HEVC sin remux),
// salvo DRM Widevine — esos streams siguen en el player web (shaka).
//
// Contrato de eventos (espejo del playbackState del plugin Android):
//   {state:'ready'|'playing'|'paused'|'buffering'|'idle'|'position'|'ended'|
//          'closed'|'error', position?, duration?, message?, errorCode?}
// y zapping (teclas PgUp/PgDn o botones OSD bindeados por `keybind`):
//   {state:'zap', index, direction, name} — mismo shape que channelZap.
//
// El binario se busca en: resources/mpv/ (empaquetado) → OCTOSTREAM_MPV →
// rutas habituales del sistema.
//
// OJO con las cabeceras HTTP: ffmpeg PLIEGA (obs-fold) cualquier línea de
// http-header-fields >~80 chars y servidores/CDN estrictos (Fastly,
// llhttp de Node) responden 400 sin evaluar el request. Por eso
// User-Agent/Referer van por las propiedades dedicadas `user-agent` /
// `referrer`, que viajan sin plegar — ver _applyOpts().

const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const POSITION_EVENT_MS = 5000 // mismo intervalo que el 'position' de ExoPlayer

function hostOf(u) { try { return new URL(u).host } catch { return '?' } }

function mpvCandidates() {
  // Empaquetado por scripts/fetch-mpv.mjs → resources/mpv/<plat>-<arch>/:
  // en Linux es el árbol squashfs extraído (AppRun = sharun estático, sin
  // FUSE); en Windows mpv.exe auto-contenido. El path build/mpv cubre dev.
  const platDir = `${process.platform}-${process.arch}` // linux-x64, win32-x64
  const exeName = process.platform === 'win32' ? 'mpv.exe' : 'AppRun'
  const bundled = []
  if (process.resourcesPath) bundled.push(path.join(process.resourcesPath, 'mpv', platDir, exeName))
  bundled.push(path.join(__dirname, '..', 'build', 'mpv', platDir, exeName))
  if (process.env.OCTOSTREAM_MPV) bundled.unshift(process.env.OCTOSTREAM_MPV)
  if (process.platform === 'win32') {
    return [...bundled, 'mpv', 'mpv.exe',
      'C:\\Program Files\\mpv\\mpv.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe')]
  }
  return [...bundled, 'mpv', '/usr/bin/mpv', '/usr/local/bin/mpv',
    '/snap/bin/mpv', '/var/lib/flatpak/exports/bin/io.mpv.Mpv']
}

let cachedExe = null
function findMpv() {
  if (cachedExe !== null) return cachedExe || null
  for (const c of mpvCandidates()) {
    try {
      if (c.includes(path.sep) || c.includes('/')) {
        if (fs.existsSync(c)) { cachedExe = c; return c }
      } else {
        cachedExe = c; return c // nombre desnudo: spawn lo resuelve por PATH
      }
    } catch {}
  }
  cachedExe = ''
  return null
}

function socketPath(tag = 'mpv') {
  const id = `octo-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${id}`
    : path.join(os.tmpdir(), `${id}.sock`)
}

// El OSC propio (octo-osc.lua, controles estilo ExoPlayer Android) vive en el
// árbol fuente / dentro del asar; mpv solo lee de disco real → se extrae a
// tmp al primer uso y se re-copia si cambia el contenido. --scripts-append
// con directorio busca main.*, así que se pasa el archivo exacto.
let oscFileCached = null
function ensureOscScript() {
  if (oscFileCached) return oscFileCached
  try {
    const src = path.join(__dirname, 'mpv-osc.lua')
    const dir = path.join(os.tmpdir(), 'octo-mpv-scripts')
    const dst = path.join(dir, 'octo-osc.lua')
    const body = fs.readFileSync(src)
    let same = false
    try { same = fs.readFileSync(dst).equals(body) } catch {}
    if (!same) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(dst, body)
    }
    oscFileCached = dst
    return dst
  } catch (e) {
    console.warn('[Mpv] no se pudo extraer el OSC:', e?.message)
    return null
  }
}

// Sesión IPC con un proceso mpv: conexión persistente, request_id↔respuesta
// y eventos (property-change/end-file/client-message) hacia el renderer.
class MpvSession {
  constructor(exe, onEvent, onExit) {
    this.exe = exe
    this.onEvent = onEvent // (ev) => void — eventos hacia el renderer
    this.onExit = onExit || (() => {})
    this.proc = null
    this.sock = null
    this.sockPath = null
    this.reqSeq = 0
    this.pending = new Map() // request_id → {resolve, reject}
    this.buf = ''
    this.running = false
    this.posTimer = null
    this.lastPos = 0
    this.duration = 0
    this.channels = null
    this.channelIndex = -1
    this.ended = false
    this.closing = false
    this._sid = Math.random().toString(36).slice(2, 6)
    this._oscReady = false
    this._oscQueue = null
    this.headless = process.env.OCTO_MPV_HEADLESS === '1' // tests sin display
  }

  _emit(ev) {
    if (ev.state !== 'position' && ev.state !== 'playing') {
      console.log('[Mpv] emit', this._sid, ev.state, ev.message || '')
    }
    try { this.onEvent(ev) } catch {}
  }

  _spawn(extraArgs = []) {
    this.sockPath = socketPath()
    // OSC propio (estilo ExoPlayer Android) en lugar del stock: se carga
    // siempre — embebido o ventana flotante — para la misma UI en ambos.
    const oscFile = ensureOscScript()
    const args = [
      '--idle=yes',
      '--keep-open=yes', // quedarse al final del fichero → end-file, no quit
      '--keep-open-pause=no',
      ...(this.embedWid
        ? [`--wid=${this.embedWid}`]
        : [this.headless ? '--force-window=no' : '--force-window=yes']),
      '--osc=no',
      ...(oscFile ? [`--scripts-append=${oscFile}`] : []),
      // Embebido: input por DOS vías posibles según la plataforma — si la
      // ventana hija de mpv selecciona eventos, el OSC los procesa
      // nativamente; si no, propagan al DOM y el renderer los reenvía por
      // IPC (mouse/keypress). Cada evento va a una sola ventana, así que no
      // hay doble procesado. Solo se desactivan los bindings POR DEFECTO
      // (evitarían que space/arrows actuaran dos veces cuando mpv sí
      // recibe teclado); los keybind propios (Esc, PgUp/PgDn) y el OSC
      // siguen activos.
      ...(this.embedWid ? ['--input-default-bindings=no'] : []),
      '--cursor-autohide=1500',
      `--input-ipc-server=${this.sockPath}`,
      '--input-terminal=no',
      '--term-status-msg=',
      // Depuración opcional: OCTO_MPV_LOG=1 vuelca el log de mpv a /tmp,
      // UN archivo por sesión — con el pid de Electron compartido, dos
      // sesiones simultáneas (StrictMode/zapping) se sobrescriben el log.
      ...(process.env.OCTO_MPV_LOG ? [`--log-file=${path.join(os.tmpdir(), `${path.basename(this.sockPath, '.sock')}.log`)}`] : []),
      ...extraArgs,
    ]
    // extraResources conserva el modo de archivo, pero por si el paquete
    // pierde el bit +x (zip manual, filesystem raro) se fuerza aquí.
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.exe, 0o755) } catch {}
    }
    const proc = spawn(this.exe, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    this.proc = proc
    proc.on('error', () => this._die('error'))
    proc.on('exit', () => this._die('closed'))
    return proc
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 4000
      const attempt = () => {
        if (this.closing || !this.proc) return reject(new Error('mpv cerrado'))
        const s = net.createConnection(this.sockPath)
        s.once('connect', () => {
          s.removeAllListeners('error')
          this.sock = s
          s.on('data', d => this._onData(d))
          s.on('error', () => {})
          s.on('close', () => { this.sock = null; if (!this.closing) this._die('closed') })
          resolve()
        })
        s.once('error', () => {
          s.destroy()
          if (Date.now() > deadline) reject(new Error('mpv IPC timeout'))
          else setTimeout(attempt, 80)
        })
      }
      attempt()
    })
  }

  _onData(d) {
    this.buf += d.toString('utf8')
    let nl
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this._onLine(line)
    }
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.request_id != null) {
      const p = this.pending.get(msg.request_id)
      if (p) {
        this.pending.delete(msg.request_id)
        if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error))
        else p.resolve(msg.data)
      }
      return
    }
    this._onMpvEvent(msg)
  }

  _onMpvEvent(msg) {
    // Sesión muriendo (close() propio o reemplazo por otra): mpv emite
    // end-file reason=error ("loading failed") al matar una carga en curso.
    // Ese error es ESPURIO — si llega al renderer, el listener de la sesión
    // nueva recibe un 'error' fantasma y ejecuta stopPlayback() matando la
    // reproducción buena. Todo evento post-close se descarta.
    if (this.closing) return
    const ev = msg.event
    if (ev === 'property-change') {
      if (msg.name === 'time-pos' && typeof msg.data === 'number') {
        this.lastPos = msg.data
      } else if (msg.name === 'duration' && typeof msg.data === 'number') {
        this.duration = msg.data
      } else if (msg.name === 'pause') {
        if (msg.data === true) this._emit({ state: 'paused', position: this.lastPos * 1000, duration: this.duration * 1000 })
        else this._emit({ state: 'playing', position: this.lastPos * 1000, duration: this.duration * 1000 })
      } else if (msg.name === 'user-data/octo-osc-ready') {
        this._oscReady = true
        this._flushOsc()
      } else if (msg.name === 'paused-for-cache') {
        // buffering = esperando datos de red — el watchdog de torrents de
        // VideoPlayer usa este estado igual que en Android. core-idle se
        // omite a propósito: salta en seeks y micro-lecturas y marcaba
        // stalls falsos.
        if (msg.data === true) this._emit({ state: 'buffering' })
        else this._emit({ state: 'ready' })
      }
      return
    }
    if (ev === 'file-loaded') {
      this.ended = false
      this._emit({ state: 'ready' })
      return
    }
    if (ev === 'end-file') {
      if (msg.reason === 'eof') {
        this.ended = true
        this._emit({ state: 'ended', position: this.duration * 1000, duration: this.duration * 1000 })
      } else if (msg.reason === 'error') {
        this._emit({ state: 'error', message: msg.file_error || 'error de reproducción' })
      }
      return
    }
    if (ev === 'client-message') {
      // keybind PGUP/PGDW o botones del OSC → script-message octo-zap <dir>.
      const args = msg.args || []
      if (args[0] === 'octo-zap' && this.channels?.length) {
        const dir = Number(args[1]) || 1
        const n = this.channels.length
        this.channelIndex = ((this.channelIndex < 0 ? 0 : this.channelIndex) + dir + n) % n
        this._emit({
          state: 'zap', index: this.channelIndex, direction: dir,
          name: this.channels[this.channelIndex]?.name || '',
        })
        return
      }
      // Acciones de app pedidas por el OSC: close, subs, subpick <i>,
      // channels, zapto <i>, episodes, eppick <i>, next-ep, cast, fullscreen.
      if (args[0] === 'octo-action') {
        this._emit({ state: 'osc', action: args[1] || '', arg: args[2] })
      }
      return
    }
    if (ev === 'video-reconfig') return
    if (ev === 'seek') { this._emit({ state: 'buffering' }); return }
  }

  _cmd(...command) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('mpv no conectado'))
      const request_id = ++this.reqSeq
      this.pending.set(request_id, { resolve, reject })
      this.sock.write(JSON.stringify({ command, request_id }) + '\n')
      setTimeout(() => {
        if (this.pending.delete(request_id)) reject(new Error('mpv cmd timeout'))
      }, 8000).unref?.()
    })
  }

  _headersOption(headers) {
    // mpv espera "K: V" separados por \n en http-header-fields.
    // ffmpeg PLIEGA cualquier línea >~80 chars en el wire (obs-fold
    // deprecado): Fastly, llhttp de Node y otros CDN responden 400 sin
    // ni siquiera evaluar el request — líneas largas se descartan aquí.
    const safe = Object.entries(headers || {})
      .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v))
      .map(([k, v]) => `${k}: ${v.replace(/\r?\n/g, ' ')}`)
      .filter((line) => {
        if (line.length <= 76) return true
        console.warn('[Mpv] header demasiado largo, descartado:', line.slice(0, 40) + '…')
        return false
      })
    return safe.join('\r\n')
  }

  async open(opts = {}) {
    this.channels = opts.channels || null
    this.channelIndex = opts.channelIndex ?? -1
    this.embedWid = Number.isFinite(opts.wid) && opts.wid > 0 ? Math.floor(opts.wid) : 0
    this._spawn()
    try {
      await this._connect()
    } catch (e) {
      this.close()
      return { status: 'unavailable', error: e.message }
    }
    this.running = true
    // Observadores de estado — los mismos estados que emite ExoPlayer.
    await this._cmd('observe_property', 1, 'time-pos').catch(() => {})
    await this._cmd('observe_property', 2, 'duration').catch(() => {})
    await this._cmd('observe_property', 3, 'pause').catch(() => {})
    await this._cmd('observe_property', 4, 'paused-for-cache').catch(() => {})
    // Handshake con el OSC: octo-osc.lua marca user-data/octo-osc-ready al
    // terminar de cargar. script-message-to a un script aún no registrado
    // responde "Can't find script" y el estado se pierde — los oscPush se
    // encolan hasta la marca (los eventos de una sesión moribunda también
    // pueden llegar tarde; la cola solo sale por la sesión que la pidió).
    await this._cmd('observe_property', 9, 'user-data/octo-osc-ready').catch(() => {})
    // Posición para la reanudación, en el intervalo del 'position' de Android.
    this.posTimer = setInterval(() => {
      if (this.lastPos > 0) {
        this._emit({ state: 'position', position: this.lastPos * 1000, duration: this.duration * 1000 })
      }
    }, POSITION_EVENT_MS)
    this.posTimer.unref?.()
    // Keybinds de zapping (PGUP/PGDWN: saltan a canal previo/siguiente) y
    // Esc → quit (paridad con el botón atrás de Android: cierra el player
    // y vuelve a la ficha — el evento 'closed' dispara onClose en la app).
    await this._cmd('keybind', 'PGUP', 'script-message octo-zap -1').catch(() => {})
    await this._cmd('keybind', 'PGDWN', 'script-message octo-zap 1').catch(() => {})
    await this._cmd('keybind', 'ESC', 'quit').catch(() => {})
    await this._applyOpts(opts)
    this._loadUrl(opts)
    return { status: 'playing' }
  }

  async _applyOpts(opts) {
    // User-Agent y Referer NO pueden ir por http-header-fields: ffmpeg
    // pliega líneas >~80 chars y el servidor responde 400 (el UA de los
    // resolvers supera ese límite). Van por las propiedades dedicadas de
    // mpv, que viajan sin plegar.
    const headers = { ...(opts.headers || {}) }
    const ua = headers['User-Agent'] || headers['user-agent'] || opts.userAgent
    const ref = headers['Referer'] || headers['referer'] || opts.referer
    delete headers['User-Agent']; delete headers['user-agent']
    delete headers['Referer']; delete headers['referer']
    if (ua && !/[\r\n]/.test(ua)) await this._cmd('set_property', 'user-agent', String(ua)).catch(() => {})
    if (ref && !/[\r\n]/.test(ref)) await this._cmd('set_property', 'referrer', String(ref)).catch(() => {})
    const hdrs = this._headersOption(headers)
    if (hdrs) await this._cmd('set_property', 'http-header-fields', hdrs).catch(() => {})
    if (opts.title) await this._cmd('set_property', 'force-media-title', String(opts.title)).catch(() => {})
  }

  _loadUrl(opts = {}) {
    const optsStr = []
    if (opts.startSec > 0) optsStr.push(`start=${Math.floor(opts.startSec)}`)
    const cmd = ['loadfile', opts.url, 'replace', -1, optsStr.join(',')]
    this._cmd(...cmd).catch(() => {})
    // Subtítulos side-load (URLs del proveedor / OpenSubtitles temporales).
    for (const sub of opts.subtitles || []) {
      if (sub?.url) this._cmd('sub-add', sub.url, 'auto', sub.label || sub.lang || '', sub.lang || '').catch(() => {})
    }
    this.ended = false
    this.lastPos = 0
    this.duration = 0
    console.log('[Mpv] play →', hostOf(opts.url))
  }

  async switch(opts = {}) {
    if (!this.running) return this.open(opts)
    if (opts.channelIndex != null) this.channelIndex = opts.channelIndex
    await this._applyOpts(opts)
    this._loadUrl(opts)
    return { status: 'playing' }
  }

  setChannels(channels, channelIndex) {
    this.channels = channels || null
    if (channelIndex != null) this.channelIndex = channelIndex
  }

  pause() { this.running && this._cmd('set_property', 'pause', true).catch(() => {}) }
  resume() { this.running && this._cmd('set_property', 'pause', false).catch(() => {}) }
  seek(sec) { this.running && this._cmd('seek', sec, 'absolute').catch(() => {}) }
  setRate(r) { this.running && this._cmd('set_property', 'speed', r).catch(() => {}) }
  setVolume(v) { this.running && this._cmd('set_property', 'volume', v).catch(() => {}) }
  setMute(m) { this.running && this._cmd('set_property', 'mute', !!m).catch(() => {}) }
  showText(t) { this.running && this._cmd('show-text', String(t || ''), 3000).catch(() => {}) }
  // Subtítulo descargado por la app (OpenSubtitles): la ruta llega ya a disco.
  addSubtitle(filePath, label, lang) {
    if (this.running) this._cmd('sub-add', filePath, 'select', label || '', lang || '').catch(() => {})
  }
  setSubDelay(sec) { this.running && this._cmd('set_property', 'sub-delay', sec).catch(() => {}) }
  subOff() { this.running && this._cmd('set_property', 'sid', 'no').catch(() => {}) }
  // Input reenviado por el renderer cuando mpv está embebido (--wid): el
  // hijo X11 no recibe teclado/ratón, todo entra como comandos.
  mouse(x, y) {
    if (this.running && Number.isFinite(x) && Number.isFinite(y)) {
      this._cmd('mouse', Math.round(x), Math.round(y)).catch(() => {})
    }
  }
  key(name) {
    if (this.running && /^[A-Z0-9_+ -]+$/i.test(String(name || ''))) {
      this._cmd('keypress', String(name)).catch(() => {})
    }
  }
  // Empujar estado/menús al OSC: script-message-to octo_osc state|menu <json>
  // (mpv deriva el nombre del script del archivo: octo-osc.lua → octo_osc).
  // Si el script aún no se ha registrado (spawn reciente), el mensaje se
  // pierde con "Can't find script" — se encola hasta la marca de ready.
  // Cola acotada: solo interesa el ÚLTIMO estado, no el histórico.
  oscPush(kind, obj) {
    if (!this.running) return
    const payload = JSON.stringify(obj || {})
    if (!this._oscReady) {
      const q = (this._oscQueue ||= [])
      // el último 'state' reemplaza al anterior; el resto se apila
      const i = q.findIndex(e => e[0] === kind)
      if (kind === 'state' && i >= 0) q[i][1] = payload
      else { q.push([kind, payload]); if (q.length > 24) q.shift() }
      return
    }
    this._cmd('script-message-to', 'octo_osc', String(kind), payload).catch(() => {})
  }

  _flushOsc() {
    const q = this._oscQueue
    this._oscQueue = null
    for (const [kind, payload] of q || []) {
      this._cmd('script-message-to', 'octo_osc', kind, payload).catch(() => {})
    }
  }

  _die(reason) {
    if (this.closing) return
    this.closing = true
    this.running = false
    clearInterval(this.posTimer)
    for (const p of this.pending.values()) p.reject(new Error('mpv cerrado'))
    this.pending.clear()
    try { this.sock?.destroy() } catch {}
    if (this.sockPath && process.platform !== 'win32') { try { fs.unlinkSync(this.sockPath) } catch {} }
    // 'closed' aunque fuera 'ended' — VideoPlayer ya distingue el caso con
    // su propio flag endedRef, igual que con el plugin Android.
    this._emit({ state: 'closed' })
    this.onExit()
  }

  close() {
    if (this.closing) return
    this.closing = true
    this.running = false
    clearInterval(this.posTimer)
    for (const p of this.pending.values()) p.reject(new Error('mpv cerrado'))
    this.pending.clear()
    if (this.proc) {
      try { this._cmd('quit').catch(() => {}) } catch {}
      setTimeout(() => { try { this.proc?.kill('SIGKILL') } catch {} }, 1500).unref?.()
    }
    try { this.sock?.destroy() } catch {}
    if (this.sockPath && process.platform !== 'win32') { try { fs.unlinkSync(this.sockPath) } catch {} }
    this.onExit()
  }
}

module.exports = { MpvSession, findMpv }
