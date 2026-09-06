import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { logError, logWarn } from '../../utils/logger.js'
import { sanitizeUrl } from '../../utils/sanitizeUrl.js'

const STREMIO_TO_CONTENT_TYPE = {
  movie: CONTENT_TYPES.MOVIE,
  series: CONTENT_TYPES.SERIES,
  channel: CONTENT_TYPES.CHANNEL,
  live: CONTENT_TYPES.LIVE,
  tv: CONTENT_TYPES.LIVE,
}

function toContentType(stremioType) {
  return STREMIO_TO_CONTENT_TYPE[stremioType] || CONTENT_TYPES.OTHER
}

function replaceParams(url, params) {
  let result = url
  Object.entries(params).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)))
  })
  return result
}

async function fetchJson(url) {
  const safeUrl = sanitizeUrl(url)
  if (!safeUrl) throw new Error('Unsafe or invalid URL')
  const res = await fetch(safeUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${safeUrl}`)
  return res.json()
}

function normalizeStremioMeta(item) {
  if (!item) return null
  const isSeries = item.type === 'series'
  const id = item.id || `${item.type}:${item.imdb_id || item.ids?.imdb || item.name}`
  return {
    id,
    type: toContentType(item.type),
    name: item.name || item.title || '',
    title: item.name || item.title || '',
    poster: item.poster || item.logo || null,
    backdrop: item.background || item.banner || null,
    description: item.description || '',
    year: item.year || item.releaseInfo ? parseInt(item.releaseInfo, 10) : null,
    rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
    genres: item.genres || [],
    releaseDate: item.releaseInfo,
    // Stremio specific passthrough
    stremioMeta: item,
  }
}

function normalizeStremioStream(stream) {
  if (!stream) return null
  // Stremio stream objects can be { url, title, name } or nested { externalUrl, ytId, infoHash, fileIdx }
  const url =
    stream.url ||
    stream.externalUrl ||
    (stream.ytId ? `https://www.youtube.com/watch?v=${stream.ytId}` : '') ||
    (stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : '')
  if (!url) return null
  return {
    name: stream.title || stream.name || 'External',
    url,
    streamType: stream.url ? 'mp4' : 'embed',
    quality: stream.tag || stream.quality || '',
    title: stream.title || '',
    behaviorHints: stream.behaviorHints || {},
  }
}

function detectStremioManifest(manifest) {
  // Stremio manifests are identified by the presence of a `resources` array.
  return Array.isArray(manifest.resources)
}

function buildStremioEndpoints(manifest) {
  const endpoints = {}
  const resources = manifest.resources || []
  const resourceNames = resources.map(r => (typeof r === 'string' ? r : r.name))

  if (resourceNames.includes('catalog')) endpoints.catalog = '/catalog/{type}/{id}.json'
  if (resourceNames.includes('meta')) endpoints.meta = '/meta/{type}/{id}.json'
  if (resourceNames.includes('stream')) endpoints.streams = '/stream/{type}/{id}.json'

  // Stremio search uses catalog endpoints with a `search` extra.
  // Pick the first available catalog as the default search target.
  const firstCatalog = (manifest.catalogs || [])[0]
  if (endpoints.catalog && firstCatalog) {
    endpoints.search = `/catalog/{type}/${firstCatalog.id}.json?search={query}`
  }
  return endpoints
}

function getCatalogTypes(manifest) {
  const catalogs = manifest.catalogs || []
  return catalogs.map(cat => ({
    id: cat.id || 'top',
    name: cat.name || cat.id || 'Catalog',
    type: toContentType(cat.type),
  }))
}

function deriveBaseUrl(config, isStremio) {
  if (config.baseUrl) {
    return sanitizeUrl(config.baseUrl)
  }
  if (config.api?.baseUrl) {
    return sanitizeUrl(config.api.baseUrl)
  }
  if (isStremio && config.manifestUrl) {
    const manifestUrl = sanitizeUrl(config.manifestUrl)
    if (!manifestUrl) return ''
    try {
      return new URL('..', manifestUrl).href.replace(/\/$/, '')
    } catch {
      return manifestUrl.replace(/\/manifest\.json$/i, '')
    }
  }
  return ''
}

export function createExternalPlugin(config) {
  const manifest = config.manifest || config
  const isStremio = detectStremioManifest(manifest)

  const baseUrl = deriveBaseUrl(config, isStremio)

  if (!baseUrl) {
    throw new Error('External plugin requires a valid baseUrl or manifestUrl')
  }

  const name = manifest.name || 'External Plugin'
  const pluginManifest = new PluginManifest({
    id: manifest.id || `external-${Date.now()}`,
    name,
    version: manifest.version || '1.0.0',
    description: manifest.description || `External plugin: ${name}`,
    types: isStremio
      ? (manifest.types || []).map(toContentType)
      : (manifest.types || [CONTENT_TYPES.MOVIE]),
    catalogs: isStremio ? getCatalogTypes(manifest) : (manifest.catalogs || []),
    icon: manifest.icon || manifest.logo || 'play',
  })

  const api = isStremio
    ? buildStremioEndpoints(manifest)
    : (config.api || {})

  // Attach original manifest/config for debugging and adapter hints.
  const plugin = createPlugin(pluginManifest, {
    isExternal: true,
    isStremio,
    baseUrl,
    originalManifest: manifest,

    async getCatalog({ type, id, skip = 0, top = 50 }) {
      if (!api.catalog) return []
      const url = `${baseUrl}${replaceParams(api.catalog, { type, id, skip, top })}`
      const safeUrl = sanitizeUrl(url)
      if (!safeUrl) return []
      try {
        const data = await fetchJson(safeUrl)
        if (isStremio) {
          const metas = data?.metas || []
          return metas.map(normalizeStremioMeta).filter(Boolean)
        }
        if (Array.isArray(data)) return data
        return data.items || data.results || data.metas || []
      } catch (e) {
        logWarn(`getCatalog failed for external plugin ${pluginManifest.id}`, String(e?.message || e))
        return []
      }
    },

    async getMeta({ type, id }) {
      if (!api.meta) return null
      const url = `${baseUrl}${replaceParams(api.meta, { type, id })}`
      const safeUrl = sanitizeUrl(url)
      if (!safeUrl) return null
      try {
        const data = await fetchJson(safeUrl)
        if (isStremio) {
          return normalizeStremioMeta(data?.meta)
        }
        return data
      } catch (e) {
        logWarn(`getMeta failed for external plugin ${pluginManifest.id}`, String(e?.message || e))
        return null
      }
    },

    async getStreams({ type, id }) {
      if (!api.streams) return []
      const url = `${baseUrl}${replaceParams(api.streams, { type, id })}`
      const safeUrl = sanitizeUrl(url)
      if (!safeUrl) return []
      try {
        const data = await fetchJson(safeUrl)
        if (isStremio) {
          const streams = data?.streams || []
          return streams.map(normalizeStremioStream).filter(Boolean)
        }
        if (Array.isArray(data)) return data
        return data.streams || data.items || []
      } catch (e) {
        logWarn(`getStreams failed for external plugin ${pluginManifest.id}`, String(e?.message || e))
        return []
      }
    },

    async search({ query, type }) {
      if (!api.search) return []
      const url = `${baseUrl}${replaceParams(api.search, { query, type: type || 'movie' })}`
      const safeUrl = sanitizeUrl(url)
      if (!safeUrl) return []
      try {
        const data = await fetchJson(safeUrl)
        if (isStremio) {
          const metas = data?.metas || []
          return metas.map(normalizeStremioMeta).filter(Boolean)
        }
        if (Array.isArray(data)) return data
        return data.items || data.results || data.metas || []
      } catch (e) {
        logWarn(`search failed for external plugin ${pluginManifest.id}`, String(e?.message || e))
        return []
      }
    },
  })

  return plugin
}

export async function fetchManifest(manifestUrl) {
  const safeUrl = sanitizeUrl(manifestUrl)
  if (!safeUrl) throw new Error('Invalid manifest URL')
  const res = await fetch(safeUrl)
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`)
  return res.json()
}
