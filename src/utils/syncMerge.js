import { useStore } from '../store/useStore.js'
import { BACKUP_CATEGORIES, ALL_CATEGORIES, categoryOf, collectSettings } from './configBackup.js'
import { sshCredsForTransfer, applyReceivedSshCreds } from './sshCreds.js'

// Mismas secciones que la copia de seguridad: listas, historial, cuentas y
// resto de ajustes. La selección se guarda por dispositivo.
export const SYNC_CATEGORIES = BACKUP_CATEGORIES
export const DEFAULT_SYNC_CATEGORIES = ['lists', 'history']
export const SYNC_CATEGORIES_KEY = 'octostream_sync_categories'

// Estas claves se sincronizan en formato estructurado (unión, no
// sobreescritura); no deben viajar además dentro de `settings`.
const STORE_MANAGED_KEYS = new Set([
  'octostream_favorites',
  'octostream_watchlist',
  'octostream_history',
  'octostream_watched_episodes',
])

// Claves locales o sensibles no portables: tokens de emparejamiento, estado
// efímero de sync/cast y la propia selección de secciones de este dispositivo.
const SYNC_EXCLUDED_KEYS = new Set([
  'octostream_pair_tokens',
  'octostream_last_sync',
  'octostream_last_cast_device',
  // Los perfiles y el perfil activo son locales a cada dispositivo; sus
  // listas se sincronizan como datos del perfil activo, nunca el registro.
  'octostream_profiles',
  'octostream_active_profile',
  SYNC_CATEGORIES_KEY,
])

const VALID_CATEGORIES = new Set(ALL_CATEGORIES)

export function normalizeSyncCategories(categories) {
  if (!Array.isArray(categories)) return [...DEFAULT_SYNC_CATEGORIES]
  const out = [...new Set(categories.filter(c => VALID_CATEGORIES.has(c)))]
  return out.length ? out : [...DEFAULT_SYNC_CATEGORIES]
}

export function loadSyncCategories() {
  try {
    return normalizeSyncCategories(JSON.parse(localStorage.getItem(SYNC_CATEGORIES_KEY) || 'null'))
  } catch {
    return [...DEFAULT_SYNC_CATEGORIES]
  }
}

export function saveSyncCategories(categories) {
  const cats = normalizeSyncCategories(categories)
  try { localStorage.setItem(SYNC_CATEGORIES_KEY, JSON.stringify(cats)) } catch { /* storage bloqueado */ }
  return cats
}

const settingsExcluded = () => new Set([...STORE_MANAGED_KEYS, ...SYNC_EXCLUDED_KEYS])

// Fusiona datos de sync remotos con los locales — unión por clave, nunca
// sustitución: lo enviado se JUNTA con lo que ya había en este dispositivo.
// Las secciones no seleccionadas se ignoran también al recibir.
// Lee/escribe useStore.getState() directamente para servir tanto al panel
// SyncDevices como al listener global (RemotePlayReceiver) — funciona con
// cualquier componente desmontado.
export function mergeRemoteData(remoteData, categories = null) {
  const counts = { favs: 0, watchlist: 0, hist: 0, eps: 0, settings: 0 }
  if (!remoteData || typeof remoteData !== 'object') return counts
  const wanted = new Set(normalizeSyncCategories(categories ?? loadSyncCategories()))
  const s = useStore.getState()
  // No mezclar listas entre perfiles distintos (p. ej. el perfil infantil
  // del emisor nunca debe acabar dentro de "Principal" del receptor).
  const localProfileId = s.activeProfileId || 'default'
  const remoteProfileId = remoteData.profileId || 'default'
  const matchingProfile = localProfileId === remoteProfileId

  if (matchingProfile && wanted.has('lists') && Array.isArray(remoteData.favorites)) {
    const favMap = new Map()
    for (const f of s.favorites) favMap.set(`${f.id}-${f.type}`, f)
    for (const f of remoteData.favorites) {
      const key = `${f.id}-${f.type}`
      if (!favMap.has(key)) { favMap.set(key, f); counts.favs++ }
    }
    if (counts.favs) s.setFavorites([...favMap.values()].slice(0, 500))
  }

  if (wanted.has('lists') && Array.isArray(remoteData.watchlist)) {
    const listMap = new Map()
    for (const w of s.watchlist) listMap.set(`${w.id}-${w.type}`, w)
    for (const w of remoteData.watchlist) {
      const key = `${w.id}-${w.type}`
      if (!listMap.has(key)) { listMap.set(key, w); counts.watchlist++ }
    }
    if (counts.watchlist) s.setWatchlist([...listMap.values()].slice(0, 500))
  }

  if (matchingProfile && wanted.has('history') && Array.isArray(remoteData.watchHistory)) {
    const histMap = new Map()
    for (const h of s.watchHistory) histMap.set(`${h.id}-${h.type}`, h)
    for (const h of remoteData.watchHistory) {
      const key = `${h.id}-${h.type}`
      const existing = histMap.get(key)
      if (!existing || (h.watchedAt || 0) > (existing.watchedAt || 0)) {
        histMap.set(key, h)
        counts.hist++
      }
    }
    if (counts.hist) {
      s.setWatchHistory([...histMap.values()]
        .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 50))
    }
  }

  // Sin keys de prototipo — un peer malicioso podría inyectar __proto__.
  if (wanted.has('history') && remoteData.watchedEpisodes && typeof remoteData.watchedEpisodes === 'object') {
    const merged = { ...s.watchedEpisodes }
    let count = Object.keys(merged).length
    let changed = false
    for (const [key, val] of Object.entries(remoteData.watchedEpisodes)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (!merged[key] && count >= 5000) continue
      if (!merged[key]) count++
      if (!merged[key] || (val.watchedAt || 0) > (merged[key].watchedAt || 0)) {
        merged[key] = val
        counts.eps++
        changed = true
      }
    }
    if (changed) s.setWatchedEpisodes(merged)
  }

  if (remoteData.settings && typeof remoteData.settings === 'object') {
    const excluded = settingsExcluded()
    for (const [key, value] of Object.entries(remoteData.settings)) {
      if (!key.startsWith('octostream_') || typeof value !== 'string' || excluded.has(key)) continue
      if (!wanted.has(categoryOf(key))) continue
      try {
        if (localStorage.getItem(key) !== value) {
          localStorage.setItem(key, value)
          counts.settings++
        }
      } catch { /* localStorage puede estar lleno o bloqueado */ }
    }
  }

  // Credenciales SSH recién recibidas: en Android se suben al almacén
  // cifrado del plugin y se borra la copia en claro de localStorage.
  applyReceivedSshCreds().catch(() => {})

  return counts
}

// Serializa el estado local al formato del protocolo /sync. `settings`
// contiene las claves octostream_* de las secciones elegidas, salvo las listas
// estructuradas de arriba y las claves locales/sensibles excluidas.
export async function localSyncPayload(categories = null) {
  const cats = normalizeSyncCategories(categories ?? loadSyncCategories())
  const s = useStore.getState()
  const payload = {
    kind: 'octostream-sync',
    version: 2,
    sections: cats,
    profileId: s.activeProfileId || 'default',
  }
  if (cats.includes('lists')) {
    payload.favorites = s.favorites
    payload.watchlist = s.watchlist
  }
  if (cats.includes('history')) {
    payload.watchHistory = s.watchHistory
    payload.watchedEpisodes = s.watchedEpisodes
  }
  const settings = collectSettings(cats, settingsExcluded())
  // La clave SSH del VPS no vive en localStorage en Android (Keystore):
  // se pide al plugin para que viaje con las demás cuentas.
  if (cats.includes('accounts')) Object.assign(settings, await sshCredsForTransfer())
  if (Object.keys(settings).length) payload.settings = settings
  return payload
}
