import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'
import { tmdbPlugin } from './tmdb.js'
import { embedStreamPlugin } from './embedStream.js'
import { openSubtitlesPlugin } from './openSubtitles.js'
import { esLanguagePlugin } from './languages/es.js'
import { enLanguagePlugin } from './languages/en.js'
import { logError, logWarn } from '../utils/logger.js'

const META_TIMEOUT_MS = 8000

function withTimeout(promise, ms, pluginId) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Plugin ${pluginId} getMeta timed out after ${ms}ms`)), ms)
    ),
  ])
}

class PluginManager {
  constructor() {
    this.availablePlugins = []
    this.languagePlugins = []
    this.installedPluginIds = new Set(
      JSON.parse(localStorage.getItem('optopus_installed_plugins') || '["tmdb","embed-stream"]')
    )
    this.plugins = []
    this.registerAvailable()
    this.loadInstalled()
  }

  registerAvailable() {
    this.availablePlugins = [
      tmdbPlugin,
      embedStreamPlugin,
      openSubtitlesPlugin,
    ]
    this.languagePlugins = [
      esLanguagePlugin,
      enLanguagePlugin,
    ]
  }

  loadInstalled() {
    this.plugins = this.availablePlugins.filter(p =>
      this.installedPluginIds.has(p.manifest.id)
    )
  }

  getPlugins() {
    return this.availablePlugins
  }

  getInstalledPlugins() {
    return this.plugins
  }

  getLanguagePlugins() {
    return this.languagePlugins
  }

  getLanguagePack(pluginId) {
    const plugin = this.languagePlugins.find(p => p.id === pluginId)
    if (!plugin || typeof plugin.getLanguagePack !== 'function') return null
    return plugin.getLanguagePack()
  }

  installPlugin(pluginId) {
    this.installedPluginIds.add(pluginId)
    localStorage.setItem('optopus_installed_plugins', JSON.stringify([...this.installedPluginIds]))
    this.loadInstalled()
  }

  uninstallPlugin(pluginId) {
    this.installedPluginIds.delete(pluginId)
    localStorage.setItem('optopus_installed_plugins', JSON.stringify([...this.installedPluginIds]))
    this.loadInstalled()
  }

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
