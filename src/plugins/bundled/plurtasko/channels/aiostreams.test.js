import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../utils.js', async () => {
  const actual = await vi.importActual('../../../utils.js')
  return { ...actual, safeFetchJson: vi.fn() }
})

vi.mock('../../../../utils/storage.js', async () => {
  const actual = await vi.importActual('../../../../utils/storage.js')
  return {
    ...actual,
    getItemSync: vi.fn((k) =>
      k === 'octostream_aiostreams_manifest'
        ? 'https://aio.example/stremio/u/cfg'
        : ''),
  }
})

import { safeFetchJson } from '../../../utils.js'
import { aiostreams, aioProcessingCount } from './aiostreams.js'

const STREMIO = (over) => ({
  name: 'AD\n1080p',
  title: 'Movie.Name.1080p\n💾 2.10 GB',
  description: '🔍 Comet\n📡 PirateBay\n⚡ Ready (AD)',
  infoHash: 'a'.repeat(40),
  behaviorHints: { filename: 'Movie.Name.1080p.BluRay.x264-GRP.mkv' },
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('aiostreams (manifest stremio)', () => {
  it('muestra el título del release como nombre y el origen como server', async () => {
    safeFetchJson.mockResolvedValue({ streams: [STREMIO()] })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s).toHaveLength(1)
    expect(s[0].name).toContain('Movie.Name.1080p.BluRay.x264-GRP')
    expect(s[0].name).not.toContain('PirateBay')
    expect(s[0].releaseTitle).toBe('Movie.Name.1080p.BluRay.x264-GRP.mkv')
    expect(s[0].server).toBe('PirateBay · Comet')
    expect(s[0].cached).toBe(true)
    expect(String(s[0].url)).toMatch(/^magnet:\?xt=urn:btih:a{40}/)
    expect(String(s[0].url)).toContain('dn=Movie.Name.1080p.BluRay.x264-GRP')
  })

  it('los "Not Ready" aparecen como processing con su título hasta estar listos', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [
        STREMIO(),
        STREMIO({ description: '🔍 Comet\n📡 PirateBay\n⏳ Not Ready (AD)', infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Other.Film.720p.WEB-DL.mkv' } }),
        STREMIO({ description: '🔍 Comet\n📡 PirateBay\nDownloading', infoHash: 'c'.repeat(40) }),
      ],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s).toHaveLength(3)
    const proc = s.filter(x => x.processing)
    expect(proc).toHaveLength(2)
    // Atenuados y no reproducibles, pero con el título del release visible.
    expect(proc[0].name).toContain('Other.Film.720p.WEB-DL')
    expect(proc[0].url).toBeUndefined()
    expect(proc[0].releaseTitle).toBe('Other.Film.720p.WEB-DL.mkv')
    expect(aioProcessingCount()).toBe(2)
  })

  it('lee seeders aunque vengan en title en vez de description', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [STREMIO({ title: 'Movie.Name.1080p\n👤 42 💾 2.10 GB' })],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s[0].seeds).toBe(42)
  })

  it('lee seeders con el emoji 👥 del formatter default/prism', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [STREMIO({ description: '📦 2.10 GB 👥 37 🔍 Comet' })],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s[0].seeds).toBe(37)
  })

  it('marca caché desde el emoji ⚡/⏳ del campo name (formatter nuevo)', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [
        STREMIO({ name: 'AD ⚡ 1080p', description: '📦 2 GB', infoHash: 'd'.repeat(40), url: 'https://aio.example/play/abc' }),
        STREMIO({ name: 'AD ⏳ 1080p', description: '📦 2 GB', infoHash: 'e'.repeat(40), url: 'https://aio.example/play/def' }),
      ],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    const cached = s.find(x => !x.processing && x.cached === true)
    const pending = s.filter(x => x.processing)
    expect(cached).toBeTruthy()
    expect(pending.length).toBe(1)
  })

  it('series usa el sufijo s:e en la URL', async () => {
    safeFetchJson.mockResolvedValue({ streams: [] })
    await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'series', season: 2, episode: 5 })
    expect(safeFetchJson.mock.calls[0][0]).toContain('/stream/series/tt1%3A2%3A5.json')
  })

  it('devuelve [] sin config ni respuesta', async () => {
    safeFetchJson.mockResolvedValue(null)
    expect(await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })).toEqual([])
  })
})
