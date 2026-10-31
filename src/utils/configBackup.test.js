import { beforeEach, describe, expect, it } from 'vitest'
import { categoryOf, collectSettings } from './configBackup.js'

beforeEach(() => {
  localStorage.clear()
})

describe('profile backup categories', () => {
  it('classifies namespaced profile lists and history correctly', () => {
    expect(categoryOf('octostream_profile_p_ab12_favorites')).toBe('lists')
    expect(categoryOf('octostream_profile_p_ab12_watchlist')).toBe('lists')
    expect(categoryOf('octostream_profile_p_ab12_history')).toBe('history')
    expect(categoryOf('octostream_profile_p_ab12_watched_episodes')).toBe('history')
  })

  it('includes profile data and registry in selected list/history backups only when enabled', () => {
    localStorage.setItem('octostream_profile_p_ab12_favorites', '[{"id":"movie-1"}]')
    localStorage.setItem('octostream_profile_p_ab12_history', '[{"id":"movie-2"}]')
    localStorage.setItem('octostream_profiles', '[{"id":"p_ab12","name":"Alex"}]')
    localStorage.setItem('octostream_active_profile', 'p_ab12')

    expect(collectSettings(['lists'])).toEqual({})
    expect(collectSettings(['lists'], null, true)).toMatchObject({
      octostream_profile_p_ab12_favorites: '[{"id":"movie-1"}]',
      octostream_profiles: '[{"id":"p_ab12","name":"Alex"}]',
    })
    expect(collectSettings(['lists'], null, true)).not.toHaveProperty('octostream_profile_p_ab12_history')
    expect(collectSettings(['lists'], null, true)).not.toHaveProperty('octostream_active_profile')
  })
})
