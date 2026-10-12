import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockYoutube = { search: vi.fn(), searchMore: vi.fn(), getChannel: vi.fn() }

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
}))

vi.mock('@octostream/youtube', () => ({ Youtube: mockYoutube }))

const { searchYouTubeFull, dedupeYouTubeItems, youtubeVideoId, getChannelInfo } = await import('./youtube.js')

const item = (id, name = 'video') => ({
  name: `${name} ${id}`,
  url: `https://www.youtube.com/watch?v=${id}`,
})

describe('youtubeVideoId', () => {
  it('extrae el id de URLs watch/embed/youtu.be/shorts', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abc123XYZ_-')).toBe('abc123XYZ_-')
    expect(youtubeVideoId('https://youtu.be/abc123XYZ_-')).toBe('abc123XYZ_-')
    expect(youtubeVideoId('https://www.youtube.com/embed/abc123XYZ_-')).toBe('abc123XYZ_-')
    expect(youtubeVideoId('https://www.youtube.com/shorts/abc123XYZ_-')).toBe('abc123XYZ_-')
  })

  it('devuelve la propia url si no encaja y null si no hay url', () => {
    expect(youtubeVideoId('https://example.com/x')).toBe('https://example.com/x')
    expect(youtubeVideoId(null)).toBeNull()
  })
})

describe('dedupeYouTubeItems', () => {
  it('fusiona página previa + nueva sin duplicados (regresión: la página 2 no se añadía)', () => {
    const prev = [item('aaaaaaaaaaa'), item('bbbbbbbbbbb')]
    const page2 = [item('bbbbbbbbbbb'), item('ccccccccccc'), item('ddddddddddd')]
    const merged = dedupeYouTubeItems([...prev, ...page2])
    expect(merged.map(i => i.url)).toEqual([
      prev[0].url, prev[1].url, page2[1].url, page2[2].url,
    ])
  })

  it('descarta items sin url', () => {
    expect(dedupeYouTubeItems([{ name: 'x' }, item('aaaaaaaaaaa')])).toHaveLength(1)
  })
})

describe('searchYouTubeFull', () => {
  beforeEach(() => {
    mockYoutube.search.mockReset()
    mockYoutube.searchMore.mockReset()
  })

  it('primera página: llama a search y devuelve items + nextPage', async () => {
    const np = { url: 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false', id: 'token123' }
    mockYoutube.search.mockResolvedValue({ items: [item('aaaaaaaaaaa')], nextPage: np })
    const res = await searchYouTubeFull('gatos')
    expect(mockYoutube.search).toHaveBeenCalledWith({ query: 'gatos' })
    expect(res.error).toBeNull()
    expect(res.items).toHaveLength(1)
    expect(res.nextPage).toEqual(np)
  })

  it('paginación: llama a searchMore con el nextPage y devuelve la siguiente página', async () => {
    const np1 = { url: 'u1', id: 't1' }
    const np2 = { url: 'u2', id: 't2' }
    mockYoutube.searchMore.mockResolvedValue({ items: [item('bbbbbbbbbbb')], nextPage: np2 })
    const res = await searchYouTubeFull('gatos', np1)
    expect(mockYoutube.searchMore).toHaveBeenCalledWith({ query: 'gatos', nextPage: np1 })
    expect(res.error).toBeNull()
    expect(res.items).toHaveLength(1)
    expect(res.nextPage).toEqual(np2)
  })

  it('fin de resultados: searchMore sin nextPage devuelve nextPage null', async () => {
    mockYoutube.searchMore.mockResolvedValue({ items: [item('ccccccccccc')] })
    const res = await searchYouTubeFull('gatos', { url: 'u', id: 't' })
    expect(res.nextPage).toBeNull()
    expect(res.error).toBeNull()
  })

  it('error nativo en paginación: devuelve error en vez de tragarlo', async () => {
    mockYoutube.searchMore.mockRejectedValue(new Error('SearchMore failed: HTTP 429'))
    const res = await searchYouTubeFull('gatos', { url: 'u', id: 't' })
    expect(res.items).toEqual([])
    expect(res.error).toMatch(/429/)
  })
})

describe('getChannelInfo', () => {
  beforeEach(() => { mockYoutube.getChannel.mockReset() })

  it('devuelve info y vídeos del canal', async () => {
    mockYoutube.getChannel.mockResolvedValue({
      name: 'Canal', url: 'https://www.youtube.com/@canal',
      items: [item('aaaaaaaaaaa')],
    })
    const res = await getChannelInfo('https://www.youtube.com/@canal')
    expect(mockYoutube.getChannel).toHaveBeenCalledWith({ url: 'https://www.youtube.com/@canal' })
    expect(res.name).toBe('Canal')
    expect(res.items).toHaveLength(1)
  })

  it('error nativo devuelve null', async () => {
    mockYoutube.getChannel.mockRejectedValue(new Error('channel not found'))
    expect(await getChannelInfo('https://www.youtube.com/@x')).toBeNull()
  })
})
