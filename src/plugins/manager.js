import { esLanguagePlugin } from './languages/es.js'
import { enLanguagePlugin } from './languages/en.js'
import { builtInPlugins } from './builtIn/index.js'
import { createExternalPlugin, fetchManifest } from './external/externalAdapter.js'
import { getBundledPlugin, isBundledPlugin } from './bundled/index.js'
import { logError, logWarn } from '../utils/logger.js'
import { validateExternalPluginConfig } from './schemas.js'
import { withCancelTimeout } from './utils.js'
import { getJsonSync, setJsonSync, removeItemSync, getItemSync } from '../utils/storage.js'

const META_TIMEOUT_MS = 8000
const SEARCH_TIMEOUT_MS = 15000
const STREAMS_TIMEOUT_MS = 15000 // resolvers pueden encadenar varios scrapes,
// pero un plugin que no responde en 15s está muerto — no retener el batch.

// Fuentes 4K/2160p/UHD descartadas: casi ningún dispositivo decodifica HEVC
// a esa resolución en tiempo real y los archivos debrid llegan a 80 GB —
// el usuario solo ve fuentes reproducibles de verdad.
const RE_4K = /\b(4k|2160p|uhd)\b/i
function is4kStream(s) {
  if (!s) return false
  if (RE_4K.test(String(s.quality || ''))) return true
  if (RE_4K.test(String(s.name || '')) || RE_4K.test(String(s.title || ''))) return true
  try {
    const file = decodeURIComponent(String(s.url || '').split('?')[0].split('/').pop() || '')
    return RE_4K.test(file)
  } catch { return false }
}
const EPG_TIMEOUT_MS = 12000
const EXTERNAL_PLUGINS_KEY = 'octostream_external_plugins'
const INSTALLED_PLUGINS_KEY = 'octostream_installed_plugins'
const PLUGIN_PERF_KEY = 'octostream_plugin_perf_metrics'
function recordPluginPerf(operation, pluginId, durationMs, count = 0, error = '') {
  const metric = { operation, pluginId, durationMs, count, error, ts: Date.now() }
  try {
    const recent = getJsonSync(PLUGIN_PERF_KEY, [])
    setJsonSync(PLUGIN_PERF_KEY, [metric, ...(Array.isArray(recent) ? recent : [])].slice(0, 40))
  } catch { /* métricas opcionales */ }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('octostream:plugin-perf', { detail: metric }))
  } catch { /* sin eventos en runtimes headless */ }
}
const DEFAULT_INSTALLED = ['tmdb', 'embed-stream', 'tdtspain', 'plurtasko', 'anilist', 'fctv', 'opensubtitles', 'screensaver']

// Solo se conservan plugins incluidos en la aplicación. Los manifiestos
// externos instalados anteriormente se descartan para evitar código remoto
// antiguo o no autorizado en la instalación actual.
const BUILT_IN_IDS = new Set(builtInPlugins.map(plugin => plugin.id))

// Plugins externos incluidos en el APK (bundled, no requieren servidor remoto).
const DEFAULT_BUNDLED_PLUGINS = [
  {
    bundled: true,
    manifest: {
      id: 'tdtspain',
      name: 'TDT Spain',
      version: '1.0.0',
      description: 'TDT España: directos, EPG y últimos 7 días.',
      bundled: true,
      types: ['live', 'channel'],
    },
  },
  {
    bundled: true,
    manifest: {
      id: 'plurtasko',
      name: 'Plurtasko',
      version: '1.0.0',
      description: 'Canales de películas, series y anime.',
      bundled: true,
      types: ['movie', 'series', 'anime', 'dorama'],
    },
  },
  {
    bundled: true,
    manifest: {
      id: 'anilist',
      name: 'AniList',
      version: '1.0.0',
      description: 'Catálogo de anime con sinopsis, géneros y estudios desde AniList.',
      bundled: true,
      types: ['anime', 'series'],
    },
  },
  {
    bundled: true,
    manifest: {
      id: 'fctv',
      name: 'FCTV Deportes',
      version: '1.0.0',
      description: 'Deportes en directo: fútbol, baloncesto, tenis, motor y más.',
      bundled: true,
      types: ['channel'],
    },
  },
  {
    bundled: true,
    manifest: {
      id: 'dlive',
      name: 'DLive Deportes',
      version: '1.0.0',
      description: 'Deportes en directo desde dlive (DaddyLive).',
      bundled: true,
      types: ['channel'],
    },
  },
  {
    bundled: true,
    manifest: {
      id: 'palantir',
      name: 'Palantir 3',
      version: '1.0.0',
      description: 'Catálogo Palantir 3: películas, series, anime y documentales (requiere debrid).',
      bundled: true,
      types: ['movie', 'series', 'anime'],
    },
  },
]

const INCLUDED_PLUGIN_IDS = new Set(DEFAULT_BUNDLED_PLUGINS.map(cfg => cfg.manifest.id))

// Create a plugin from an external config. If the config is marked as `bundled`,
// use the internal implementation instead of the REST/Stremio adapter.
// Async: las factories bundled se cargan con import() dinámico bajo demanda.
async function createPluginFromConfig(config) {
  if (isBundledPlugin(config)) {
    const manifest = config.manifest || config
    const factory = await getBundledPlugin(manifest.id)
    if (factory) {
      return factory(config)
    }
    throw new Error(`Bundled plugin "${manifest.id}" is not available in this build`)
  }
  return createExternalPlugin(config)
}

export class PluginManager {
  constructor(externalPluginConfigs = null, installedIds = null) {
    // Si hay lista guardada se respeta tal cual (un "Desinstalar" del usuario
    // debe sobrevivir al reinicio); solo se siembran los defaults en el
    // primer arranque o si el valor persistido está corrupto.
    const storedInstalled = getJsonSync(INSTALLED_PLUGINS_KEY, null)
    const hasStoredList = Array.isArray(storedInstalled)
    const installedArr = (hasStoredList ? storedInstalled : DEFAULT_INSTALLED)
      .filter(id => BUILT_IN_IDS.has(id) || INCLUDED_PLUGIN_IDS.has(id))
    const storedExternal = getJsonSync(EXTERNAL_PLUGINS_KEY, [])
    const storedExternalArr = Array.isArray(storedExternal) ? storedExternal : []
    // Eliminar configuraciones de addons remotos antiguos. Se conservan solo
    // los plugins bundled que forman parte del APK.
    const bundledIds = new Set(DEFAULT_BUNDLED_PLUGINS.map(cfg => cfg.manifest.id))
    const localStoredExternal = storedExternalArr
      .filter(cfg => bundledIds.has(cfg?.manifest?.id || cfg?.id))
    // Merge stored bundled plugins with defaults (avoid duplicates by id).
    // freshBundledIds = bundled nuevos en esta versión → se auto-instalan
    // para que las migraciones los activen sin pisar las desinstalaciones.
    const mergedExternal = []
    const freshBundledIds = []
    for (const cfg of DEFAULT_BUNDLED_PLUGINS) {
      const id = cfg.manifest?.id || cfg.id
      if (id && !storedExternalArr.some(e => (e.manifest?.id || e.id) === id)) {
        mergedExternal.push(cfg)
        freshBundledIds.push(id)
      }
    }
    for (const cfg of localStoredExternal) {
      if (!mergedExternal.some(e => (e.manifest?.id || e.id) === (cfg.manifest?.id || cfg.id))) {
        mergedExternal.push(cfg)
      }
    }
    for (const id of freshBundledIds) {
      if (!installedArr.includes(id)) installedArr.push(id)
    }
    this.installedPluginIds = new Set(installedIds ?? installedArr)
    const providedExternal = Array.isArray(externalPluginConfigs) ? externalPluginConfigs : mergedExternal
    this.externalPluginConfigs = providedExternal.filter(cfg =>
      INCLUDED_PLUGIN_IDS.has(cfg?.manifest?.id || cfg?.id)
    )
    this.externalPlugins = []
    this.plugins = []
    this.languagePlugins = [esLanguagePlugin, enLanguagePlugin]
    this.builtInPlugins = builtInPlugins
    // Persist merged external plugins so new bundled plugins are saved
    setJsonSync(EXTERNAL_PLUGINS_KEY, this.externalPluginConfigs)
    // Persist updated installed list
    setJsonSync(INSTALLED_PLUGINS_KEY, [...this.installedPluginIds])
    // Los plugins bundled (plurtasko, tdtspain) NO se cargan aquí: sus módulos
    // se importan dinámicamente en ensureReady() para no bloquear el arranque.
    this._readyPromise = null
    this.loadInstalled()
  }

  // Carga diferida de plugins bundled/externos. Todos los métodos públicos que
  // tocan this.plugins la esperan; es idempotente y comparte la misma promise.
  ensureReady() {
    if (!this._readyPromise) {
      this._readyPromise = this.loadExternalPlugins()
    }
    return this._readyPromise
  }

  // Built-in plugins ----------------------------------------------------------
  getBuiltInPlugins() {
    return this.builtInPlugins
  }

  isBuiltInPlugin(pluginId) {
    return this.builtInPlugins.some(p => p.id === pluginId)
  }

  // External plugins (Stremio-style or bundled) -------------------------------
  async loadExternalPlugins() {
    this.externalPlugins = []
    console.log('[PluginManager] Loading external plugins, configs:', this.externalPluginConfigs.map(c => c?.manifest?.id || c?.id))
    // En paralelo: N plugins externos no se encadenan en el arranque.
    const loaded = await Promise.allSettled(
      this.externalPluginConfigs.map(config => createPluginFromConfig(config))
    )
    for (let i = 0; i < loaded.length; i++) {
      const r = loaded[i]
      const cfg = this.externalPluginConfigs[i]
      if (r.status === 'fulfilled' && r.value) {
        this.externalPlugins.push(r.value)
        console.log('[PluginManager] Loaded plugin:', r.value.id)
      } else if (r.status === 'rejected') {
        console.error('[PluginManager] Failed to load plugin:', cfg?.manifest?.id || cfg?.id, r.reason?.message)
      }
    }
    console.log('[PluginManager] All external plugins loaded:', this.externalPlugins.map(p => p.id))
    this.loadInstalled()
  }

  saveExternalPlugins() {
    setJsonSync(EXTERNAL_PLUGINS_KEY, this.externalPluginConfigs)
  }

  getExternalPlugins() {
    return this.externalPlugins
  }

  async addExternalPluginByUrl(manifestUrl) {
    await this.ensureReady()
    const manifest = await fetchManifest(manifestUrl)
    const config = { manifestUrl, manifest, baseUrl: manifestUrl.replace(/\/manifest\.json$/, '') }
    return this.addExternalPlugin(config)
  }

  async addExternalPlugin(config) {
    const candidateId = config.manifest?.id || config.id
    if (!INCLUDED_PLUGIN_IDS.has(candidateId)) {
      throw new Error('Los plugins externos están desactivados en esta versión')
    }
    const validation = validateExternalPluginConfig(config.manifest || config)
    if (!validation.success) {
      throw new Error('Invalid plugin manifest: ' + validation.error.errors.map(e => e.message).join(', '))
    }
    const plugin = await createPluginFromConfig(config)
    if (this.externalPlugins.some(p => p.id === plugin.id)) {
      throw new Error(`External plugin ${plugin.id} is already installed`)
    }
    this.externalPlugins.push(plugin)
    this.externalPluginConfigs.push(config)
    this.saveExternalPlugins()
    // Auto-install bundled plugins so they appear immediately.
    if (plugin.isBundled) {
      this.installedPluginIds.add(plugin.id)
      setJsonSync(INSTALLED_PLUGINS_KEY, [...this.installedPluginIds])
    }
    this.loadInstalled()
    return plugin
  }

  async removeExternalPlugin(pluginId) {
    await this.ensureReady()
    this.externalPlugins = this.externalPlugins.filter(p => p.id !== pluginId)
    this.externalPluginConfigs = this.externalPluginConfigs.filter(c => (c.manifest?.id || c.id) !== pluginId)
    this.installedPluginIds.delete(pluginId)
    this.saveExternalPlugins()
    setJsonSync(INSTALLED_PLUGINS_KEY, [...this.installedPluginIds])
    this.loadInstalled()
  }

  // All plugins --------------------------------------------------------------
  getAllAvailablePlugins() {
    return [...this.builtInPlugins, ...this.externalPlugins]
  }

  getPlugins() {
    return this.getAllAvailablePlugins()
  }

  loadInstalled() {
    this.plugins = this.getAllAvailablePlugins().filter(p =>
      this.installedPluginIds.has(p.id)
    )
  }

  getInstalledPlugins() {
    return this.plugins
  }

  async installPlugin(pluginId) {
    await this.ensureReady()
    if (!this.getAllAvailablePlugins().some(p => p.id === pluginId)) {
      throw new Error(`Plugin ${pluginId} not found`)
    }
    this.installedPluginIds.add(pluginId)
    setJsonSync(INSTALLED_PLUGINS_KEY, [...this.installedPluginIds])
    this.loadInstalled()
  }

  async uninstallPlugin(pluginId) {
    await this.ensureReady()
    this.installedPluginIds.delete(pluginId)
    setJsonSync(INSTALLED_PLUGINS_KEY, [...this.installedPluginIds])
    this.loadInstalled()
  }

  // Language packs -----------------------------------------------------------
  getLanguagePlugins() {
    return this.languagePlugins
  }

  getLanguagePack(pluginId) {
    const plugin = this.languagePlugins.find(p => p.id === pluginId)
    if (!plugin || typeof plugin.getLanguagePack !== 'function') return null
    return plugin.getLanguagePack()
  }

  // Catalogs / content -------------------------------------------------------
  async getAllCatalogs() {
    await this.ensureReady()
    const catalogs = []
    this.plugins.forEach(plugin => {
      if (plugin.manifest.catalogs) {
        plugin.manifest.catalogs.forEach(cat => {
          catalogs.push({ ...cat, pluginId: plugin.id, pluginName: plugin.name })
        })
      }
    })
    return catalogs
  }

  async getCatalogContent(pluginId, catalogId, type, skip = 0, top = 50) {
    await this.ensureReady()
    const plugin = this.plugins.find(p => p.id === pluginId)
    if (!plugin) {
      logWarn(`getCatalogContent: plugin ${pluginId} no instalado (instalados: ${this.plugins.map(p=>p.id).join(',')})`)
      return []
    }
    try {
      return await withCancelTimeout(
        sig => plugin.getCatalog({ type, id: catalogId, skip, top, signal: sig }),
        SEARCH_TIMEOUT_MS, null, `getCatalog timeout in ${plugin.id}`)
    } catch (e) {
      logError(`getCatalog failed in plugin ${plugin.id}`, String(e?.message || e))
      return []
    }
  }

  matchingPlugins(type, id) {
    const compatible = this.plugins.filter(p =>
      !p.manifest?.types || p.manifest.types.includes(type)
    )
    const explicitId = typeof id === 'string'
      ? (id.match(/^([a-z0-9-]+):/i)?.[1]
        || id.match(/^(tdtspain|tmdb|anilist)-/i)?.[1])
      : null
    if (!explicitId) return compatible
    const owner = compatible.find(plugin => plugin.id === explicitId)
    return owner ? [owner] : compatible
  }

  async getMeta(type, id, signal) {
    await this.ensureReady()
    const candidates = this.matchingPlugins(type, id)
    const results = await Promise.allSettled(
      candidates.map(plugin =>
        withCancelTimeout(sig => plugin.getMeta({ type, id, signal: sig }), META_TIMEOUT_MS, signal, plugin.id)
      )
    )
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled' && result.value) {
        return { ...result.value, pluginId: candidates[i].id }
      }
      if (result.status === 'rejected') {
        logWarn(`getMeta failed in plugin ${candidates[i].id}`, String(result.reason?.message || result.reason))
      }
    }
    return null
  }

  // In-memory stream cache: key = type+id, value = { streams, ts }
  // Streams expire quickly because tokens/URLs are short-lived (5 min TTL)
  static streamCache = new Map()
  static STREAM_TTL_MS = 4 * 60 * 1000 // 4 minutes
  // Persistencia a disco: las fichas re-abiertas tras reiniciar la app no
  // re-resuelven nada si la entrada tiene <60min. En memoria el TTL sigue
  // siendo 4min (frescura); en disco 60min (utilidad real).
  static STREAM_DISK_TTL_MS = 60 * 60 * 1000
  static STREAM_DISK_KEY = 'octostream_stream_cache_v1'
  static _diskLoaded = false

  static _loadDiskCache() {
    if (PluginManager._diskLoaded) return
    PluginManager._diskLoaded = true
    try {
      const raw = JSON.parse(localStorage.getItem(PluginManager.STREAM_DISK_KEY) || '[]')
      const now = Date.now()
      for (const [k, v] of raw) {
        if (v?.ts && now - v.ts < PluginManager.STREAM_DISK_TTL_MS
            && !v.streams?.some(s => s._noCache)) {
          PluginManager.streamCache.set(k, { streams: v.streams, ts: v.ts, disk: true })
        }
      }
    } catch { /* JSON corrupto */ }
  }

  static _persistDiskCache() {
    try {
      const arr = [...PluginManager.streamCache.entries()]
        .filter(([, v]) => !v.streams?.some(s => s._noCache))
        .slice(-30)
      localStorage.setItem(PluginManager.STREAM_DISK_KEY, JSON.stringify(arr))
    } catch { /* cuota llena */ }
  }

  static _cacheValid(cached) {
    const ttl = cached?.disk ? PluginManager.STREAM_DISK_TTL_MS : PluginManager.STREAM_TTL_MS
    return cached && (Date.now() - cached.ts < ttl)
  }

  // Clear stale stream cache (called on app init)
  static clearStreamCache() {
    PluginManager.streamCache.clear()
    try { localStorage.removeItem(PluginManager.STREAM_DISK_KEY) } catch { /* sin storage */ }
  }

  async getStreams(type, id, name, signal, genres, season, episode, originalName, originCountry, originalLanguage, englishName, year) {
    await this.ensureReady()
    // Check cache first - avoids re-fetching when navigating back
    const cacheKey = `${type}:${id}${season ? `:S${season}E${episode || ''}` : ''}`
    PluginManager._loadDiskCache()
    const cached = PluginManager.streamCache.get(cacheKey)
    if (PluginManager._cacheValid(cached)) {
      return cached.streams
    }

    const candidates = this.plugins.filter(p =>
      !p.manifest?.types || p.manifest.types.includes(type)
    )
    // Streams en paralelo en todos los plugins a la vez (multihilo).
    const promises = candidates.map(async plugin => {
      const t0 = Date.now()
      try {
        const streams = await withCancelTimeout(
          sig => plugin.getStreams({ type, id, name, signal: sig, genres, season, episode, originalName, originCountry, originalLanguage, englishName, year }),
          STREAMS_TIMEOUT_MS, signal, `getStreams timeout in ${plugin.id}`)
        const duration = Date.now() - t0
        recordPluginPerf('getStreams', plugin.id, duration, streams?.length || 0)
        console.log(`[PM perf] getStreams ${plugin.id}: ${duration}ms (${streams?.length || 0})`)
        if (streams && streams.length > 0) {
          return streams.map(s => ({ ...s, pluginId: plugin.id, pluginName: plugin.name, direct: s.direct === true || plugin.id === 'tdtspain', bypassVpn: s.bypassVpn === true || plugin.id === 'tdtspain' }))
        }
        return []
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        const duration = Date.now() - t0
        recordPluginPerf('getStreams', plugin.id, duration, 0, e?.message || String(e))
        console.warn(`[PM perf] getStreams ${plugin.id}: falló tras ${duration}ms - ${e?.message || e}`)
        logError(`getStreams failed in plugin ${plugin.id}`, String(e?.message || e))
        return []
      }
    })
    const arrays = await Promise.all(promises)
    let allStreams = arrays.flat()

    // Ajuste "Búsquedas torrent" (Settings): cuando está apagado se descartan
    // los streams torrent/magnet de cualquier plugin (interno o externo).
    if (getItemSync('octostream_torrent_search') === 'false') {
      allStreams = allStreams.filter(s =>
        s.streamType !== 'torrent' && !/magnet:|\.torrent(\?|$)/i.test(String(s.url || '')))
    }
    // Fuentes 4K fuera: bitrate/tamaño inasumible en casi todo hardware.
    allStreams = allStreams.filter(s => !is4kStream(s))

    // Only cache non-empty results (don't cache failures). Streams marked
    // _noCache carry short-lived signed URLs (p.ej. DLive, ~4 min) — caching
    // them would serve dead tokens on retry.
    if (allStreams.length > 0 && !allStreams.some(s => s._noCache)) {
      PluginManager.streamCache.set(cacheKey, { streams: allStreams, ts: Date.now() })
      if (PluginManager.streamCache.size > 50) {
        const oldest = PluginManager.streamCache.keys().next().value
        if (oldest) PluginManager.streamCache.delete(oldest)
      }
      PluginManager._persistDiskCache()
    }

    return allStreams
  }

  // Progressive stream loading: calls onBatch as each plugin returns streams.
  // Returns the full list when all plugins finish.
  async getStreamsProgressive(type, id, name, signal, onBatch, genres, season, episode, originalName, originCountry, originalLanguage, seasonsList, englishName, year) {

    await this.ensureReady()
    // Check cache first
    const cacheKey = `${type}:${id}${season ? `:S${season}E${episode || ''}` : ''}`
    PluginManager._loadDiskCache()
    const cached = PluginManager.streamCache.get(cacheKey)
    if (PluginManager._cacheValid(cached)) {
      if (onBatch) onBatch(cached.streams)
      return cached.streams
    }

    const candidates = this.plugins.filter(p =>
      !p.manifest?.types || p.manifest.types.includes(type)
    )
    let allStreams = []
    // Ajuste "Búsquedas torrent" (Settings) — también en carga progresiva.
    const torrentsOff = getItemSync('octostream_torrent_search') === 'false'
    const noTorrent = (s) => !(torrentsOff &&
      (s.streamType === 'torrent' || /magnet:|\.torrent(\?|$)/i.test(String(s.url || ''))))
    const keep = (s) => noTorrent(s) && !is4kStream(s)

    const promises = candidates.map(async plugin => {
      const t0 = Date.now()
      try {
        const pluginOnBatch = onBatch ? (batch) => {
          const tagged = batch.map(s => ({
            ...s,
            pluginId: plugin.id,
            pluginName: plugin.name,
            direct: s.direct === true || plugin.id === 'tdtspain',
            bypassVpn: s.bypassVpn === true || plugin.id === 'tdtspain',
          })).filter(keep)
          allStreams = allStreams.filter(s => s.pluginId !== plugin.id)
          allStreams = allStreams.concat(tagged)
          onBatch(allStreams)
        } : null
        const streams = await withCancelTimeout(
          sig => plugin.getStreams({ type, id, name, signal: sig, genres, season, episode, originalName, originCountry, originalLanguage, seasonsList, englishName, year, onBatch: pluginOnBatch }),
          STREAMS_TIMEOUT_MS, signal, `getStreams timeout in ${plugin.id}`)
        const duration = Date.now() - t0
        recordPluginPerf('getStreams*', plugin.id, duration, streams?.length || 0)
        console.log(`[PM perf] getStreams* ${plugin.id}: ${duration}ms (${streams?.length || 0})`)
        if (streams && streams.length > 0) {
          const tagged = streams.map(s => ({ ...s, pluginId: plugin.id, pluginName: plugin.name, direct: s.direct === true || plugin.id === 'tdtspain', bypassVpn: s.bypassVpn === true || plugin.id === 'tdtspain' })).filter(keep)
          allStreams = allStreams.filter(s => s.pluginId !== plugin.id)
          allStreams = allStreams.concat(tagged)
          if (onBatch) onBatch(allStreams)
          return tagged
        }
        return []
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        const duration = Date.now() - t0
        recordPluginPerf('getStreams*', plugin.id, duration, 0, e?.message || String(e))
        console.warn(`[PM perf] getStreams* ${plugin.id}: falló tras ${duration}ms - ${e?.message || e}`)
        logError(`getStreams failed in plugin ${plugin.id}`, String(e?.message || e))
        return []
      }
    })
    await Promise.all(promises)

    // Mismo criterio que getStreams: los streams _noCache (URLs firmadas de
    // vida corta, p.ej. DLive ~4 min) no se cachean — servirían tokens muertos.
    if (allStreams.length > 0 && !allStreams.some(s => s._noCache)) {
      PluginManager.streamCache.set(cacheKey, { streams: allStreams, ts: Date.now() })
      if (PluginManager.streamCache.size > 50) {
        const oldest = PluginManager.streamCache.keys().next().value
        if (oldest) PluginManager.streamCache.delete(oldest)
      }
      PluginManager._persistDiskCache()
    }

    return allStreams
  }

  // Search cache: key = query, value = { results, ts }
  static searchCache = new Map()
  static SEARCH_TTL_MS = 30 * 60 * 1000 // 30 minutes

  // Progressive search: calls onBatch with partial results as each plugin completes
  async searchAllProgressive(query, signal, onBatch) {
    await this.ensureReady()
    const q = (query || '').trim().toLowerCase()
    if (!q) return []

    // Check cache
    const cached = PluginManager.searchCache.get(q)
    if (cached && (Date.now() - cached.ts < PluginManager.SEARCH_TTL_MS)) {
      if (onBatch) onBatch(cached.results)
      return cached.results
    }

    const results = []
    let anyPluginOk = false
    const promises = this.plugins.map(async plugin => {
      const t0 = Date.now()
      try {
        const items = await withCancelTimeout(
          sig => plugin.search({ query, signal: sig }),
          SEARCH_TIMEOUT_MS, signal,
          `search timeout in ${plugin.id}`
        )
        anyPluginOk = true
        const duration = Date.now() - t0
        recordPluginPerf('search', plugin.id, duration, items?.length || 0)
        console.log(`[PM perf] search ${plugin.id}: ${duration}ms (${items?.length || 0})`)
        if (items && items.length > 0) {
          const tagged = items.map(item => ({ ...item, pluginId: plugin.id, pluginName: plugin.name }))
          results.push(...tagged)
          if (onBatch) onBatch([...results])
          return tagged
        }
        return []
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        const duration = Date.now() - t0
        recordPluginPerf('search', plugin.id, duration, 0, e?.message || String(e))
        console.warn(`[PM perf] search ${plugin.id}: falló tras ${duration}ms - ${e?.message || e}`)
        logError(`search failed in plugin ${plugin.id}`, String(e?.message || e))
        return []
      }
    })

    await Promise.allSettled(promises)

    // No cachear si todos los plugins fallaron (caída de red/WARP) o la
    // búsqueda se abortó a medias: un [] congelado 30 min ocultaría
    // resultados reales cuando la red volviera.
    if (!signal?.aborted && anyPluginOk) {
      PluginManager.searchCache.set(q, { results, ts: Date.now() })
    }
    if (PluginManager.searchCache.size > 30) {
      const oldest = PluginManager.searchCache.keys().next().value
      if (oldest) PluginManager.searchCache.delete(oldest)
    }

    return results
  }

  async getEpg(date, channelId) {
    await this.ensureReady()
    // En paralelo: antes era secuencial y cada plugin lento bloqueaba al siguiente
    const results = await Promise.all(this.plugins.map(async plugin => {
      try {
        if (typeof plugin.getEpg === 'function') {
          const programs = await withCancelTimeout(
            sig => plugin.getEpg({ date, channelId, signal: sig }),
            EPG_TIMEOUT_MS, null,
            `getEpg timeout in ${plugin.id}`)
          if (programs && programs.length > 0) {
            return programs.map(p => ({ ...p, pluginId: plugin.id, pluginName: plugin.name }))
          }
        }
      } catch (e) {
        logError(`getEpg failed in plugin ${plugin.id}`, String(e?.message || e))
      }
      return []
    }))
    return results.flat()
  }
}

// Clear stale TMDB disk cache and stream cache on startup
try { removeItemSync('octostream_tmdb_cache') } catch {}
PluginManager.clearStreamCache()

export const pluginManager = new PluginManager()
export default pluginManager
