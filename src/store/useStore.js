import { create } from 'zustand'
import { pluginManager } from '../plugins/manager.js'
import { searchMulti } from '../plugins/builtIn/tmdb.js'
import { getSharedCache } from '../plugins/bundled/tdtSpain/cache.js'
import { normalizeChannel } from '../plugins/bundled/tdtSpain/normalize.js'
import { getJsonSync, setJsonSync } from '../utils/storage.js'
import { waitForWarp } from '../utils/warpStatus.js'

// Persisted slices of the store. Each key maps to a localStorage key.
const PERSISTED_KEYS = {
  favorites: 'octostream_favorites',
  watchHistory: 'octostream_history',
  watchedEpisodes: 'octostream_watched_episodes',
  youtubeSearchHistory: 'octostream_youtube_search_history',
  youtubeLiveSearchHistory: 'octostream_youtube_live_search_history',
}

function loadPersisted(key, fallback) {
  return getJsonSync(key, fallback)
}

function persist(key, value) {
  setJsonSync(key, value)
}

// watchedEpisodes crece una key por episodio visto y el objeto entero se
// serializa a localStorage en cada marca — podar a los N más recientes.
const WATCHED_CAP = 5000
function capWatched(watched) {
  const keys = Object.keys(watched)
  if (keys.length <= WATCHED_CAP) return watched
  const keep = new Set(
    keys.sort((a, b) => (watched[b]?.watchedAt || 0) - (watched[a]?.watchedAt || 0))
      .slice(0, WATCHED_CAP))
  const out = {}
  for (const k of keys) if (keep.has(k)) out[k] = watched[k]
  return out
}

// El historial de progreso se actualiza cada ~5s desde ExoPlayer — persistir
// en cada tick escribe el array entero a disco constantemente. Se persiste
// como mucho cada 30s; el estado en memoria sigue actualizándose siempre.
let lastProgressPersist = 0
const PROGRESS_PERSIST_MS = 30000
// Generación de búsqueda: distingue "abort seguido de nueva búsqueda" (no
// tocar loading, la nueva lo controla) de "abort sin sucesora" (limpiarlo).
let searchGeneration = 0

// Búsqueda local de canales TDT sobre la cache compartida — síncrona, sin red.
// Solo funciona si la lista de canales ya se descargó alguna vez (LiveTV).
function searchLocalChannels(query) {
  const q = (query || '').trim().toLowerCase()
  if (q.length < 2) return []
  try {
    const cache = getSharedCache()
    const channels = cache?.channels || []
    return channels
      .filter(ch => (ch.name || '').toLowerCase().includes(q))
      .slice(0, 12)
      .map(ch => normalizeChannel(ch, cache.epg || {}))
  } catch {
    return []
  }
}

export const useStore = create((set, get) => ({
  plugins: [],
  installedPlugins: [],
  externalPlugins: [],
  activeCatalog: null,
  searchQuery: '',
  searchResults: [],
  loading: false,
  favorites: loadPersisted(PERSISTED_KEYS.favorites, []),
  watchHistory: loadPersisted(PERSISTED_KEYS.watchHistory, []),
  // Map of "seriesId:Sseason:Eepisode" → { watchedAt, progress }
  // Tracks which episodes have been watched (>= 97% progress).
  watchedEpisodes: loadPersisted(PERSISTED_KEYS.watchedEpisodes, {}),
  // Las historias de YouTube se hidratan diferidas: solo se leen en la página
  // YouTube (lazy route), así que no hay que pagar su localStorage en arranque.
  youtubeSearchHistory: [],
  youtubeLiveSearchHistory: [],
  _ytHistoryHydrated: false,

  ensureYoutubeHistory: () => {
    if (get()._ytHistoryHydrated) return
    set({
      _ytHistoryHydrated: true,
      youtubeSearchHistory: loadPersisted(PERSISTED_KEYS.youtubeSearchHistory, []),
      youtubeLiveSearchHistory: loadPersisted(PERSISTED_KEYS.youtubeLiveSearchHistory, []),
    })
  },

  initPlugins: async () => {
    // Los plugins bundled se cargan lazy (import dinámico): esperar a que
    // estén listos antes de leer las listas.
    await pluginManager.ensureReady()
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
  },

  installPlugin: async (pluginId) => {
    await pluginManager.installPlugin(pluginId)
    set({ installedPlugins: pluginManager.getInstalledPlugins() })
  },

  uninstallPlugin: async (pluginId) => {
    await pluginManager.uninstallPlugin(pluginId)
    set({ installedPlugins: pluginManager.getInstalledPlugins() })
  },

  addExternalPlugin: async (input) => {
    let config
    if (typeof input === 'string') {
      config = { manifestUrl: input, baseUrl: input.replace(/\/manifest\.json$/, '') }
    } else {
      config = input
    }
    const plugin = await pluginManager.addExternalPlugin(config)
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
    return plugin
  },

  addExternalPluginByUrl: async (manifestUrl) => {
    const plugin = await pluginManager.addExternalPluginByUrl(manifestUrl)
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
    return plugin
  },

  removeExternalPlugin: async (pluginId) => {
    await pluginManager.removeExternalPlugin(pluginId)
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
  },

  setActiveCatalog: (catalog) => set({ activeCatalog: catalog }),

  setSearchQuery: (query) => set({ searchQuery: query }),
  clearSearch: () => set({ searchQuery: '', searchResults: [], loading: false }),

  search: async (query, signal) => {
    const gen = ++searchGeneration
    set({ loading: true, searchQuery: query, searchResults: [] })
    try {
      // Wait for WARP before searching (prevents IP leak)
      await waitForWarp()
      // Solo TMDB (exacto, una petición cacheada) + canales TDT locales.
      // Los scrapers de plugins devolvían ruido que aparecía y desaparecía
      // por lotes — la búsqueda queda instantánea y estable.
      const tmdbResults = await searchMulti(query, signal)
      if (signal?.aborted || gen !== searchGeneration) {
        // Abort sin búsqueda posterior: limpiar loading para no dejar el
        // spinner colgado en el store global.
        if (gen === searchGeneration) set({ loading: false })
        return
      }
      set({ searchResults: [...tmdbResults, ...searchLocalChannels(query)], loading: false })
    } catch (e) {
      if (gen === searchGeneration) set({ loading: false })
    }
  },

  toggleFavorite: (item) => {
    const favorites = get().favorites
    const exists = favorites.find(f => f.id === item.id && f.type === item.type)
    const updated = exists
      ? favorites.filter(f => !(f.id === item.id && f.type === item.type))
      : [item, ...favorites].slice(0, 500) // newest first, cap at 500 favorites
    persist(PERSISTED_KEYS.favorites, updated)
    set({ favorites: updated })
  },

  isFavorite: (id, type) => {
    return get().favorites.some(f => f.id === id && f.type === type)
  },

  addToHistory: (item) => {
    const history = get().watchHistory
    const existing = history.find(h => h.id === item.id && h.type === item.type)
    // Preserve progress fields from existing item so "Continuar" still works
    // after re-adding to history (e.g. replaying a YouTube video)
    // Also preserve seasonsList so ContinueWatching can check if the series is complete
    const merged = existing
      ? { ...existing, ...item, watchedAt: Date.now(), seasonsList: item.seasonsList || existing.seasonsList }
      : { ...item, watchedAt: Date.now() }
    const updated = [merged, ...history.filter(h => !(h.id === item.id && h.type === item.type))].slice(0, 50)
    persist(PERSISTED_KEYS.watchHistory, updated)
    set({ watchHistory: updated })
  },

  updateProgress: (id, type, currentTime, duration, episodeInfo = null, force = false) => {
    const history = get().watchHistory
    const idx = history.findIndex(h => h.id === id && h.type === type)
    // Compute progress even if the item isn't in history yet, so the
    // episode-watched tick can still be set (the tick only needs
    // watchedEpisodes, not watchHistory).
    const effectiveDuration = duration > 0
      ? duration
      : (idx >= 0 ? (history[idx].duration || 0) : 0)
    const progress = effectiveDuration > 0 ? currentTime / effectiveDuration : 0
    if (idx >= 0) {
      const updated = [...history]
      updated[idx] = {
        ...updated[idx],
        currentTime,
        duration: effectiveDuration,
        progress,
        watchedAt: Date.now(),
        // Guardar info del episodio para series: permite reanudar el capítulo
        // correcto al volver a la serie, no solo la serie en general.
        ...(episodeInfo ? {
          season: episodeInfo.season,
          episode: episodeInfo.episode,
          episodeName: episodeInfo.name || '',
        } : {}),
      }
      const now = Date.now()
      // Forzar persist en "visto completo" o cierre del player — si la app
      // muere justo después, el progreso no puede perderse por el throttle.
      if (force || now - lastProgressPersist >= PROGRESS_PERSIST_MS || progress >= 0.97) {
        lastProgressPersist = now
        persist(PERSISTED_KEYS.watchHistory, updated)
      }
      set({ watchHistory: updated })
    }

    // Auto-mark episode as watched when progress >= 97%.
    // This runs even if the content isn't in watchHistory (idx === -1),
    // because the tick only depends on watchedEpisodes.
    if (episodeInfo && progress >= 0.97) {
      const key = `${id}:S${episodeInfo.season}:E${episodeInfo.episode}`
      const watched = get().watchedEpisodes
      if (!watched[key] || watched[key].progress < 0.97) {
        const updatedWatched = capWatched({ ...watched, [key]: { watchedAt: Date.now(), progress: 1 } })
        persist(PERSISTED_KEYS.watchedEpisodes, updatedWatched)
        set({ watchedEpisodes: updatedWatched })
      }
    }
  },

  removeFromHistory: (id, type) => {
    const updated = get().watchHistory.filter(h => !(h.id === id && h.type === type))
    persist(PERSISTED_KEYS.watchHistory, updated)
    set({ watchHistory: updated })
  },

  clearHistory: () => {
    persist(PERSISTED_KEYS.watchHistory, [])
    set({ watchHistory: [] })
  },

  // Setters for sync (replace entire state)
  setFavorites: (items) => {
    persist(PERSISTED_KEYS.favorites, items)
    set({ favorites: items })
  },
  setWatchHistory: (items) => {
    persist(PERSISTED_KEYS.watchHistory, items)
    set({ watchHistory: items })
  },
  setWatchedEpisodes: (items) => {
    const capped = capWatched(items || {})
    persist(PERSISTED_KEYS.watchedEpisodes, capped)
    set({ watchedEpisodes: capped })
  },

  // Mark an episode as watched (>= 97% progress). Key: "seriesId:Sseason:Eepisode"
  markEpisodeWatched: (seriesId, season, episode) => {
    const key = `${seriesId}:S${season}:E${episode}`
    const watched = { ...get().watchedEpisodes }
    if (!watched[key] || watched[key].progress < 0.97) {
      watched[key] = { watchedAt: Date.now(), progress: 1 }
      const capped = capWatched(watched)
      persist(PERSISTED_KEYS.watchedEpisodes, capped)
      set({ watchedEpisodes: capped })
    }
  },

  // Check if an episode has been watched
  isEpisodeWatched: (seriesId, season, episode) => {
    const key = `${seriesId}:S${season}:E${episode}`
    const watched = get().watchedEpisodes
    return !!(watched[key] && watched[key].progress >= 0.97)
  },

  // Check if all episodes of a season are watched
  isSeasonWatched: (seriesId, season, episodeCount) => {
    if (!episodeCount || episodeCount === 0) return false
    const watched = get().watchedEpisodes
    for (let ep = 1; ep <= episodeCount; ep++) {
      const key = `${seriesId}:S${season}:E${ep}`
      if (!watched[key] || watched[key].progress < 0.97) return false
    }
    return true
  },

  addYoutubeSearch: (query) => {
    get().ensureYoutubeHistory()
    const q = query.trim()
    if (!q) return
    const existing = get().youtubeSearchHistory.filter(h => h.toLowerCase() !== q.toLowerCase())
    const updated = [q, ...existing].slice(0, 20) // keep last 20
    persist(PERSISTED_KEYS.youtubeSearchHistory, updated)
    set({ youtubeSearchHistory: updated })
  },

  removeYoutubeSearch: (query) => {
    get().ensureYoutubeHistory()
    const updated = get().youtubeSearchHistory.filter(h => h !== query)
    persist(PERSISTED_KEYS.youtubeSearchHistory, updated)
    set({ youtubeSearchHistory: updated })
  },

  clearYoutubeSearchHistory: () => {
    get().ensureYoutubeHistory()
    persist(PERSISTED_KEYS.youtubeSearchHistory, [])
    set({ youtubeSearchHistory: [] })
  },

  addYoutubeLiveSearch: (query) => {
    get().ensureYoutubeHistory()
    const q = query.trim()
    if (!q) return
    const existing = get().youtubeLiveSearchHistory.filter(h => h.toLowerCase() !== q.toLowerCase())
    const updated = [q, ...existing].slice(0, 20)
    persist(PERSISTED_KEYS.youtubeLiveSearchHistory, updated)
    set({ youtubeLiveSearchHistory: updated })
  },

  removeYoutubeLiveSearch: (query) => {
    get().ensureYoutubeHistory()
    const updated = get().youtubeLiveSearchHistory.filter(h => h !== query)
    persist(PERSISTED_KEYS.youtubeLiveSearchHistory, updated)
    set({ youtubeLiveSearchHistory: updated })
  },

  clearYoutubeLiveSearchHistory: () => {
    persist(PERSISTED_KEYS.youtubeLiveSearchHistory, [])
    set({ youtubeLiveSearchHistory: [] })
  },
}))
