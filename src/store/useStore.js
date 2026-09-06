import { create } from 'zustand'
import { pluginManager } from '../plugins/manager.js'

export const useStore = create((set, get) => ({
  plugins: [],
  installedPlugins: [],
  externalPlugins: [],
  activeCatalog: null,
  searchQuery: '',
  searchResults: [],
  loading: false,
  favorites: JSON.parse(localStorage.getItem('optopus_favorites') || '[]'),
  watchHistory: JSON.parse(localStorage.getItem('optopus_history') || '[]'),

  initPlugins: () => {
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
  },

  installPlugin: (pluginId) => {
    pluginManager.installPlugin(pluginId)
    set({ installedPlugins: pluginManager.getInstalledPlugins() })
  },

  uninstallPlugin: (pluginId) => {
    pluginManager.uninstallPlugin(pluginId)
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

  removeExternalPlugin: (pluginId) => {
    pluginManager.removeExternalPlugin(pluginId)
    set({
      plugins: pluginManager.getPlugins(),
      installedPlugins: pluginManager.getInstalledPlugins(),
      externalPlugins: pluginManager.getExternalPlugins(),
    })
  },

  setActiveCatalog: (catalog) => set({ activeCatalog: catalog }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  search: async (query) => {
    set({ loading: true, searchQuery: query })
    const results = await pluginManager.searchAll(query)
    set({ searchResults: results, loading: false })
  },

  toggleFavorite: (item) => {
    const favorites = get().favorites
    const exists = favorites.find(f => f.id === item.id && f.type === item.type)
    let updated
    if (exists) {
      updated = favorites.filter(f => !(f.id === item.id && f.type === item.type))
    } else {
      updated = [...favorites, item]
    }
    localStorage.setItem('optopus_favorites', JSON.stringify(updated))
    set({ favorites: updated })
  },

  isFavorite: (id, type) => {
    return get().favorites.some(f => f.id === id && f.type === type)
  },

  addToHistory: (item) => {
    const history = get().watchHistory.filter(h => !(h.id === item.id && h.type === item.type))
    const updated = [{ ...item, watchedAt: Date.now() }, ...history].slice(0, 50)
    localStorage.setItem('optopus_history', JSON.stringify(updated))
    set({ watchHistory: updated })
  },

  removeFromHistory: (id, type) => {
    const updated = get().watchHistory.filter(h => !(h.id === id && h.type === type))
    localStorage.setItem('optopus_history', JSON.stringify(updated))
    set({ watchHistory: updated })
  },

  clearHistory: () => {
    localStorage.setItem('optopus_history', JSON.stringify([]))
    set({ watchHistory: [] })
  },
}))
