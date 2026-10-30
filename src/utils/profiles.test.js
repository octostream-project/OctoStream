import { beforeEach, describe, expect, it } from 'vitest'
import { getProfiles, getActiveProfileId, profileDataKey, createProfile, canLeaveProfile, isAllowedInProfile } from './profiles.js'

beforeEach(() => {
  localStorage.clear()
})

describe('profiles', () => {
  it('keeps legacy data in the default profile and namespaces other profiles', () => {
    expect(getActiveProfileId()).toBe('default')
    expect(profileDataKey('octostream_favorites', 'default')).toBe('octostream_favorites')
    expect(profileDataKey('octostream_favorites', 'p_kids')).toBe('octostream_profile_p_kids_favorites')
  })

  it('creates isolated profiles without copying existing lists', async () => {
    localStorage.setItem('octostream_favorites', JSON.stringify([{ id: 'movie-1' }]))
    const profiles = await createProfile('Alex')
    expect(profiles.map(p => p.name)).toEqual(['Principal', 'Alex'])
    expect(localStorage.getItem(`octostream_profile_${profiles[1].id}_favorites`)).toBeNull()
    expect(JSON.parse(localStorage.getItem('octostream_favorites'))).toEqual([{ id: 'movie-1' }])
  })

  it('requires a valid PIN to leave a PIN-protected child profile', async () => {
    if (!globalThis.crypto?.subtle) return
    const profiles = await createProfile('Peques', { kids: true, pin: '1234' })
    const child = profiles[1]
    expect(await canLeaveProfile(child, '1234')).toBe(true)
    expect(await canLeaveProfile(child, '0000')).toBe(false)
    expect(getProfiles().find(p => p.id === child.id)?.pinHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hides provider-flagged adult content only in child profiles', () => {
    expect(isAllowedInProfile({ adult: true }, { kids: false })).toBe(true)
    expect(isAllowedInProfile({ adult: true }, { kids: true })).toBe(false)
    expect(isAllowedInProfile({ adult: false }, { kids: true })).toBe(true)
  })
})
