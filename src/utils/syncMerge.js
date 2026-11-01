import { useStore } from '../store/useStore.js'
import { BACKUP_CATEGORIES, ALL_CATEGORIES, categoryOf, collectSettings } from './configBackup.js'
import { sshCredsForTransfer, applyReceivedSshCreds } from './sshCreds.js'
import { getProfiles, persistProfiles, profileDataKey } from './profiles.js'
import { getJsonSync, setJsonSync } from './storage.js'

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

function normalizeSyncCategories(categories) {
  if (!Array.isArray(categories)) return [...DEFAULT_SYNC_CATEGORIES]
  const out = [...new Set(categories.filter(c => VALID_CATEGORIES.has(c)))]
  return out.length ? out : [...DEFAULT_SYNC_CATEGORIES]
}

// Vista previa no sensible para confirmar una importación manual. Solo
// devuelve secciones y cantidades; nunca devuelve valores de cuentas/claves.
export function previewRemoteSync(remoteData, categories = null) {
  const wanted = new Set(normalizeSyncCategories(categories ?? loadSyncCategories()))
  const incoming = new Set(Array.isArray(remoteData?.sections) ? remoteData.sections : wanted)
  const accepts = id => wanted.has(id) && incoming.has(id)
  const entries = [
    remoteData,
    ...Object.values(remoteData?.profileData || {}).filter(v => v && typeof v === 'object'),
  ]
  const listCount = key => entries.reduce((n, entry) =>
    n + (Array.isArray(entry?.[key]) ? entry[key].length : 0), 0)
  const episodeCount = entries.reduce((n, entry) => {
    const value = entry?.watchedEpisodes
    return n + (value && typeof value === 'object' ? Object.keys(value).length : 0)
  }, 0)
  const settings = Object.entries(remoteData?.settings || {})
    .filter(([key]) => key.startsWith('octostream_') && accepts(categoryOf(key)))
    .length
  return {
    categories: SYNC_CATEGORIES.filter(c => accepts(c.id)).map(c => c.label),
    counts: {
      favorites: accepts('lists') ? listCount('favorites') : 0,
      watchlist: accepts('lists') ? listCount('watchlist') : 0,
      history: accepts('history') ? listCount('watchHistory') : 0,
      episodes: accepts('history') ? episodeCount : 0,
      settings: accepts('accounts') || accepts('settings') ? settings : 0,
      profiles: (accepts('lists') || accepts('history')) && Array.isArray(remoteData?.profiles)
        ? remoteData.profiles.length : 0,
    },
  }
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

const normalizeProfileName = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()

// Campo del store ↔ clave de storage por perfil (profileDataKey).
const PROFILE_LISTS = {
  favorites: 'octostream_favorites',
  watchlist: 'octostream_watchlist',
  watchHistory: 'octostream_history',
  watchedEpisodes: 'octostream_watched_episodes',
}

// Unión (nunca sustitución) de favoritos/lista/historial/episodios de
// `entry` dentro del par (get, set). Sirve para el store del perfil activo
// y para las claves storage de un perfil en segundo plano.
function mergeMediaLists(entry, wanted, counts, get, set) {
  if (wanted.has('lists') && Array.isArray(entry.favorites)) {
    const favMap = new Map()
    for (const f of get('favorites') || []) favMap.set(`${f.id}-${f.type}`, f)
    let n = 0
    for (const f of entry.favorites) {
      const key = `${f.id}-${f.type}`
      if (!favMap.has(key)) { favMap.set(key, f); n++ }
    }
    if (n) { set('favorites', [...favMap.values()].slice(0, 500)); counts.favs += n }
  }

  if (wanted.has('lists') && Array.isArray(entry.watchlist)) {
    const listMap = new Map()
    for (const w of get('watchlist') || []) listMap.set(`${w.id}-${w.type}`, w)
    let n = 0
    for (const w of entry.watchlist) {
      const key = `${w.id}-${w.type}`
      if (!listMap.has(key)) { listMap.set(key, w); n++ }
    }
    if (n) { set('watchlist', [...listMap.values()].slice(0, 500)); counts.watchlist += n }
  }

  if (wanted.has('history') && Array.isArray(entry.watchHistory)) {
    const histMap = new Map()
    for (const h of get('watchHistory') || []) histMap.set(`${h.id}-${h.type}`, h)
    let n = 0
    for (const h of entry.watchHistory) {
      const key = `${h.id}-${h.type}`
      const existing = histMap.get(key)
      if (!existing || (h.watchedAt || 0) > (existing.watchedAt || 0)) {
        histMap.set(key, h)
        n++
      }
    }
    if (n) {
      set('watchHistory', [...histMap.values()]
        .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 50))
      counts.hist += n
    }
  }

  // Sin keys de prototipo — un peer malicioso podría inyectar __proto__.
  if (wanted.has('history') && entry.watchedEpisodes && typeof entry.watchedEpisodes === 'object') {
    const merged = { ...(get('watchedEpisodes') || {}) }
    let count = Object.keys(merged).length
    let changed = false
    for (const [key, val] of Object.entries(entry.watchedEpisodes)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (!merged[key] && count >= 5000) continue
      if (!merged[key]) count++
      if (!merged[key] || (val.watchedAt || 0) > (merged[key].watchedAt || 0)) {
        merged[key] = val
        counts.eps++
        changed = true
      }
    }
    if (changed) set('watchedEpisodes', merged)
  }
}

// Mapa remoteProfileId → localProfileId. Crea en el receptor los perfiles
// que falten SOLO desde el array `profiles` del payload v3 — el profileId
// top-level de emisores antiguos no crea nada (evita que un peer cree
// perfiles sin enviar el registro explícito). Coincidencia por id, luego
// por nombre normalizado + tipo infantil. El PIN no viaja en claro — solo
// el hash PBKDF2+sal, que sigue verificando el mismo PIN si el perfil
// conserva su id original.
const MAX_SYNC_PROFILES = 8

function resolveProfileMap(remoteData, localProfiles) {
  const map = new Map()
  const list = Array.isArray(remoteData.profiles) ? remoteData.profiles : []
  const local = [...localProfiles]
  let changed = false
  for (const rp of list) {
    if (!rp?.id || !rp?.name) continue
    let found = local.find(p => p.id === rp.id)
    if (!found) {
      found = local.find(p => normalizeProfileName(p.name) === normalizeProfileName(rp.name)
        && !!p.kids === !!rp.kids)
    }
    if (!found) {
      if (local.length >= MAX_SYNC_PROFILES) continue // sin hueco — no se crea
      const id = local.some(p => p.id === rp.id)
        ? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
        : String(rp.id).slice(0, 40)
      const created = {
        id,
        name: String(rp.name).slice(0, 24),
        kids: !!rp.kids,
        createdAt: Number(rp.createdAt) || Date.now(),
      }
      if (id === rp.id && typeof rp.pinHash === 'string' && typeof rp.pinSalt === 'string') {
        created.pinHash = rp.pinHash
        created.pinSalt = rp.pinSalt
      }
      local.push(created)
      changed = true
      found = created
    }
    map.set(rp.id, found.id)
  }
  // Perfil activo del emisor ausente del array (payload antiguo/mixto):
  // se mapea por nombre + tipo si existe localmente, sin crear nada.
  if (remoteData.profileId && !map.has(remoteData.profileId) && remoteData.profileName) {
    const found = local.find(p =>
      normalizeProfileName(p.name) === normalizeProfileName(remoteData.profileName)
      && !!p.kids === !!remoteData.profileKids)
    if (found) map.set(remoteData.profileId, found.id)
  }
  if (changed) {
    persistProfiles(local)
    useStore.setState({ profiles: local })
  }
  return map
}

// Fusiona datos de sync remotos con los locales — unión por clave, nunca
// sustitución: lo enviado se JUNTA con lo que ya había en este dispositivo.
// Las secciones no seleccionadas se ignoran también al recibir.
// Lee/escribe useStore.getState() directamente para servir tanto al panel
// SyncDevices como al listener global (RemotePlayReceiver) — funciona con
// cualquier componente desmontado.
export function mergeRemoteData(remoteData, categories = null) {
  const counts = { favs: 0, watchlist: 0, hist: 0, eps: 0, settings: 0, profiles: 0 }
  if (!remoteData || typeof remoteData !== 'object') return counts
  const wanted = new Set(normalizeSyncCategories(categories ?? loadSyncCategories()))
  const s = useStore.getState()
  // No mezclar listas entre perfiles distintos (p. ej. el perfil infantil
  // del emisor nunca debe acabar dentro de "Principal" del receptor).
  // Los IDs se generan localmente; entre dispositivos emparejados se
  // considera el mismo perfil solo con nombre normalizado + tipo infantil.
  const localProfileId = s.activeProfileId || 'default'
  const remoteProfileId = remoteData.profileId || 'default'
  const localProfile = s.profiles?.find(p => p.id === localProfileId)

  // Perfiles que viajan en el payload (v3): crea los que falten y mapea
  // remoteId → localId. Los datos del perfil activo del emisor aterrizan en
  // el perfil local correspondiente — no siempre en el activo del receptor.
  let idMap = new Map()
  if (wanted.has('lists') || wanted.has('history')) {
    const before = (s.profiles || []).length
    idMap = resolveProfileMap(remoteData, s.profiles || [])
    counts.profiles = Math.max(0, (useStore.getState().profiles || []).length - before)
  }
  const storeSetter = (key, value) => {
    const fn = {
      favorites: 'setFavorites',
      watchlist: 'setWatchlist',
      watchHistory: 'setWatchHistory',
      watchedEpisodes: 'setWatchedEpisodes',
    }[key]
    if (fn && typeof s[fn] === 'function') s[fn](value)
  }
  const mergeEntry = (localId, entry) => {
    if (!localId) return
    if (localId === localProfileId) {
      mergeMediaLists(entry, wanted, counts, k => s[k], storeSetter)
    } else {
      mergeMediaLists(entry, wanted, counts,
        key => getJsonSync(profileDataKey(PROFILE_LISTS[key], localId), key === 'watchedEpisodes' ? {} : []),
        (key, value) => setJsonSync(profileDataKey(PROFILE_LISTS[key], localId), value))
    }
  }

  const nameMatch = localProfileId === remoteProfileId
    || (!!localProfile && !!remoteData.profileName
      && normalizeProfileName(localProfile.name) === normalizeProfileName(remoteData.profileName)
      && !!localProfile.kids === !!remoteData.profileKids)
  const matchingProfile = idMap.has(remoteProfileId) || nameMatch

  // Datos del perfil activo del emisor (campos top-level del payload).
  // Destino: su perfil local equivalente — el activo solo si corresponde.
  if (matchingProfile) mergeEntry(idMap.get(remoteProfileId) || localProfileId, remoteData)

  // Datos de los demás perfiles del emisor.
  if (remoteData.profileData && typeof remoteData.profileData === 'object') {
    for (const [remoteId, entry] of Object.entries(remoteData.profileData)) {
      if (remoteId === '__proto__' || remoteId === 'constructor' || remoteId === 'prototype') continue
      const localId = idMap.get(remoteId)
      if (!localId || !entry || typeof entry !== 'object') continue
      mergeEntry(localId, entry)
    }
  }

  if (remoteData.settings && typeof remoteData.settings === 'object') {
    const excluded = settingsExcluded()
    for (const [key, value] of Object.entries(remoteData.settings)) {
      if (!key.startsWith('octostream_') || typeof value !== 'string' || excluded.has(key)) continue
      // Las listas de otros perfiles viajan en profileData, no como claves.
      if (key.startsWith('octostream_profile_')) continue
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
    version: 3,
    sections: cats,
    profileId: s.activeProfileId || 'default',
    profileName: s.profiles?.find(p => p.id === s.activeProfileId)?.name || 'Principal',
    profileKids: !!s.profiles?.find(p => p.id === s.activeProfileId)?.kids,
  }
  if (cats.includes('lists')) {
    payload.favorites = s.favorites
    payload.watchlist = s.watchlist
  }
  if (cats.includes('history')) {
    payload.watchHistory = s.watchHistory
    payload.watchedEpisodes = s.watchedEpisodes
  }
  // v3: perfiles + datos por perfil. Viajan con listas/historial porque son
  // el destino de esos datos en el receptor. El PIN no viaja en claro —
  // solo el hash PBKDF2+sal, que conserva el bloqueo infantil si el perfil
  // mantiene su id al recrearse en el otro dispositivo.
  if (cats.includes('lists') || cats.includes('history')) {
    const profiles = getProfiles()
    payload.profiles = profiles.map(p => ({
      id: p.id,
      name: p.name,
      kids: !!p.kids,
      createdAt: p.createdAt || 0,
      ...(p.pinHash && p.pinSalt ? { pinHash: p.pinHash, pinSalt: p.pinSalt } : {}),
    }))
    const profileData = {}
    for (const p of profiles) {
      if (p.id === s.activeProfileId) continue // el activo ya va en top-level
      const entry = {}
      if (cats.includes('lists')) {
        entry.favorites = getJsonSync(profileDataKey('octostream_favorites', p.id), [])
        entry.watchlist = getJsonSync(profileDataKey('octostream_watchlist', p.id), [])
      }
      if (cats.includes('history')) {
        entry.watchHistory = getJsonSync(profileDataKey('octostream_history', p.id), [])
        entry.watchedEpisodes = getJsonSync(profileDataKey('octostream_watched_episodes', p.id), {})
      }
      if (Object.values(entry).some(v => Array.isArray(v) ? v.length : Object.keys(v || {}).length)) {
        profileData[p.id] = entry
      }
    }
    if (Object.keys(profileData).length) payload.profileData = profileData
  }
  const settings = collectSettings(cats, settingsExcluded())
  // La clave SSH del VPS no vive en localStorage en Android (Keystore):
  // se pide al plugin para que viaje con las demás cuentas.
  if (cats.includes('accounts')) Object.assign(settings, await sshCredsForTransfer())
  if (Object.keys(settings).length) payload.settings = settings
  return payload
}
