import { describe, it, expect, vi, beforeEach } from 'vitest'

const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
}

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
})

vi.mock('./external/externalAdapter.js', () => ({
  createExternalPlugin: vi.fn(),
  fetchManifest: vi.fn(),
}))

vi.mock('./bundled/index.js', () => ({
  getBundledPlugin: vi.fn(),
  isBundledPlugin: vi.fn(() => false),
}))

vi.mock('./builtIn/index.js', () => ({
  builtInPlugins: [
    { id: 'tmdb', name: 'TMDB', manifest: { catalogs: [{ id: 'popular', name: 'Popular', type: 'movie' }] } },
    { id: 'embed-stream', name: 'Embed', manifest: { catalogs: [] } },
  ],
}))

import { PluginManager } from './manager.js'
import { createExternalPlugin } from './external/externalAdapter.js'

beforeEach(() => {
  vi.clearAllMocks()
  PluginManager.clearStreamCache()
  localStorageMock.getItem.mockReturnValue(null)
  localStorageMock.setItem.mockImplementation(() => {})
})

describe('PluginManager', () => {
  it('loads default built-in installed plugins', () => {
    const manager = new PluginManager([], ['tmdb'])
    expect(manager.getInstalledPlugins().map(p => p.id)).toEqual(['tmdb'])
  })

  it('installs and uninstalls built-in plugins', async () => {
    const manager = new PluginManager([], [])
    expect(manager.getInstalledPlugins()).toHaveLength(0)

    await manager.installPlugin('tmdb')
    expect(manager.getInstalledPlugins().map(p => p.id)).toContain('tmdb')
    expect(localStorageMock.setItem).toHaveBeenCalled()

    await manager.uninstallPlugin('tmdb')
    expect(manager.getInstalledPlugins()).toHaveLength(0)
  })

  it('throws when installing an unknown plugin', async () => {
    const manager = new PluginManager([], [])
    await expect(manager.installPlugin('unknown')).rejects.toThrow('Plugin unknown not found')
  })

  it('returns catalogs from installed plugins', async () => {
    const manager = new PluginManager([], ['tmdb'])
    const catalogs = await manager.getAllCatalogs()
    expect(catalogs.length).toBe(1)
    expect(catalogs[0]).toMatchObject({ id: 'popular', pluginId: 'tmdb', pluginName: 'TMDB' })
  })

  it('wraps getCatalog errors and returns empty array', async () => {
    const badPlugin = {
      id: 'bad',
      name: 'Bad',
      manifest: { catalogs: [] },
      getCatalog: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const manager = new PluginManager([], ['bad'])
    manager.plugins = [badPlugin]
    const items = await manager.getCatalogContent('bad', 'top', 'movie')
    expect(items).toEqual([])
  })

  it('rejects remote external plugins', async () => {
    const manager = new PluginManager([], [])
    await expect(manager.addExternalPlugin({
      id: 'ext', name: 'Ext', version: '1.0.0', types: ['movie'],
    })).rejects.toThrow('plugins externos están desactivados')
    expect(createExternalPlugin).not.toHaveBeenCalled()
  })

  it('does not persist remote plugin configurations on startup', () => {
    const manager = new PluginManager([
      { id: 'remote-old', name: 'Old', version: '1.0.0', types: ['movie'] },
    ], [])
    expect(manager.getExternalPlugins().some(plugin => plugin.id === 'remote-old')).toBe(false)
  })

  it('uses timeout for getMeta', async () => {
    vi.useFakeTimers()
    const slowPlugin = {
      id: 'slow',
      name: 'Slow',
      manifest: {},
      getMeta: vi.fn().mockImplementation(() => new Promise(() => {})),
    }
    const manager = new PluginManager([], ['slow'])
    manager.plugins = [slowPlugin]

    const promise = manager.getMeta('movie', 'tt123')
    await vi.advanceTimersByTimeAsync(10000)

    const result = await promise
    expect(result).toBeNull()
    vi.useRealTimers()
  })

  it('queries only the plugin identified by an explicit metadata id', async () => {
    const owner = { id: 'plurtasko', name: 'Owner', manifest: { types: ['movie'] }, getMeta: vi.fn().mockResolvedValue({ id: 'plurtasko:item' }) }
    const unrelated = { id: 'tmdb', name: 'TMDB', manifest: { types: ['movie'] }, getMeta: vi.fn().mockResolvedValue(null) }
    const manager = new PluginManager([], [])
    manager.plugins = [unrelated, owner]
    manager._readyPromise = Promise.resolve()

    await expect(manager.getMeta('movie', 'plurtasko:item')).resolves.toMatchObject({ pluginId: 'plurtasko' })
    expect(owner.getMeta).toHaveBeenCalledOnce()
    expect(unrelated.getMeta).not.toHaveBeenCalled()
  })

  it('does not cache empty progressive stream failures', async () => {
    const plugin = { id: 'source', name: 'Source', manifest: { types: ['movie'] }, getStreams: vi.fn().mockResolvedValue([]) }
    const manager = new PluginManager([], [])
    manager.plugins = [plugin]
    manager._readyPromise = Promise.resolve()

    await manager.getStreamsProgressive('movie', 'item', 'Item')
    await manager.getStreamsProgressive('movie', 'item', 'Item')

    expect(plugin.getStreams).toHaveBeenCalledTimes(2)
  })
})
