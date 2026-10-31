import { httpGetJson } from '../../utils/httpClient.js'

// This Stremio addon exposes catalog metadata only (no stream resource).
// Keep it isolated from the external-plugin loader: users can browse these
// rows, but this integration never delegates playback to a remote addon.
const CATALOG_HOST = '7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club'
export const DEFAULT_STREAMING_CATALOG_MANIFEST = 'https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/bmZ4LGRucCxhbXAsaGJtLG1wOSxjcnUsbmZrLGF0cDo6RVM6MTc5MzQwMDI1MzQ3MTowOjA6SVM%3D/manifest.json'
const CACHE_TTL_MS = 10 * 60 * 1000
const manifestCatalogsCache = new Map()
let catalogCache = new Map()

function safeManifestUrl(url) {
  let parsed
  try { parsed = new URL(String(url || '')) } catch { throw new Error('URL de manifest no válida') }
  if (parsed.protocol !== 'https:' || parsed.hostname !== CATALOG_HOST
      || parsed.username || parsed.password || !parsed.pathname.endsWith('/manifest.json')) {
    throw new Error('Origen de catálogo no permitido')
  }
  return parsed.href
}

export async function getStreamingPlatformCatalogs(manifestUrl = DEFAULT_STREAMING_CATALOG_MANIFEST) {
  const safeUrl = safeManifestUrl(manifestUrl)
  if (!manifestCatalogsCache.has(safeUrl)) {
    const promise = (async () => {
      const manifest = await httpGetJson(safeUrl)
      const resources = (manifest?.resources || []).map(r => typeof r === 'string' ? r : r?.name)
      if (!manifest?.catalogs?.length || !resources.includes('catalog')) return []
      // This feature deliberately accepts catalog-only manifests. Never
      // enable a remote addon stream resolver from the Home customizer.
      if (resources.includes('stream')) throw new Error('El manifest debe ser solo de catálogo.')
      const baseUrl = safeUrl.slice(0, -'/manifest.json'.length)
      return manifest.catalogs
        .filter(cat => ['movie', 'series'].includes(cat.type) && /^[a-z0-9_-]+$/i.test(cat.id || ''))
        .map(cat => ({
          key: `${cat.type}:${cat.id}`,
          id: cat.id,
          type: cat.type,
          name: cat.name || cat.id,
          baseUrl,
        }))
    })().catch(err => {
      manifestCatalogsCache.delete(safeUrl)
      throw err
    })
    manifestCatalogsCache.set(safeUrl, promise)
  }
  return manifestCatalogsCache.get(safeUrl)
}

export async function getStreamingPlatformCatalogContent(catalog, { limit = 20, signal } = {}) {
  if (!catalog?.baseUrl || !/^[a-z0-9_-]+$/i.test(catalog.id || '')
      || !['movie', 'series'].includes(catalog.type)) return []
  const cacheKey = catalog.key || `${catalog.type}:${catalog.id}`
  const cached = catalogCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.items.slice(0, limit)

  const url = `${catalog.baseUrl}/catalog/${catalog.type}/${catalog.id}.json`
  try {
    const data = await httpGetJson(url, {}, signal)
    const items = (data?.metas || []).map(meta => {
      const tmdbId = String(meta.moviedb_id || '').match(/^\d+$/)?.[0]
      if (!tmdbId) return null
      const isMovie = catalog.type === 'movie'
      const year = Number.parseInt(meta.releaseInfo || meta.year, 10)
      const rating = Number.parseFloat(meta.imdbRating)
      return {
        id: `tmdb-${isMovie ? 'movie' : 'series'}-${tmdbId}`,
        tmdbId,
        type: catalog.type,
        name: meta.name || meta.title || '',
        originalName: meta.name || '',
        poster: meta.poster || null,
        backdrop: meta.background || null,
        description: meta.description || '',
        year: Number.isNaN(year) ? null : year,
        rating: Number.isNaN(rating) ? null : rating,
        genres: Array.isArray(meta.genres) ? meta.genres : [],
        imdbId: meta.imdb_id || meta.id || '',
        adult: meta.adult === true,
        streamingPlatform: catalog.name,
      }
    }).filter(item => item?.name)
    catalogCache.set(cacheKey, { ts: Date.now(), items })
    return items.slice(0, limit)
  } catch (err) {
    if (signal?.aborted) throw err
    console.warn(`[StreamingCatalogs] ${catalog.name} catalog failed:`, err?.message || err)
    return []
  }
}
