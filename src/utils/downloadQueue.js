import { isAndroidNative } from './platform.js'
import { isPlayerActive } from './exoPlayer.js'
import { getTorrentEngine } from './torrentEngine.js'
import { getJsonSync, setJsonSync } from './storage.js'
import { toast } from '../components/ui/Toast.jsx'

const MAX_JOBS = 40
const PERSIST_KEY = 'octostream_download_queue'
const MAX_PERSISTED = 20

// Descriptor serializable de un trabajo: permite reencolarlo tras reabrir la
// app. NUNCA se guardan URLs firmadas ni cabeceras: solo magnets/infoHash y
// enlaces debrid originales (host), que se re-desbloquean al arrancar el job.
function sanitizePersist(persist) {
  if (!persist || typeof persist !== 'object') return null
  const url = String(persist.url || '')
  if (!/^https?:\/\/|^magnet:/i.test(url)) return null
  if (persist.kind === 'torrent') {
    return {
      kind: 'torrent', url,
      season: Number.isFinite(persist.season) ? persist.season : undefined,
      episode: Number.isFinite(persist.episode) ? persist.episode : undefined,
      fileIndex: Number.isFinite(persist.fileIndex) ? persist.fileIndex : undefined,
    }
  }
  if (persist.kind === 'debrid') return { kind: 'debrid', url }
  return null
}

// Reconstruye la función start() de un descriptor persistido.
function persistedStart(persist, name) {
  if (persist.kind === 'torrent') {
    return engine => engine.download({
      url: persist.url,
      season: persist.season,
      episode: persist.episode,
      fileIndex: persist.fileIndex,
    })
  }
  // debrid: el enlace original (1fichier…) se re-desbloquea en el momento del
  // arranque — la URL firmada resultante jamás toca el disco.
  return async engine => {
    const { unlockLink } = await import('../plugins/bundled/alldebrid.js')
    const result = await unlockLink(persist.url)
    if (!result?.link) throw new Error(result?.error || 'No se pudo desbloquear el enlace')
    return engine.downloadHttp({ url: result.link, name, vps: true })
  }
}

export function createDownloadQueue({
  getEngine: engineFactory = getTorrentEngine,
  isPlaybackActive = async () => isAndroidNative() && isPlayerActive(),
  setTimeoutFn = setTimeout,
  persistStore = null, // {get(key), set(key, json)} — null = storage.js
} = {}) {
  let jobs = []
  let activeJob = null
  let activeEngine = null
  let pumping = false
  let playbackCheckTimer = null
  const playbackOwners = new Set()
  const listeners = new Set()
  let enginePromise = null
  let engineListener = null

  const snapshot = () => jobs.map(({ id, name, kind, status, progress, error }) => ({
    id, name, kind, status, progress, error,
  }))

  const storeGet = (key) => {
    try {
      return persistStore ? persistStore.get(key) : getJsonSync(key, null)
    } catch { return null }
  }
  const storeSet = (key, value) => {
    try {
      if (persistStore) persistStore.set(key, value)
      else if (value == null) setJsonSync(key, [])
      else setJsonSync(key, value)
    } catch { /* storage lleno/bloqueado */ }
  }

  // Guarda los trabajos pendientes (con descriptor persistible) para
  // reanudarlos en el próximo arranque. Los completados/caídos se eliminan.
  const persistPending = () => {
    const pending = jobs
      .filter(job => job.persist && ['queued', 'starting', 'downloading', 'paused'].includes(job.status))
      .map(job => ({ name: job.name, persist: job.persist, addedAt: job.addedAt || Date.now() }))
      .slice(-MAX_PERSISTED)
    storeSet(PERSIST_KEY, pending)
  }

  const notify = () => {
    persistPending()
    const state = snapshot()
    for (const listener of listeners) {
      try { listener(state) } catch { /* isolate UI subscribers */ }
    }
  }

  // Reencola trabajos guardados de una sesión anterior. Devuelve cuántos se
  // restauraron. Idempotente por id de descriptor (no duplica si ya está).
  const restorePersisted = () => {
    const saved = storeGet(PERSIST_KEY)
    if (!Array.isArray(saved) || !saved.length) return 0
    let restored = 0
    for (const entry of saved.slice(0, MAX_PERSISTED)) {
      const persist = sanitizePersist(entry?.persist)
      if (!persist) continue
      const dup = jobs.some(job => job.persist && job.persist.url === persist.url
        && job.persist.season === persist.season && job.persist.episode === persist.episode
        && job.persist.fileIndex === persist.fileIndex)
      if (dup) continue
      const name = String(entry.name || 'Descarga').slice(0, 180)
      const start = persistedStart(persist, name)
      jobs.push({
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name,
        kind: persist.kind === 'debrid' ? 'http' : 'torrent',
        status: 'queued',
        progress: 0,
        error: '',
        addedAt: Number(entry.addedAt) || Date.now(),
        persist,
        start,
        retryStart: start,
      })
      restored++
    }
    if (restored) { notify(); pump() }
    return restored
  }

  const resolveEngine = () => {
    if (!enginePromise) enginePromise = Promise.resolve().then(engineFactory).catch((error) => {
      enginePromise = null
      throw error
    })
    return enginePromise
  }

  const finish = (job, status, error = '') => {
    if (activeJob !== job) return
    job.status = status
    job.error = error ? String(error).slice(0, 240) : ''
    if (status === 'completed') {
      job.progress = 1
      toast(`${job.name || 'Descarga'} descargada — lista para ver`)
    }
    job.start = null
    activeJob = null
    activeEngine = null
    notify()
    pump()
  }

  const handleProgress = (event) => {
    const job = activeJob
    if (!job) return
    const progress = Number(event?.progress)
    if (Number.isFinite(progress)) job.progress = Math.max(0, Math.min(progress, 1))
    if (event?.fileName && job.status !== 'starting') job.name = String(event.fileName).slice(0, 180)
    if (event?.state === 'finished' || progress >= 1) finish(job, 'completed')
    else if (event?.state === 'error') finish(job, 'failed', 'La descarga ha fallado')
    else if (event?.state === 'downloading' && job.status === 'starting') job.status = 'downloading'
    notify()
  }

  const ensureListener = async (engine) => {
    if (!engineListener && engine?.addListener) {
      engineListener = await engine.addListener('torrentProgress', handleProgress)
    }
  }

  function pump() {
    if (pumping || activeJob || playbackOwners.size) return
    if (playbackCheckTimer) {
      clearTimeout(playbackCheckTimer)
      playbackCheckTimer = null
    }
    const next = jobs.find(job => job.status === 'queued')
    if (!next) return
    pumping = true
    ;(async () => {
      try {
        if (await isPlaybackActive()) {
          playbackCheckTimer = setTimeoutFn(() => {
            playbackCheckTimer = null
            pumping = false
            pump()
          }, 2000)
          return
        }
        activeJob = next
        next.status = 'starting'
        notify()
        const engine = await resolveEngine()
        if (activeJob !== next) return
        if (!engine) throw new Error('Motor de descargas no disponible')
        activeEngine = engine
        await ensureListener(engine)
        if (activeJob !== next) return
        next.status = 'downloading'
        notify()
        const result = await next.start(engine)
        if (activeJob !== next) return
        if (result?.complete === true) finish(next, 'completed')
        else if (next.kind === 'torrent' && result?.complete === false) {
          next.progress = Math.max(next.progress, Number(result.progress) || 0)
          notify()
        }
      } catch (error) {
        if (activeJob === next) finish(next, 'failed', error?.message || 'Error de descarga')
      } finally {
        pumping = false
        if (!activeJob && !playbackCheckTimer) pump()
      }
    })()
  }

  function enqueue({ name, kind, start, persist }) {
    if (!['torrent', 'http'].includes(kind) || typeof start !== 'function') {
      throw new TypeError('Descarga no válida')
    }
    if (jobs.filter(job => job.status === 'queued' || job.status === 'starting' || job.status === 'downloading').length >= MAX_JOBS) {
      throw new Error('La cola de descargas está llena')
    }
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    jobs = jobs.filter(job => !['completed', 'failed', 'cancelled'].includes(job.status) || job.id === activeJob?.id)
    jobs.push({
      id,
      name: String(name || 'Descarga').slice(0, 180),
      kind,
      status: 'queued',
      progress: 0,
      error: '',
      addedAt: Date.now(),
      persist: sanitizePersist(persist),
      start,
      retryStart: start,
    })
    jobs = jobs.slice(-MAX_JOBS)
    notify()
    pump()
    return id
  }

  function cancelQueued(id) {
    const job = jobs.find(entry => entry.id === id)
    if (!job || job.status !== 'queued') return false
    job.status = 'cancelled'
    job.start = null
    notify()
    return true
  }

  function moveQueued(id, direction) {
    const from = jobs.findIndex(entry => entry.id === id && entry.status === 'queued')
    if (from < 0) return false
    const queuedIndices = jobs
      .map((job, index) => job.status === 'queued' ? index : -1)
      .filter(index => index >= 0)
    const position = queuedIndices.indexOf(from)
    const target = queuedIndices[position + Math.sign(direction)]
    if (target == null) return false
    ;[jobs[from], jobs[target]] = [jobs[target], jobs[from]]
    notify()
    pump()
    return true
  }

  async function pauseActive() {
    const job = activeJob
    const engine = activeEngine
    if (!job || !engine?.stop) return false
    activeJob = null
    activeEngine = null
    job.status = 'paused'
    job.start = null
    notify()
    try {
      await engine.stop()
      pump()
      return true
    } catch {
      job.status = 'failed'
      job.error = 'No se pudo pausar la descarga'
      notify()
      pump()
      return false
    }
  }

  function resumeQueued(id) {
    const job = jobs.find(entry => entry.id === id && entry.status === 'paused')
    if (!job) return false
    job.status = 'queued'
    job.error = ''
    job.start = job.retryStart || (job.persist ? persistedStart(job.persist, job.name) : null)
    if (!job.start) {
      job.status = 'failed'
      job.error = 'No se puede reanudar este trabajo; vuelve a añadirlo desde su ficha'
      notify()
      return false
    }
    notify()
    pump()
    return true
  }

  function retryFailed(id) {
    const job = jobs.find(entry => entry.id === id && entry.status === 'failed')
    if (!job) return false
    job.start = job.retryStart || (job.persist ? persistedStart(job.persist, job.name) : null)
    if (!job.start) return false
    job.status = 'queued'
    job.progress = 0
    job.error = ''
    notify()
    pump()
    return true
  }

  function reserveForPlayback() {
    const token = {}
    playbackOwners.add(token)
    let ready = Promise.resolve()
    let readySettled = true
    let released = false
    const removeReservation = () => {
      if (!playbackOwners.delete(token)) return
      if (!playbackOwners.size) pump()
    }
    const job = activeJob
    if (job?.kind === 'torrent') {
      const engine = activeEngine
      activeJob = null
      activeEngine = null
      job.status = 'queued'
      jobs = [job, ...jobs.filter(entry => entry !== job)]
      notify()
      readySettled = false
      ready = Promise.resolve().then(() => engine?.stop?.())
        .catch((error) => {
          job.status = 'failed'
          job.error = error?.message || 'No se pudo pausar el torrent para reproducir'
          job.start = null
          notify()
        })
        .finally(() => {
          readySettled = true
          if (released) removeReservation()
        })
    }
    return {
      ready,
      release() {
        released = true
        if (readySettled) removeReservation()
      },
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    enqueue,
    cancelQueued,
    moveQueued,
    pauseActive,
    resumeQueued,
    retryFailed,
    reserveForPlayback,
    restorePersisted,
    subscribe,
    getSnapshot: snapshot,
    destroy() {
      if (playbackCheckTimer) clearTimeout(playbackCheckTimer)
      try { engineListener?.remove?.() } catch { /* noop */ }
      listeners.clear()
    },
  }
}

const downloadQueue = createDownloadQueue()

// Recupera las descargas pendientes de la sesión anterior una vez por arranque
// (diferido a idle para no competir con la carga inicial de la app).
if (typeof window !== 'undefined') {
  const kickoff = () => { try { downloadQueue.restorePersisted() } catch { /* noop */ } }
  if ('requestIdleCallback' in window) window.requestIdleCallback(kickoff, { timeout: 15000 })
  else setTimeout(kickoff, 5000)
}

export const enqueueDownload = (job) => downloadQueue.enqueue(job)
export const cancelQueuedDownload = (id) => downloadQueue.cancelQueued(id)
export const moveQueuedDownload = (id, direction) => downloadQueue.moveQueued(id, direction)
export const pauseActiveDownload = () => downloadQueue.pauseActive()
export const resumeQueuedDownload = (id) => downloadQueue.resumeQueued(id)
export const retryFailedDownload = (id) => downloadQueue.retryFailed(id)
export const reserveDownloadsForPlayback = () => downloadQueue.reserveForPlayback()
export const subscribeDownloadQueue = (listener) => downloadQueue.subscribe(listener)
export const getDownloadQueue = () => downloadQueue.getSnapshot()
