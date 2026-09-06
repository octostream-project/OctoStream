import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

let _serverUrl = null

async function discoverServerUrl() {
  if (_serverUrl) return _serverUrl

  const envUrl =
    (import.meta.env && import.meta.env.VITE_PLURTASKO_SERVER_URL) ||
    (typeof process !== 'undefined' && process.env && process.env.PLURTASKO_SERVER_URL)

  if (envUrl) {
    _serverUrl = envUrl
    return _serverUrl
  }

  // Try to read the remote manifest url from the plugin's own configuration
  // If this plugin was loaded by manifest URL, it will be stored by the manager
  const configs = JSON.parse(localStorage.getItem('octo_custom_plugins') || '[]')
  const cfg = configs.find(c => c.id === 'plurtasko')
  const manifestUrl = cfg?.manifestUrl

  if (manifestUrl) {
    try {
      const res = await fetch(manifestUrl)
      if (res.ok) {
        const manifest = await res.json()
        const baseUrl = manifest?.api?.baseUrl
        if (baseUrl) {
          _serverUrl = baseUrl
          return _serverUrl
        }
      }
    } catch (e) {
      console.warn('[Plurtasko] discover failed', e)
    }
  }

  _serverUrl = 'http://localhost:8766'
  return _serverUrl
}

async function api(path) {
  const serverUrl = await discoverServerUrl()
  const res = await fetch(`${serverUrl}${path}`)
  if (!res.ok) throw new Error(`Plurtasko API error ${res.status}: ${path}`)
  return res.json()
}

function normalizeItem(item) {
  return {
    id: `${item.id}`,
    type: item.type === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE,
    name: item.title,
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
    description: item.description,
    year: item.year,
    rating: item.rating ? parseFloat(item.rating) : null,
    duration: item.duration,
    genres: item.genres,
  }
}

function normalizeStream(stream) {
  return {
    name: stream.name,
    url: stream.url,
    format: stream.url && stream.url.includes('.m3u8') ? 'm3u8' : 'mp4',
    quality: stream.quality,
    headers: stream.headers || {},
    referer: stream.headers?.Referer || '',
  }
}

const manifest = new PluginManifest({
  id: 'plurtasko',
  name: 'Plurtasko',
  version: '1.0.0',
  description: 'Películas y series desde Plurtasko (Alfa/Balandro style)',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  icon: '',
})

export const plurtaskoPlugin = createPlugin(manifest, {
  async getCatalogs() {
    const data = await api('/manifest.json')
    return (data.catalogs || []).map(c => ({
      id: c.id,
      name: c.name,
      type: c.types[0] || CONTENT_TYPES.MOVIE,
    }))
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const items = await api(`/catalog/${id}?skip=${skip}&top=${top}`)
    return items.map(normalizeItem)
  },

  async getMeta({ id }) {
    if (!id.includes(':')) return null
    const meta = await api(`/meta/${id}`)
    if (!meta) return null
    return normalizeItem(meta)
  },

  async getStreams({ id }) {
    if (!id.includes(':')) return []
    const streams = await api(`/streams/${id}`)
    return streams.map(normalizeStream)
  },

  async search({ query }) {
    const results = await api(`/search?q=${encodeURIComponent(query)}`)
    return results.map(normalizeItem)
  },
})

export default plurtaskoPlugin
