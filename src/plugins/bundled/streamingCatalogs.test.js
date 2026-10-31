import { beforeEach, describe, expect, it, vi } from 'vitest'

const { httpGetJson } = vi.hoisted(() => ({ httpGetJson: vi.fn() }))
vi.mock('../../utils/httpClient.js', () => ({ httpGetJson }))

const manifest = {
  resources: ['catalog'],
  catalogs: [
    { type: 'movie', id: 'nfx', name: 'Netflix' },
    { type: 'series', id: 'hbm', name: 'HBO Max' },
  ],
}

beforeEach(() => {
  httpGetJson.mockReset()
  vi.resetModules()
})

describe('streaming catalogs', () => {
  it('loads catalog-only platforms and excludes remote stream resources', async () => {
    httpGetJson.mockResolvedValueOnce(manifest)
    const { getStreamingPlatformCatalogs } = await import('./streamingCatalogs.js')
    const catalogs = await getStreamingPlatformCatalogs()
    expect(catalogs.map(c => [c.key, c.name])).toEqual([
      ['movie:nfx', 'Netflix'],
      ['series:hbm', 'HBO Max'],
    ])

    httpGetJson.mockResolvedValueOnce({ ...manifest, resources: ['catalog', 'stream'] })
    await expect(getStreamingPlatformCatalogs(
      'https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/another/manifest.json',
    )).rejects.toThrow('solo de catálogo')
  })

  it('maps catalog metadata to native TMDB ids and drops entries without a TMDB id', async () => {
    httpGetJson
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce({
        metas: [
          { id: 'tt1234567', type: 'movie', moviedb_id: 42, name: 'Una película', year: '2024', imdbRating: '7.4', genres: ['Drama'] },
          { id: 'tt7654321', type: 'movie', name: 'Sin TMDB' },
        ],
      })
    const { getStreamingPlatformCatalogs, getStreamingPlatformCatalogContent } = await import('./streamingCatalogs.js')
    const [catalog] = await getStreamingPlatformCatalogs()
    const items = await getStreamingPlatformCatalogContent(catalog, { limit: 10 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'tmdb-movie-42',
      type: 'movie',
      name: 'Una película',
      year: 2024,
      rating: 7.4,
      streamingPlatform: 'Netflix',
    })
  })
})
