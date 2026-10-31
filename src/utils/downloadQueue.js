import { isAndroidNative } from './platform.js'
import { isPlayerActive } from './exoPlayer.js'
import { getTorrentEngine } from './torrentEngine.js'

const MAX_JOBS = 40

export function createDownloadQueue({
  getEngine: engineFactory = getTorrentEngine,
  isPlaybackActive = async () => isAndroidNative() && isPlayerActive(),
  setTimeoutFn = setTimeout,
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

  const notify = () => {
    const state = snapshot()
    for (const listener of listeners) {
      try { listener(state) } catch { /* isolate UI subscribers */ }
    }
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
    if (status === 'completed') job.progress = 1
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

  function enqueue({ name, kind, start }) {
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
      start,
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
    reserveForPlayback,
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

export const enqueueDownload = (job) => downloadQueue.enqueue(job)
export const cancelQueuedDownload = (id) => downloadQueue.cancelQueued(id)
export const moveQueuedDownload = (id, direction) => downloadQueue.moveQueued(id, direction)
export const reserveDownloadsForPlayback = () => downloadQueue.reserveForPlayback()
export const subscribeDownloadQueue = (listener) => downloadQueue.subscribe(listener)
export const getDownloadQueue = () => downloadQueue.getSnapshot()
