import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../utils.js', async () => {
  const actual = await vi.importActual('../../../utils.js')
  return { ...actual, safeFetchJson: vi.fn() }
})

import { safeFetchJson } from '../../../utils.js'
import { torrentio } from './torrentio.js'

const RESP = (streams) => ({ streams })
const S = (name, title, infoHash, fileIdx) => ({ name, title, infoHash, fileIdx })

beforeEach(() => vi.clearAllMocks())

describe('torrentio channel', () => {
  it('movie builds torrent streams from infoHash', async () => {
    safeFetchJson.mockResolvedValue(RESP([
      S('Torrentio\n1080p',
        'Breaking.Bad.1080p.Castellano\n👤 12 💾 2.10 GB ⚙️ MejorTorrent\n🇪🇸',
        '46bbb2af2380642f603daf10c210175b000fe0cb', 0),
    ]))
    const s = await torrentio.getStreamsByImdb({ imdbId: 'tt0903747', type: 'movie' })
    expect(s).toHaveLength(1)
    expect(String(s[0].url)).toMatch(/^magnet:\?xt=urn:btih:46bbb2af/)
    expect(String(s[0].url)).toContain('tr=')
    expect(s[0].streamType).toBe('torrent')
    expect(s[0].server).toBe('MejorTorrent')
    expect(s[0].seeds).toBe(12)
    expect(s[0].name).toContain('👤12')
    expect(s[0].name).toContain('1080')
    expect(s[0].fileIdx).toBe(0)
    const url = safeFetchJson.mock.calls[0][0]
    expect(url).toContain('providers=mejortorrent,wolfmax4k,cinecalidad')
    expect(url).toContain('/stream/movie/tt0903747.json')
  })

  it('series uses s:e id suffix', async () => {
    safeFetchJson.mockResolvedValue(RESP([]))
    await torrentio.getStreamsByImdb({ imdbId: 'tt1', type: 'series', season: 2, episode: 5 })
    expect(safeFetchJson.mock.calls[0][0]).toContain('/stream/series/tt1:2:5.json')
  })

  it('skips entries without a valid infoHash', async () => {
    safeFetchJson.mockResolvedValue(RESP([
      S('Torrentio\nHD', 'junk\n👤 1 ⚙️ X', 'notahash'),
      S('Torrentio\nHD', 'ok\n👤 1 ⚙️ Wolfmax4k', 'a'.repeat(40)),
    ]))
    const s = await torrentio.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s).toHaveLength(1)
    expect(s[0].server).toBe('Wolfmax4k')
  })

  it('returns empty on null/error response and missing imdb', async () => {
    safeFetchJson.mockResolvedValue(null)
    expect(await torrentio.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })).toEqual([])
    expect(await torrentio.getStreamsByImdb({ type: 'movie' })).toEqual([])
  })
})
