import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'
import { validateCustomPluginConfig } from './schemas.js'

function replaceParams(url, params) {
  let result = url
  Object.entries(params).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)))
  })
  return result
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function createCustomPlugin(config) {
  const validation = validateCustomPluginConfig(config)
  if (!validation.success) {
    throw new Error('Invalid plugin config: ' + validation.error.errors.map(e => e.message).join(', '))
  }
  const manifest = new PluginManifest({
    id: config.id,
    name: config.name,
    version: config.version || '1.0.0',
    description: config.description || 'Plugin personalizado',
    types: config.types || [CONTENT_TYPES.MOVIE],
    catalogs: config.catalogs || [],
    icon: config.icon || 'film',
  })

  const api = config.api || {}

  return createPlugin(manifest, {
    async getCatalog({ type, id, skip = 0, top = 50 }) {
      if (!api.catalog) return []
      const url = `${api.baseUrl}${replaceParams(api.catalog, { type, id, skip, top })}`
      const data = await fetchJson(url)
      return Array.isArray(data) ? data : (data.items || data.results || [])
    },

    async getMeta({ type, id }) {
      if (!api.meta) return null
      const url = `${api.baseUrl}${replaceParams(api.meta, { type, id })}`
      return fetchJson(url)
    },

    async getStreams({ type, id }) {
      if (!api.streams) return []
      const url = `${api.baseUrl}${replaceParams(api.streams, { type, id })}`
      const data = await fetchJson(url)
      return Array.isArray(data) ? data : (data.streams || data.items || [])
    },

    async search({ query }) {
      if (!api.search) return []
      const url = `${api.baseUrl}${replaceParams(api.search, { query })}`
      const data = await fetchJson(url)
      return Array.isArray(data) ? data : (data.items || data.results || [])
    },
  })
}
