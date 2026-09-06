import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createExternalPlugin, fetchManifest } from './externalAdapter.js'

describe('externalAdapter', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates an Optopus-style REST plugin', async () => {
    const config = {
      id: 'demo-rest',
      name: 'Demo REST',
      version: '1.0.0',
      types: ['movie'],
      icon: 'film',
      catalogs: [{ id: 'top', name: 'Top', type: 'movie' }],
      api: {
        baseUrl: 'https://api.example.com',
        catalog: '/catalog/{type}/{id}?skip={skip}&top={top}',
        meta: '/meta/{type}/{id}',
        streams: '/streams/{type}/{id}',
        search: '/search?q={query}',
      },
    }

    const plugin = createExternalPlugin(config)
    expect(plugin.manifest.id).toBe('demo-rest')
    expect(plugin.manifest.name).toBe('Demo REST')

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: 'm1', type: 'movie', title: 'Test Movie', poster: '', description: '' },
      ],
    })

    const items = await plugin.getCatalog({ type: 'movie', id: 'top', skip: 0, top: 20 })
    expect(items.length).toBe(1)
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/catalog/movie/top?skip=0&top=20')
  })

  it('detects and creates a Stremio-style plugin', async () => {
    const manifest = {
      id: 'org.stremio.demo',
      version: '1.0.0',
      name: 'Stremio Demo',
      description: 'Demo addon',
      types: ['movie'],
      idPrefixes: ['tt'],
      resources: ['catalog', 'meta', 'stream'],
      catalogs: [{ type: 'movie', id: 'top', name: 'Top Movies' }],
    }

    const plugin = createExternalPlugin({ manifest, baseUrl: 'https://stremio.example.com' })
    expect(plugin.isStremio).toBe(true)
    expect(plugin.manifest.types).toContain('movie')
    expect(plugin.manifest.catalogs[0].id).toBe('top')

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        metas: [
          { id: 'tt123', type: 'movie', name: 'Demo', poster: '', description: '' },
        ],
      }),
    })

    const items = await plugin.getCatalog({ type: 'movie', id: 'top' })
    expect(items.length).toBe(1)
    expect(fetch).toHaveBeenCalledWith('https://stremio.example.com/catalog/movie/top.json')
  })

  it('normalizes Stremio stream responses', async () => {
    const manifest = {
      id: 'org.stremio.streams',
      version: '1.0.0',
      name: 'Streams',
      types: ['movie'],
      resources: ['stream'],
    }

    const plugin = createExternalPlugin({ manifest, baseUrl: 'https://streams.example.com' })

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        streams: [
          { url: 'https://cdn.example.com/movie.mp4', title: 'HD', quality: '1080p' },
          { ytId: 'abc123', title: 'YouTube' },
        ],
      }),
    })

    const streams = await plugin.getStreams({ type: 'movie', id: 'tt123' })
    expect(streams.length).toBe(2)
    expect(streams[0].url).toBe('https://cdn.example.com/movie.mp4')
    expect(streams[1].url).toBe('https://www.youtube.com/watch?v=abc123')
  })

  it('refuses unsafe URLs', () => {
    expect(() =>
      createExternalPlugin({
        id: 'unsafe',
        name: 'Unsafe',
        version: '1.0.0',
        types: ['movie'],
        baseUrl: 'javascript:alert(1)',
      })
    ).toThrow()
  })

  it('fetches and validates a manifest URL', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'remote',
        name: 'Remote',
        version: '1.0.0',
        types: ['movie'],
        resources: ['meta'],
      }),
    })

    const manifest = await fetchManifest('https://remote.example.com/manifest.json')
    expect(manifest.id).toBe('remote')
    expect(fetch).toHaveBeenCalledWith('https://remote.example.com/manifest.json')
  })
})
