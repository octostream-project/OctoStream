import { esLanguagePlugin } from './languages/es.js'
import { enLanguagePlugin } from './languages/en.js'
import { builtInPlugins } from './builtIn/index.js'
import { createExternalPlugin, fetchManifest } from './external/externalAdapter.js'
import { getBundledPlugin, isBundledPlugin } from './bundled/index.js'
import { logError, logWarn } from '../utils/logger.js'

const META_TIMEOUT_MS = 8000
const EXTERNAL_PLUGINS_KEY = 'optopus_external_plugins'
const INSTALLED_PLUGINS_KEY = 'optopus_installed_plugins'

function withTimeout(promise, ms, pluginId) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Plugin ${pluginId} getMeta timed out after ${ms}ms`)), ms)
    ),
  ])
}

// Create a plugin from an external config. If the config is marked as `bundled`,
// use the internal implementation instead of the REST/Stremio adapter.
function createPluginFromConfig(config) {
  if (isBundledPlugin(config)) {
    const manifest = config.manifest || config
    const factory = getBundledPlugin(manifest.id)
    if (factory) {
      return factory(config)
    }
    throw new Error(`Bundled plugin "${manifest.id}" is not available in this build`)
  }
  return createExternalPlugin(config)
}

class PluginManager {
  constructor() {
    this.installedPluginIds = new Set(
      JSON.parse(localStorage.getItem(INSTALLED_PLUGINS_KEY) || '["tmdb","embed-stream"]')
    )
    this.externalPluginConfigs = JSON.parse(localStorage.getItem(EXTERNAL_PLUGINS_KEY) || '[]')
    this.externalPlugins = []
    this.plugins = []
    this.languagePlugins = [esLanguagePlugin, enLanguagePlugin]
    this.builtInPlugins = builtInPlugins
    this.loadExternalPlugins()
    this.loadInstalled()
  }

  // Built-in plugins (Kodi-style repository) ----------------------------------
  getBuiltInPlugins() {
    return this.builtInPlugins
  }

  isBuiltInPlugin(pluginId) {
    return this.builtInPlugins.some(p => p.id === pluginId)
  }

  // External plugins (Stremio-style or bundled) -------------------------------
  loadExternalPlugins() {
    this.externalPlugins = []
    for (const config of this.externalPluginConfigs) {
      try {
        const plugin = createPluginFromConfig(config)
        this.externalPlugins.push(plugin)
      } catch (e) {
        logError('Failed to load external plugin', String(e?.message || e))
      }
    }
  }

  saveExternalPlugins() {
    localStorage.setItem(EXTERNAL_PLUGINS_KEY, JSON.stringify(this.externalPluginConfigs))
  }

  getExternalPlugins() {
    return this.externalPlugins
  }

  async addExternalPluginByUrl(manifestUrl) {
    const manifest = await fetchManifest(manifestUrl)
    const config = { manifestUrl, manifest, baseUrl: manifestUrl.replace(/\/manifest\.json$/, '') }
    return this.addExternalPlugin(config)
  }

  addExternalPlugin(config) {
    const plugin = createPluginFromConfig(config)
    if (this.externalPlugins.some(p => p.id === plugin.id)) {
      throw new Error(`External plugin ${plugin.id} is already installed`)
    }
    this.externalPlugins.push(plugin)
    this.externalPluginConfigs.push(config)
    this.saveExternalPlugins()
    // Auto-install bundled plugins so they appear immediately.
    if (plugin.isBundled) {
      this.installedPluginIds.add(plugin.id)
      localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify([...this.installedPluginIds]))
    }
    this.loadInstalled()
    return plugin
  }

  removeExternalPlugin(pluginId) {
    this.externalPlugins = this.externalPlugins.filter(p => p.id !== pluginId)
    this.externalPluginConfigs = this.externalPluginConfigs.filter(c => (c.manifest?.id || c.id) !== pluginId)
    this.installedPluginIds.delete(pluginId)
    this.saveExternalPlugins()
    localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify([...this.installedPluginIds]))
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

  installPlugin(pluginId) {
    if (!this.getAllAvailablePlugins().some(p => p.id === pluginId)) {
      throw new Error(`Plugin ${pluginId} not found`)
    }
    this.installedPluginIds.add(pluginId)
    localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify([...this.installedPluginIds]))
    this.loadInstalled()
  }

  uninstallPlugin(pluginId) {
    this.installedPluginIds.delete(pluginId)
    localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify([...this.installedPluginIds]))
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
  getAllCatalogs() {
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
    const plugin = this.plugins.find(p => p.id === pluginId)
    if (!plugin) return []
    return plugin.getCatalog({ type, id: catalogId, skip, top })
  }

  async getMeta(type, id) {
    const results = await Promise.allSettled(
      this.plugins.map(plugin =>
        withTimeout(plugin.getMeta({ type, id }), META_TIMEOUT_MS, plugin.id)
      )
    )
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled' && result.value) {
        return { ...result.value, pluginId: this.plugins[i].id }
      }
      if (result.status === 'rejected') {
        logWarn(`getMeta failed in plugin ${this.plugins[i].id}`, String(result.reason?.message || result.reason))
      }
    }
    return null
  }

  async getStreams(type, id, name) {
    const allStreams = []
    for (const plugin of this.plugins) {
      try {
        const streams = await plugin.getStreams({ type, id, name })
        if (streams && streams.length > 0) {
          streams.forEach(s => allStreams.push({ ...s, pluginId: plugin.id, pluginName: plugin.name }))
        }
      } catch (e) {
        logError(`getStreams failed in plugin ${plugin.id}`, String(e?.message || e))
      }
    }
    return allStreams
  }

  async searchAll(query) {
    const results = []
    for (const plugin of this.plugins) {
      try {
        const items = await plugin.search({ query })
        if (items && items.length > 0) {
          items.forEach(item => results.push({ ...item, pluginId: plugin.id, pluginName: plugin.name }))
        }
      } catch (e) {
        logError(`search failed in plugin ${plugin.id}`, String(e?.message || e))
      }
    }
    return results
  }
}

export const pluginManager = new PluginManager()
