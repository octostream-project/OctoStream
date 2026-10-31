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
  previewRemoteSync,
  loadSyncCategories,
  saveSyncCategories,
  DEFAULT_SYNC_CATEGORIES,
  SYNC_CATEGORIES_KEY,
} from './syncMerge.js'

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    activeProfileId: 'default',
    favorites: [{ id: 'f1', type: 'movie', name: 'Local' }],
    watchlist: [{ id: 'w1', type: 'series', name: 'Pendiente' }],
    watchHistory: [{ id: 'h1', type: 'movie', name: 'Vista', watchedAt: 10 }],
    watchedEpisodes: { 's1:S1:E1': { watchedAt: 10, progress: 1 } },
  })
})

describe('previewRemoteSync', () => {
  it('summarizes selected incoming data without returning credential values', () => {
    const preview = previewRemoteSync({
      sections: ['lists', 'accounts'],
      favorites: [{ id: 'movie-1' }],
      watchlist: [{ id: 'show-1' }, { id: 'show-2' }],
      settings: { octostream_alldebrid_key: 'secret-key-value' },
    }, ['lists', 'accounts'])

    expect(preview.categories).toContain('Favoritos y Mi lista')
    expect(preview.counts).toMatchObject({ favorites: 1, watchlist: 2, settings: 1 })
    expect(JSON.stringify(preview)).not.toContain('secret-key-value')
  })

  it('excludes categories not selected locally or by the sender', () => {
    const preview = previewRemoteSync({
      sections: ['lists'],
      favorites: [{ id: 'movie-1' }],
      watchHistory: [{ id: 'episode-1' }],
    }, ['history'])

    expect(preview.categories).toEqual([])
    expect(preview.counts.favorites).toBe(0)
    expect(preview.counts.history).toBe(0)
  })
})

describe('localSyncPayload categories', () => {
  it('includes only lists when lists is selected', async () => {
    const payload = await localSyncPayload(['lists'])

    expect(payload.kind).toBe('octostream-sync')
    expect(payload.version).toBe(3)
    expect(payload.sections).toEqual(['lists'])
    expect(payload.favorites).toHaveLength(1)
    expect(payload.watchlist).toHaveLength(1)
    expect(payload.watchHistory).toBeUndefined()
    expect(payload.watchedEpisodes).toBeUndefined()
  })

  it('includes structured history and non-store history settings', async () => {
    localStorage.setItem('octostream_search_history', JSON.stringify(['alien']))
    localStorage.setItem('octostream_localpos_/movie.mkv', '123')
    localStorage.setItem('octostream_history', JSON.stringify([{ id: 'duplicate' }]))

    const payload = await localSyncPayload(['history'])

    expect(payload.watchHistory).toHaveLength(1)
    expect(payload.watchedEpisodes['s1:S1:E1'].progress).toBe(1)
    expect(payload.settings.octostream_search_history).toBe(JSON.stringify(['alien']))
    expect(payload.settings['octostream_localpos_/movie.mkv']).toBe('123')
    // El historial estructurado no viaja duplicado como setting.
    expect(payload.settings.octostream_history).toBeUndefined()
  })

  it('collects accounts/settings and excludes non-portable keys', async () => {
    localStorage.setItem('octostream_alldebrid_key', 'ad-key')
    localStorage.setItem('octostream_autoplay', 'false')
    localStorage.setItem('octostream_pair_tokens', '{"dev":"token"}')
    localStorage.setItem('octostream_last_sync', 'ayer')

    const payload = await localSyncPayload(['accounts', 'settings'])

    expect(payload.settings.octostream_alldebrid_key).toBe('ad-key')
    expect(payload.settings.octostream_autoplay).toBe('false')
    expect(payload.settings.octostream_pair_tokens).toBeUndefined()
    expect(payload.settings.octostream_last_sync).toBeUndefined()
    expect(payload.favorites).toBeUndefined()
    expect(payload.watchHistory).toBeUndefined()
  })

  it('persists the selected categories for passive pulls', async () => {
    saveSyncCategories(['settings'])
    expect(loadSyncCategories()).toEqual(['settings'])
    expect((await localSyncPayload()).sections).toEqual(['settings'])
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

  it('does not merge library data across different profiles', () => {
    useStore.setState({
      activeProfileId: 'profile-kids',
      profiles: [{ id: 'profile-kids', name: 'Peques', kids: true }],
    })
    const counts = mergeRemoteData({
      profileId: 'default',
      profileName: 'Principal',
      profileKids: false,
      favorites: [{ id: 'adult-f1', type: 'movie', name: 'Principal' }],
      watchlist: [{ id: 'adult-w1', type: 'movie', name: 'Principal' }],
      watchHistory: [{ id: 'adult-h1', type: 'movie', watchedAt: 20 }],
      watchedEpisodes: { 's1:S1:E2': { watchedAt: 20, progress: 1 } },
    }, ['lists', 'history'])
    expect(counts.favs).toBe(0)
    expect(counts.watchlist).toBe(0)
    expect(counts.hist).toBe(0)
    expect(counts.eps).toBe(0)
    expect(useStore.getState().favorites).toEqual([{ id: 'f1', type: 'movie', name: 'Local' }])
  })

  it('syncs between same-name profiles with different local IDs', () => {
    useStore.setState({
      activeProfileId: 'local-ana',
      profiles: [{ id: 'local-ana', name: 'Ana', kids: false }],
    })
    const counts = mergeRemoteData({
      profileId: 'remote-ana',
      profileName: ' ana ',
      profileKids: false,
      favorites: [{ id: 'f2', type: 'movie' }],
    }, ['lists'])
    expect(counts.favs).toBe(1)
    expect(useStore.getState().favorites.map(item => item.id)).toEqual(['f1', 'f2'])
  })

  it('does not treat adult and child profiles with the same name as identical', () => {
    useStore.setState({
      activeProfileId: 'local-profile',
      profiles: [{ id: 'local-profile', name: 'Alex', kids: true }],
    })
    const counts = mergeRemoteData({
      profileId: 'remote-profile',
      profileName: 'Alex',
      profileKids: false,
      watchlist: [{ id: 'adult-w1', type: 'movie' }],
      watchedEpisodes: { 's1:S1:E2': { watchedAt: 20, progress: 1 } },
    }, ['lists', 'history'])
    expect(counts.watchlist).toBe(0)
    expect(counts.eps).toBe(0)
    expect(useStore.getState().watchlist).toEqual([{ id: 'w1', type: 'series', name: 'Pendiente' }])
  })

  it('routes secondary profile data to its own storage, never into the active one', () => {
    localStorage.setItem('octostream_profiles', JSON.stringify([
      { id: 'default', name: 'Principal' },
      { id: 'p_ana', name: 'Ana', kids: false },
    ]))
    useStore.setState({
      activeProfileId: 'default',
      profiles: [
        { id: 'default', name: 'Principal' },
        { id: 'p_ana', name: 'Ana', kids: false },
      ],
    })
    const counts = mergeRemoteData({
      profileId: 'default',
      profileName: 'Principal',
      profileKids: false,
      profiles: [
        { id: 'default', name: 'Principal', kids: false },
        { id: 'p_ana_remote', name: 'Ana', kids: false },
        { id: 'p_peques', name: 'Peques', kids: true, pinHash: 'hh', pinSalt: 'ss' },
      ],
      favorites: [{ id: 'f2', type: 'movie' }],
      profileData: {
        p_ana_remote: { favorites: [{ id: 'ana-f1', type: 'movie' }] },
        p_peques: { watchedEpisodes: { 's1:S1:E9': { watchedAt: 30, progress: 1 } } },
      },
    }, ['lists', 'history'])

    // counts.favs suma todas las fusiones (Principal + Ana = 2); lo
    // importante es a dónde fue cada una.
    expect(counts.favs).toBe(2)
    expect(useStore.getState().favorites.map(i => i.id)).toEqual(['f1', 'f2'])
    // Ana remota → Ana local por nombre: en SU storage, no en el activo.
    const anaFavs = JSON.parse(localStorage.getItem('octostream_profile_p_ana_favorites') || '[]')
    expect(anaFavs.map(i => i.id)).toEqual(['ana-f1'])
    // Peques remoto se crea (con hash del PIN, no el PIN) y sus datos van a su clave.
    const profiles = JSON.parse(localStorage.getItem('octostream_profiles'))
    const peques = profiles.find(p => p.name === 'Peques')
    expect(peques).toBeTruthy()
    expect(peques.kids).toBe(true)
    expect(peques.pinHash).toBe('hh')
    const pequesEps = JSON.parse(localStorage.getItem(`octostream_profile_${peques.id}_watched_episodes`) || '{}')
    expect(pequesEps['s1:S1:E9'].progress).toBe(1)
    // El perfil activo no recibió nada de los perfiles ajenos.
    expect(useStore.getState().watchedEpisodes['s1:S1:E9']).toBeUndefined()
  })

  it('payload includes the profile registry and per-profile data', async () => {
    localStorage.setItem('octostream_profiles', JSON.stringify([
      { id: 'default', name: 'Principal' },
      { id: 'p_ana', name: 'Ana', kids: false, pinHash: 'h', pinSalt: 's' },
    ]))
    useStore.setState({
      profiles: [
        { id: 'default', name: 'Principal' },
        { id: 'p_ana', name: 'Ana', kids: false, pinHash: 'h', pinSalt: 's' },
      ],
    })
    localStorage.setItem('octostream_profile_p_ana_favorites', JSON.stringify([{ id: 'af1', type: 'movie' }]))

    const payload = await localSyncPayload(['lists'])
    expect(payload.profiles).toHaveLength(2)
    expect(payload.profiles.find(p => p.id === 'p_ana').pinHash).toBe('h')
    expect(payload.profileData.p_ana.favorites[0].id).toBe('af1')
    expect(payload.profileData.default).toBeUndefined()
  })
})
