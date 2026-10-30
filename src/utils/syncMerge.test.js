import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock pluginManager before importing the store.
vi.mock('../plugins/manager.js', () => ({
  pluginManager: {
    ensureReady: vi.fn().mockResolvedValue(),
    getPlugins: vi.fn().mockReturnValue([]),
    getInstalledPlugins: vi.fn().mockReturnValue([]),
    getExternalPlugins: vi.fn().mockReturnValue([]),
    installPlugin: vi.fn().mockResolvedValue(),
    uninstallPlugin: vi.fn().mockResolvedValue(),
    addExternalPlugin: vi.fn().mockResolvedValue({ id: 'ext' }),
    addExternalPluginByUrl: vi.fn().mockResolvedValue({ id: 'ext' }),
    removeExternalPlugin: vi.fn().mockResolvedValue(),
    searchAllProgressive: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../utils/warpStatus.js', () => ({
  waitForWarp: vi.fn().mockResolvedValue(true),
}))

vi.mock('../plugins/builtIn/tmdb.js', () => ({
  searchMulti: vi.fn().mockResolvedValue([]),
  searchCategory: vi.fn().mockResolvedValue([]),
}))
vi.mock('../plugins/bundled/tdtSpain/cache.js', () => ({
  getSharedCache: vi.fn().mockReturnValue({ channels: [], epg: {} }),
}))
vi.mock('../plugins/bundled/tdtSpain/normalize.js', () => ({
  normalizeChannel: vi.fn((ch) => ({ id: `tdtspain-${ch.id}`, type: 'live', name: ch.name })),
}))
vi.mock('@octostream/exo-player', () => ({
  ExoPlayer: {
    exportConfig: vi.fn(),
    importConfig: vi.fn(),
  },
}))

import { useStore } from '../store/useStore.js'
import {
  localSyncPayload,
  mergeRemoteData,
  loadSyncCategories,
  saveSyncCategories,
  DEFAULT_SYNC_CATEGORIES,
  SYNC_CATEGORIES_KEY,
} from './syncMerge.js'

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    favorites: [{ id: 'f1', type: 'movie', name: 'Local' }],
    watchlist: [{ id: 'w1', type: 'series', name: 'Pendiente' }],
    watchHistory: [{ id: 'h1', type: 'movie', name: 'Vista', watchedAt: 10 }],
    watchedEpisodes: { 's1:S1:E1': { watchedAt: 10, progress: 1 } },
  })
})

describe('localSyncPayload categories', () => {
  it('includes only lists when lists is selected', () => {
    const payload = localSyncPayload(['lists'])

    expect(payload.kind).toBe('octostream-sync')
    expect(payload.version).toBe(2)
    expect(payload.sections).toEqual(['lists'])
    expect(payload.favorites).toHaveLength(1)
    expect(payload.watchlist).toHaveLength(1)
    expect(payload.watchHistory).toBeUndefined()
    expect(payload.watchedEpisodes).toBeUndefined()
  })

  it('includes structured history and non-store history settings', () => {
    localStorage.setItem('octostream_search_history', JSON.stringify(['alien']))
    localStorage.setItem('octostream_localpos_/movie.mkv', '123')
    localStorage.setItem('octostream_history', JSON.stringify([{ id: 'duplicate' }]))

    const payload = localSyncPayload(['history'])

    expect(payload.watchHistory).toHaveLength(1)
    expect(payload.watchedEpisodes['s1:S1:E1'].progress).toBe(1)
    expect(payload.settings.octostream_search_history).toBe(JSON.stringify(['alien']))
    expect(payload.settings['octostream_localpos_/movie.mkv']).toBe('123')
    // El historial estructurado no viaja duplicado como setting.
    expect(payload.settings.octostream_history).toBeUndefined()
  })

  it('collects accounts/settings and excludes non-portable keys', () => {
    localStorage.setItem('octostream_alldebrid_key', 'ad-key')
    localStorage.setItem('octostream_autoplay', 'false')
    localStorage.setItem('octostream_pair_tokens', '{"dev":"token"}')
    localStorage.setItem('octostream_last_sync', 'ayer')

    const payload = localSyncPayload(['accounts', 'settings'])

    expect(payload.settings.octostream_alldebrid_key).toBe('ad-key')
    expect(payload.settings.octostream_autoplay).toBe('false')
    expect(payload.settings.octostream_pair_tokens).toBeUndefined()
    expect(payload.settings.octostream_last_sync).toBeUndefined()
    expect(payload.favorites).toBeUndefined()
    expect(payload.watchHistory).toBeUndefined()
  })

  it('persists the selected categories for passive pulls', () => {
    saveSyncCategories(['settings'])
    expect(loadSyncCategories()).toEqual(['settings'])
    expect(localSyncPayload().sections).toEqual(['settings'])
  })

  it('falls back to the legacy-safe default selection', () => {
    localStorage.setItem(SYNC_CATEGORIES_KEY, 'not json')
    expect(loadSyncCategories()).toEqual(DEFAULT_SYNC_CATEGORIES)
    saveSyncCategories([])
    expect(loadSyncCategories()).toEqual(DEFAULT_SYNC_CATEGORIES)
  })
})

describe('mergeRemoteData categories', () => {
  it('merges only the selected structured sections', () => {
    const counts = mergeRemoteData({
      favorites: [{ id: 'f2', type: 'movie' }],
      watchlist: [{ id: 'w2', type: 'series' }],
      watchHistory: [{ id: 'h2', type: 'movie', watchedAt: 20 }],
      watchedEpisodes: { 's1:S1:E2': { watchedAt: 20, progress: 1 } },
      settings: { octostream_autoplay: 'false' },
    }, ['lists'])

    expect(counts.favs).toBe(1)
    expect(counts.watchlist).toBe(1)
    expect(useStore.getState().favorites).toHaveLength(2)
    expect(useStore.getState().watchlist).toHaveLength(2)
    expect(useStore.getState().watchHistory).toHaveLength(1)
    expect(useStore.getState().watchedEpisodes['s1:S1:E2']).toBeUndefined()
    expect(localStorage.getItem('octostream_autoplay')).toBeNull()
  })

  it('applies only allowed setting categories and never pair tokens', () => {
    const counts = mergeRemoteData({
      favorites: [{ id: 'f2', type: 'movie' }],
      settings: {
        octostream_autoplay: 'false',
        octostream_alldebrid_key: 'remote-key',
        octostream_pair_tokens: '{"dev":"token"}',
      },
    }, ['settings'])

    expect(counts.settings).toBe(1)
    expect(localStorage.getItem('octostream_autoplay')).toBe('false')
    expect(localStorage.getItem('octostream_alldebrid_key')).toBeNull()
    expect(localStorage.getItem('octostream_pair_tokens')).toBeNull()
    expect(useStore.getState().favorites).toHaveLength(1)
  })

  it('keeps backward compatibility with old unfiltered payloads', () => {
    localStorage.removeItem(SYNC_CATEGORIES_KEY)
    const counts = mergeRemoteData({
      favorites: [{ id: 'f2', type: 'movie' }],
      watchHistory: [{ id: 'h2', type: 'movie', watchedAt: 20 }],
      watchedEpisodes: { 's1:S1:E2': { watchedAt: 20, progress: 1 } },
    })

    expect(counts.favs).toBe(1)
    expect(counts.hist).toBe(1)
    expect(counts.eps).toBe(1)
    expect(useStore.getState().favorites).toHaveLength(2)
    expect(useStore.getState().watchHistory[0].id).toBe('h2')
    expect(useStore.getState().watchedEpisodes['s1:S1:E2'].progress).toBe(1)
  })
})
