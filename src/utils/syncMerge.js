import { useStore } from '../store/useStore.js'

// Fusiona datos de sync remotos con los locales — unión por clave, nunca
// sustitución: lo enviado se JUNTA con lo que ya había en este dispositivo.
// Lee/escribe useStore.getState() directamente para servir tanto al panel
// SyncDevices como al listener global (RemotePlayReceiver) — funciona con
// cualquier componente desmontado.
export function mergeRemoteData(remoteData) {
  const counts = { favs: 0, hist: 0, eps: 0 }
  if (!remoteData || typeof remoteData !== 'object') return counts
  const s = useStore.getState()

  if (Array.isArray(remoteData.favorites)) {
    const favMap = new Map()
    for (const f of s.favorites) favMap.set(`${f.id}-${f.type}`, f)
    for (const f of remoteData.favorites) {
      const key = `${f.id}-${f.type}`
      if (!favMap.has(key)) { favMap.set(key, f); counts.favs++ }
    }
    if (counts.favs) s.setFavorites([...favMap.values()].slice(0, 500))
  }

  if (Array.isArray(remoteData.watchHistory)) {
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
  if (remoteData.watchedEpisodes && typeof remoteData.watchedEpisodes === 'object') {
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

  return counts
}

// Serializa el estado local al formato del protocolo /sync.
export function localSyncPayload() {
  const s = useStore.getState()
  return {
    favorites: s.favorites,
    watchHistory: s.watchHistory,
    watchedEpisodes: s.watchedEpisodes,
  }
}
