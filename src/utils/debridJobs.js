// Seguimiento de magnets en cola de AllDebrid: permite ver el progreso
// real de la descarga del torrent en las entradas "descargando" de la
// ficha, y reproducir al instante cuando statusCode=4 (con links ya
// restringidos listos para /link/unlock).
//
// Jobs por infoHash — las entradas processing de AIOStreams llevan
// _infoHash y se emparejan aquí:
//   - trackMagnet(id, hash, name) tras subirlo desde la ficha.
//   - adoptDebridMagnets(streams) adopta magnets que ya están en la cola
//     de la cuenta (subidos por la propia instancia AIOStreams).
// La UI se suscribe con subscribeDebridJobs() para repintar el %.

import {
  isAlldebridEnabled,
  getMagnetStatus,
  listMagnets,
  unlockLink as adUnlockLink,
} from '../plugins/bundled/alldebrid.js'
import { pickTorrentEntries } from './torrentPick.js'

const jobs = new Map()          // magnetId → job
const byHash = new Map()        // infoHash → magnetId
const listeners = new Set()
let pollTimer = null

const notify = () => listeners.forEach(cb => { try { cb() } catch { /* listener */ } })

export function subscribeDebridJobs(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getDebridJob(infoHash) {
  const id = byHash.get(String(infoHash || '').toLowerCase())
  return id ? jobs.get(id) || null : null
}

export function btihOf(magnet) {
  return (String(magnet || '').match(/btih:([a-zA-Z0-9]{32,40})/i)?.[1] || '').toLowerCase()
}

export function trackMagnet(id, infoHash, name) {
  const hash = String(infoHash || '').toLowerCase()
  const job = { id, infoHash: hash, name: name || '', progress: 0, status: 'processing', links: null }
  jobs.set(id, job)
  if (hash) byHash.set(hash, id)
  ensurePolling()
  notify()
  return job
}

// Empareja entradas "descargando" con los magnets ya presentes en la
// cola de AllDebrid (subidos por la instancia AIOStreams, no por la app).
let _adoptInflight = null
export async function adoptDebridMagnets(streams) {
  if (!isAlldebridEnabled()) return
  const pending = (streams || []).filter(
    s => s?.processing && s._infoHash && !byHash.has(s._infoHash)
  )
  if (!pending.length) return
  if (!_adoptInflight) {
    _adoptInflight = listMagnets().finally(() => { _adoptInflight = null })
  }
  const list = await _adoptInflight
  for (const s of pending) {
    const m = list.find(x => String(x.hash || '').toLowerCase() === s._infoHash)
    if (m) trackMagnet(m.id, m.hash, m.filename || s.releaseTitle || s.name)
  }
}

function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(pollJobs, 8000)
  pollJobs()
}

async function pollJobs() {
  let active = 0
  for (const job of jobs.values()) {
    if (job.status !== 'processing') continue
    active++
    try {
      const st = await getMagnetStatus(job.id)
      if (st.status === 'ready') { job.status = 'ready'; job.links = st.links || []; job.progress = 100 }
      else if (st.status === 'error') { job.status = 'error' }
      else if (typeof st.progress === 'number') job.progress = st.progress
    } catch { /* transitorio — siguiente tick */ }
  }
  notify()
  if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// Magnet listo → URL directa reproducible (pick del archivo correcto en
// packs de temporada + unlock de los links restringidos).
export async function resolveDebridJob(job, opts = {}) {
  let links = job?.links
  if (!links?.length) {
    const st = await getMagnetStatus(job.id)
    if (st.status !== 'ready') return null
    links = st.links || []
    job.links = links
  }
  if (!links.length) return null
  const picked = pickTorrentEntries(links, opts) || links
  const direct = (await Promise.all(picked.map(l => adUnlockLink(l.link))))
    .map(u => u?.link).filter(Boolean)
  return direct[0] || null
}
