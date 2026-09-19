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

// Mock waitForWarp so search doesn't block.
vi.mock('../utils/warpStatus.js', () => ({
  waitForWarp: vi.fn().mockResolvedValue(true),
}))

// Search is TMDB-only (+ local TDT channel cache) — mock both.
vi.mock('../plugins/builtIn/tmdb.js', () => ({
  searchMulti: vi.fn().mockResolvedValue([]),
}))
vi.mock('../plugins/bundled/tdtSpain/cache.js', () => ({
  getSharedCache: vi.fn().mockReturnValue({ channels: [], epg: {} }),
}))
vi.mock('../plugins/bundled/tdtSpain/normalize.js', () => ({
  normalizeChannel: vi.fn((ch) => ({ id: `tdtspain-${ch.id}`, type: 'live', name: ch.name })),
}))

import { useStore } from './useStore.js'

beforeEach(() => {
  localStorage.clear()
  // Reset store to initial state
  useStore.setState({
    plugins: [],
    installedPlugins: [],
    externalPlugins: [],
    activeCatalog: null,
    searchQuery: '',
    searchResults: [],
    loading: false,
    favorites: [],
    watchHistory: [],
    youtubeSearchHistory: [],
    youtubeLiveSearchHistory: [],
    _ytHistoryHydrated: false,
  })
})

describe('favorites', () => {
  it('adds an item to favorites', () => {
    useStore.getState().toggleFavorite({ id: 'm1', type: 'movie', name: 'A' })
    expect(useStore.getState().favorites).toHaveLength(1)
    expect(useStore.getState().favorites[0].id).toBe('m1')
  })

  it('removes an item when toggled again', () => {
    useStore.getState().toggleFavorite({ id: 'm1', type: 'movie', name: 'A' })
    useStore.getState().toggleFavorite({ id: 'm1', type: 'movie', name: 'A' })
    expect(useStore.getState().favorites).toHaveLength(0)
  })

  it('isFavorite returns correct boolean', () => {
    useStore.getState().toggleFavorite({ id: 'm1', type: 'movie' })
    expect(useStore.getState().isFavorite('m1', 'movie')).toBe(true)
    expect(useStore.getState().isFavorite('m1', 'series')).toBe(false)
    expect(useStore.getState().isFavorite('m2', 'movie')).toBe(false)
  })

  it('caps favorites at 500', () => {
    for (let i = 0; i < 510; i++) {
      useStore.getState().toggleFavorite({ id: `m${i}`, type: 'movie' })
    }
    expect(useStore.getState().favorites).toHaveLength(500)
    // Newest first
    expect(useStore.getState().favorites[0].id).toBe('m509')
  })

  it('persists favorites to localStorage', () => {
    useStore.getState().toggleFavorite({ id: 'm1', type: 'movie' })
    const raw = localStorage.getItem('octostream_favorites')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw)).toHaveLength(1)
  })
})

describe('watchHistory', () => {
  it('adds an item to history with watchedAt', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie', name: 'V' })
    const h = useStore.getState().watchHistory
    expect(h).toHaveLength(1)
    expect(h[0].watchedAt).toBeGreaterThan(0)
  })

  it('moves existing item to front and merges fields', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie', name: 'old' })
    useStore.getState().addToHistory({ id: 'v1', type: 'movie', name: 'new' })
    const h = useStore.getState().watchHistory
    expect(h).toHaveLength(1)
    expect(h[0].name).toBe('new')
  })

  it('caps history at 50', () => {
    for (let i = 0; i < 60; i++) {
      useStore.getState().addToHistory({ id: `v${i}`, type: 'movie' })
    }
    expect(useStore.getState().watchHistory).toHaveLength(50)
  })

  it('updateProgress updates currentTime/duration/progress', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie', duration: 100 })
    useStore.getState().updateProgress('v1', 'movie', 50, 100)
    const h = useStore.getState().watchHistory[0]
    expect(h.currentTime).toBe(50)
    expect(h.duration).toBe(100)
    expect(h.progress).toBe(0.5)
  })

  it('updateProgress keeps previous duration when current is 0', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie', duration: 200 })
    useStore.getState().updateProgress('v1', 'movie', 100, 0)
    const h = useStore.getState().watchHistory[0]
    expect(h.duration).toBe(200)
    expect(h.progress).toBe(0.5)
  })

  it('updateProgress is a no-op for unknown items without episodeInfo', () => {
    useStore.getState().updateProgress('unknown', 'movie', 10, 100)
    expect(useStore.getState().watchHistory).toHaveLength(0)
    expect(useStore.getState().watchedEpisodes).toEqual({})
  })

  it('updateProgress marks episode watched even if item not in history', () => {
    // This covers the case where addToHistory hasn't been called yet but
    // the player is already sending progress updates.
    useStore.getState().updateProgress('s1', 'series', 1800, 1800, {
      season: 1, episode: 5, name: 'Finale',
    })
    expect(useStore.getState().watchHistory).toHaveLength(0)
    expect(useStore.getState().isEpisodeWatched('s1', 1, 5)).toBe(true)
  })

  it('updateProgress marks anime episode watched (not just series)', () => {
    useStore.getState().addToHistory({ id: 'a1', type: 'anime', name: 'Naruto' })
    useStore.getState().updateProgress('a1', 'anime', 1500, 1500, {
      season: 1, episode: 12, name: 'Ep12',
    })
    expect(useStore.getState().isEpisodeWatched('a1', 1, 12)).toBe(true)
  })

  it('updateProgress marks dorama episode watched (not just series)', () => {
    useStore.getState().addToHistory({ id: 'd1', type: 'dorama', name: 'Crash' })
    useStore.getState().updateProgress('d1', 'dorama', 2700, 2700, {
      season: 1, episode: 3, name: 'Ep3',
    })
    expect(useStore.getState().isEpisodeWatched('d1', 1, 3)).toBe(true)
  })

  it('updateProgress does not mark episode watched below 97%', () => {
    useStore.getState().addToHistory({ id: 's1', type: 'series', name: 'S' })
    useStore.getState().updateProgress('s1', 'series', 900, 1000, {
      season: 1, episode: 1, name: 'E1',
    })
    expect(useStore.getState().isEpisodeWatched('s1', 1, 1)).toBe(false)
  })

  it('saveFinalProgress pattern: dur=0 still marks watched (1/1 progress)', () => {
    // Simulates saveFinalProgress when duration state was never set
    useStore.getState().addToHistory({ id: 's2', type: 'series', name: 'S2' })
    useStore.getState().updateProgress('s2', 'series', 1, 1, {
      season: 2, episode: 1, name: 'E1',
    })
    expect(useStore.getState().isEpisodeWatched('s2', 2, 1)).toBe(true)
  })

  it('removeFromHistory removes a specific item', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie' })
    useStore.getState().addToHistory({ id: 'v2', type: 'movie' })
    useStore.getState().removeFromHistory('v1', 'movie')
    const h = useStore.getState().watchHistory
    expect(h).toHaveLength(1)
    expect(h[0].id).toBe('v2')
  })

  it('clearHistory empties the list', () => {
    useStore.getState().addToHistory({ id: 'v1', type: 'movie' })
    useStore.getState().clearHistory()
    expect(useStore.getState().watchHistory).toHaveLength(0)
  })
})

describe('youtube search history', () => {
  it('ensureYoutubeHistory hydrates from localStorage lazily', () => {
    localStorage.setItem('octostream_youtube_search_history', JSON.stringify(['old', 'query']))
    useStore.getState().ensureYoutubeHistory()
    expect(useStore.getState().youtubeSearchHistory).toEqual(['old', 'query'])
    // Second call is a no-op
    useStore.getState().ensureYoutubeHistory()
  })

  it('addYoutubeSearch adds and dedupes case-insensitively', () => {
    useStore.getState().addYoutubeSearch('hello')
    useStore.getState().addYoutubeSearch('Hello')
    // Dedup is case-insensitive, but the stored value preserves original case
    expect(useStore.getState().youtubeSearchHistory).toEqual(['Hello'])
  })

  it('addYoutubeSearch ignores empty/whitespace queries', () => {
    useStore.getState().addYoutubeSearch('   ')
    expect(useStore.getState().youtubeSearchHistory).toHaveLength(0)
  })

  it('addYoutubeSearch caps at 20 entries', () => {
    for (let i = 0; i < 25; i++) {
      useStore.getState().addYoutubeSearch(`q${i}`)
    }
    expect(useStore.getState().youtubeSearchHistory).toHaveLength(20)
    expect(useStore.getState().youtubeSearchHistory[0]).toBe('q24')
  })

  it('removeYoutubeSearch removes a specific query', () => {
    useStore.getState().addYoutubeSearch('a')
    useStore.getState().addYoutubeSearch('b')
    useStore.getState().removeYoutubeSearch('a')
    expect(useStore.getState().youtubeSearchHistory).toEqual(['b'])
  })

  it('clearYoutubeSearchHistory empties the list', () => {
    useStore.getState().addYoutubeSearch('a')
    useStore.getState().clearYoutubeSearchHistory()
    expect(useStore.getState().youtubeSearchHistory).toHaveLength(0)
  })
})

describe('youtube live search history', () => {
  it('addYoutubeLiveSearch adds and dedupes', () => {
    useStore.getState().addYoutubeLiveSearch('live1')
    useStore.getState().addYoutubeLiveSearch('live1')
    useStore.getState().addYoutubeLiveSearch('live2')
    expect(useStore.getState().youtubeLiveSearchHistory).toEqual(['live2', 'live1'])
  })

  it('clearYoutubeLiveSearchHistory empties the list', () => {
    useStore.getState().addYoutubeLiveSearch('x')
    useStore.getState().clearYoutubeLiveSearchHistory()
    expect(useStore.getState().youtubeLiveSearchHistory).toHaveLength(0)
  })
})

describe('search', () => {
  it('sets loading and stores results', async () => {
    const { searchMulti } = await import('../plugins/builtIn/tmdb.js')
    searchMulti.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    await useStore.getState().search('query')
    expect(useStore.getState().loading).toBe(false)
    expect(useStore.getState().searchResults).toHaveLength(2)
    expect(useStore.getState().searchQuery).toBe('query')
  })

  it('appends local TDT channel matches after TMDB results', async () => {
    const { searchMulti } = await import('../plugins/builtIn/tmdb.js')
    const { getSharedCache } = await import('../plugins/bundled/tdtSpain/cache.js')
    searchMulti.mockResolvedValue([{ id: 'p1' }])
    getSharedCache.mockReturnValue({
      channels: [{ id: 'la1', name: 'La 1' }, { id: 'la2', name: 'La 2' }],
      epg: {},
    })
    await useStore.getState().search('la')
    const results = useStore.getState().searchResults
    expect(results[0].id).toBe('p1')
    expect(results.filter(r => r.type === 'live')).toHaveLength(2)
    getSharedCache.mockReturnValue({ channels: [], epg: {} })
  })

  it('clears loading on error', async () => {
    const { searchMulti } = await import('../plugins/builtIn/tmdb.js')
    searchMulti.mockRejectedValue(new Error('fail'))
    await useStore.getState().search('bad')
    expect(useStore.getState().loading).toBe(false)
  })
})

describe('setActiveCatalog / setSearchQuery / clearSearch', () => {
  it('sets active catalog', () => {
    useStore.getState().setActiveCatalog({ id: 'cat1' })
    expect(useStore.getState().activeCatalog).toEqual({ id: 'cat1' })
  })

  it('sets search query', () => {
    useStore.getState().setSearchQuery('hello')
    expect(useStore.getState().searchQuery).toBe('hello')
  })

  it('clears search', () => {
    useStore.getState().setSearchQuery('hello')
    useStore.getState().clearSearch()
    expect(useStore.getState().searchQuery).toBe('')
    expect(useStore.getState().searchResults).toEqual([])
    expect(useStore.getState().loading).toBe(false)
  })
})
