import { describe, it, expect } from 'vitest'
import { pickTorrentEntries } from './torrentPick.js'

const pack = [
  { id: 1, name: '/Show.S01E01.1080p.mkv', size: 1e9 },
  { id: 2, name: '/Show.S01E02.1080p.mkv', size: 1.1e9 },
  { id: 3, name: '/Show.S01E03.1080p.mkv', size: 1.2e9 },
  { id: 4, name: '/sample.mkv', size: 10e6 },
  { id: 5, name: '/readme.txt', size: 1000 },
]

describe('pickTorrentEntries', () => {
  it('returns null for empty/no-video entries', () => {
    expect(pickTorrentEntries([], {})).toBeNull()
    expect(pickTorrentEntries([{ name: 'a.txt', size: 1 }], {})).toBeNull()
    expect(pickTorrentEntries(null, {})).toBeNull()
  })

  it('picks the requested episode from a season pack', () => {
    const picked = pickTorrentEntries(pack, { season: 1, episode: 2 })
    expect(picked).toHaveLength(1)
    expect(picked[0].id).toBe(2)
  })

  it('matches 1x03 and S1E3 style names', () => {
    const files = [
      { id: 1, name: 'Serie 1x03 HD.mkv', size: 5e8 },
      { id: 2, name: 'Serie 1x04 HD.mkv', size: 5e8 },
    ]
    expect(pickTorrentEntries(files, { season: 1, episode: 3 })[0].id).toBe(1)
    const files2 = [{ id: 9, name: 'Show.s1e3.mkv', size: 5e8 }]
    expect(pickTorrentEntries(files2, { season: 1, episode: 3 })[0].id).toBe(9)
  })

  it('does not confuse S01E12 with S01E02', () => {
    const files = [
      { id: 1, name: 'Show.S01E02.mkv', size: 1e9 },
      { id: 2, name: 'Show.S01E12.mkv', size: 2e9 },
    ]
    expect(pickTorrentEntries(files, { season: 1, episode: 2 })[0].id).toBe(1)
  })

  it('falls back to the largest video file when no episode matches', () => {
    const files = [
      { id: 1, name: 'movie.sample.mkv', size: 10e6 },
      { id: 2, name: 'movie.720p.mkv', size: 2e9 },
      { id: 3, name: 'movie.1080p.mkv', size: 5e9 },
    ]
    expect(pickTorrentEntries(files, { season: 1, episode: 5 })[0].id).toBe(3)
  })

  it('ignores samples and non-video files for the fallback', () => {
    const picked = pickTorrentEntries(pack, {})
    expect(picked[0].id).toBe(3) // largest real video, not the sample
  })
})
