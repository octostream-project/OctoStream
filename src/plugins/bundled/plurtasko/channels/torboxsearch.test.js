import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../torbox.js', async () => {
  const actual = await vi.importActual('../../torbox.js')
  return {
    ...actual,
    isTorboxSearchEnabled: vi.fn(() => true),
    torboxSearch: vi.fn(),
  }
})

import { torboxSearch, isTorboxSearchEnabled } from '../../torbox.js'
import { torboxsearch } from './torboxsearch.js'

const TORRENT = {
  hash: '46bbb2af2380642f603daf10c210175b000fe0cb',
  raw_title: 'La.Pelicula.2024.1080p.Castellano.x264',
  title: 'La Película',
  title_parsed_data: { resolution: '1080p' },
  magnet: 'magnet:?xt=urn:btih:46bbb2af2380642f603daf10c210175b000fe0cb',
  last_known_seeders: 42,
  size: 2147483648,
  tracker: 'someindexer',
  type: 'torrent',
  cached: true,
}

const NZB = {
  hash: 'aabbcc',
  raw_title: 'La.Pelicula.2024.2160p.Usenet',
  title_parsed_data: { resolution: '2160p' },
  nzb: 'https://search-api.torbox.app/nzb/aabbcc.nzb',
  size: 5368709120,
  type: 'usenet',
  cached: false,
}

beforeEach(() => vi.clearAllMocks())

describe('torboxsearch channel', () => {
  it('returns [] when disabled', async () => {
    isTorboxSearchEnabled.mockReturnValueOnce(false)
    const s = await torboxsearch.getStreamsById({ imdbId: 'tt0133093', type: 'movie' })
    expect(s).toEqual([])
    expect(torboxSearch).not.toHaveBeenCalled()
  })

  it('returns [] without an id', async () => {
    const s = await torboxsearch.getStreamsById({ type: 'movie' })
    expect(s).toEqual([])
  })

  it('maps torrents to magnet streams and nzbs to usenet streams', async () => {
    torboxSearch.mockResolvedValue({ torrents: [TORRENT], nzbs: [NZB] })
    const s = await torboxsearch.getStreamsById({ imdbId: 'tt0133093', type: 'movie' })
    expect(s).toHaveLength(2)
    const tor = s.find(x => x.streamType === 'torrent')
    expect(String(tor.url)).toContain('btih:46bbb2af')
    expect(tor.server).toBe('TorBox')
    expect(tor.seeds).toBe(42)
    expect(tor.name).toContain('⚡')
    const nzb = s.find(x => x.streamType === 'usenet')
    expect(nzb.url).toBe(NZB.nzb)
    expect(nzb.quality).toBe('4K')
  })

  it('builds magnet from hash when magnet field is null', async () => {
    torboxSearch.mockResolvedValue({ torrents: [{ ...TORRENT, magnet: null, cached: false }], nzbs: [] })
    const s = await torboxsearch.getStreamsById({ imdbId: 'tt0133093', type: 'movie' })
    expect(s).toHaveLength(1)
    expect(String(s[0].url)).toMatch(/^magnet:\?xt=urn:btih:46bbb2af/)
  })

  it('passes season/episode for series only', async () => {
    torboxSearch.mockResolvedValue({ torrents: [], nzbs: [] })
    await torboxsearch.getStreamsById({ imdbId: 'tt0903747', type: 'series', season: 2, episode: 5 })
    expect(torboxSearch).toHaveBeenCalledWith(expect.objectContaining({ season: 2, episode: 5 }))
    await torboxsearch.getStreamsById({ imdbId: 'tt0133093', type: 'movie', season: 2, episode: 5 })
    expect(torboxSearch).toHaveBeenLastCalledWith(expect.objectContaining({ season: undefined, episode: undefined }))
  })

  it('drops nzbs without http link', async () => {
    torboxSearch.mockResolvedValue({ torrents: [], nzbs: [{ ...NZB, nzb: 'usenet://abc' }] })
    const s = await torboxsearch.getStreamsById({ imdbId: 'tt0133093', type: 'movie' })
    expect(s).toEqual([])
  })
})
