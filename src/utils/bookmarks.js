// Marcadores de posición dentro de un vídeo, por perfil.
// Se guardan en storage bajo octostream_bookmarks (perfilado), con clave de
// medio = imdbId|id + temporada/episodio cuando aplica. Solo posición y
// título — nunca URLs ni datos del stream.
import { getJsonSync, setJsonSync } from './storage.js'
import { profileDataKey } from './profiles.js'

const KEY = 'octostream_bookmarks'
const MAX_PER_MEDIA = 50
const MAX_MEDIA = 300

const storeKey = () => profileDataKey(KEY)

export function mediaKeyFor(meta) {
  if (!meta) return ''
  const base = String(meta.imdbId || meta.id || '').trim()
  if (!base) return ''
  const s = Number(meta.season)
  const e = Number(meta.episode)
  return Number.isFinite(s) && s > 0 ? `${base}|s${s}e${Number.isFinite(e) ? e : 0}` : base
}

const readAll = () => {
  const all = getJsonSync(storeKey(), {})
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
}

const writeAll = (all) => {
  const keys = Object.keys(all)
  if (keys.length > MAX_MEDIA) {
    // Poda por el marcador más antiguo de cada clave.
    const sorted = keys.sort((a, b) => (all[a]?.[0]?.at || 0) - (all[b]?.[0]?.at || 0))
    for (const k of sorted.slice(0, keys.length - MAX_MEDIA)) delete all[k]
  }
  setJsonSync(storeKey(), all)
}

export function getBookmarks(mediaKey) {
  if (!mediaKey) return []
  const list = readAll()[mediaKey]
  return Array.isArray(list) ? [...list].sort((a, b) => (a.t || 0) - (b.t || 0)) : []
}

export function addBookmark(mediaKey, { t, d = 0, title = '' } = {}) {
  const time = Math.floor(Number(t) || 0)
  if (!mediaKey || time < 5) return null
  const all = readAll()
  const list = Array.isArray(all[mediaKey]) ? all[mediaKey] : []
  if (list.some(b => Math.abs((b.t || 0) - time) < 4)) return null // duplicado ±4s
  const entry = {
    t: time,
    d: Math.floor(Number(d) || 0),
    title: String(title || '').slice(0, 120),
    at: Date.now(),
  }
  all[mediaKey] = [...list, entry].slice(-MAX_PER_MEDIA)
  writeAll(all)
  return entry
}

export function removeBookmark(mediaKey, index) {
  const all = readAll()
  const list = Array.isArray(all[mediaKey]) ? [...all[mediaKey]] : []
  const sorted = list.sort((a, b) => (a.t || 0) - (b.t || 0))
  if (index < 0 || index >= sorted.length) return false
  sorted.splice(index, 1)
  if (sorted.length) all[mediaKey] = sorted
  else delete all[mediaKey]
  writeAll(all)
  return true
}
