import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

const SERVER_URL =
  (import.meta.env && import.meta.env.VITE_REPELIS_SERVER_URL) ||
  (typeof process !== 'undefined' && process.env && process.env.REPELIS_SERVER_URL) ||
  'https://odeiserver.online/repelis'

async function api(path) {
  const res = await fetch(`${SERVER_URL}${path}`)
  if (!res.ok) throw new Error(`Repelis API error ${res.status}: ${path}`)
  return res.json()
}

function normalizeItem(item) {
  return {
    id: `${item.channel}:${item.id}`,
    type: item.type || CONTENT_TYPES.MOVIE,
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
    format: stream.url.includes('.m3u8') ? 'm3u8' : 'mp4',
    quality: stream.quality,
    headers: stream.headers || {},
    referer: stream.headers?.Referer || '',
  }
}

const manifest = new PluginManifest({
  id: 'repelis',
  name: 'Repelis Server',
  version: '0.1.0',
  description: 'Películas y series desde el servidor Repelis scraper',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  icon: '',
})

export const repelisPlugin = createPlugin(manifest, {
  async getCatalogs() {
    const catalogs = await api('/api/catalogs')
    return catalogs.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
    }))
  },

  async getCatalog({ id, skip = 0, top = 50 }) {
    const catalogs = await api('/api/catalogs')
    const catalog = catalogs.find(c => c.id === id)
    if (!catalog) return []
    const items = await api(`/api/catalog/${catalog.channel}/${catalog.id}?skip=${skip}&top=${top}`)
    return items.map(normalizeItem)
  },

  async getMeta({ id }) {
    if (!id.includes(':')) return null
    const [channel, itemId] = id.split(':')
    const meta = await api(`/api/meta/${channel}/${itemId}`)
    if (!meta) return null
    return normalizeItem(meta)
  },

  async getStreams({ id }) {
    if (!id.includes(':')) return []
    const [channel, itemId] = id.split(':')
    const streams = await api(`/api/streams/${channel}/${itemId}`)
    return streams.map(normalizeStream)
  },

  async search({ query }) {
    const results = await api(`/api/search?q=${encodeURIComponent(query)}`)
    return results.map(normalizeItem)
  },
})

export default repelisPlugin
