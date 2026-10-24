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

  it('preset Torrentio: [AD+]/[AD download] en name, 👤/💾/⚙️ y banderas en description', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [
        STREMIO({
          name: '[AD+] Comet 1080p',
          title: 'Movie.Name.1080p',
          description: 'Movie.Name.1080p.BluRay.x264-GRP.mkv\n💾2.10 GB 👤45 ⚙️PirateBay\n🇪🇸 / 🇬🇧',
          infoHash: 'f'.repeat(40),
          url: 'https://aio.example/play/1',
        }),
        STREMIO({
          name: '[AD download] Comet 1080p',
          title: 'Other.Film.1080p',
          description: 'Other.Film.1080p.WEB-DL.mkv\n💾3.40 GB 👤12 ⚙️Wolfmax\n🇪🇸',
          infoHash: '1'.repeat(40),
          url: 'https://aio.example/play/2',
          behaviorHints: { filename: 'Other.Film.1080p.WEB-DL.mkv' },
        }),
      ],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    const ready = s.find(x => !x.processing)
    const pending = s.find(x => x.processing)
    expect(ready.cached).toBe(true)
    expect(ready.seeds).toBe(45)
    expect(ready.size).toBe('2.10 GB')
    expect(ready.server).toBe('PirateBay · Comet')
    expect(ready.lang).toBe('Dual')
    expect(pending).toBeTruthy()
    expect(pending.url).toBeUndefined()
    expect(pending.seeds).toBe(12)
    expect(pending.size).toBe('3.40 GB')
    expect(pending.lang).toBe('Esp')
  })

  it('la URL placeholder de github cuenta como no lista aunque el tag diga [AD+]', async () => {
    safeFetchJson.mockResolvedValue({
      streams: [STREMIO({
        name: '[AD+] Comet 1080p',
        title: 'Movie.Name.1080p',
        description: '💾2.10 GB 👤45 ⚙️PirateBay\n🇪🇸',
        url: 'https://github.com/Viren070/AIOStreams/releases/download/assets/downloading.mp4',
      })],
    })
    const s = await aiostreams.getStreamsByImdb({ imdbId: 'tt1', type: 'movie' })
    expect(s[0].processing).toBe(true)
    expect(s[0].url).toBeUndefined()
    expect(s[0].seeds).toBe(45)
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
