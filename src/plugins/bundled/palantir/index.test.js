import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CONTENT_TYPES } from '../../base.js'

const palantirMock = {
  getStatus: vi.fn(),
  install: vi.fn(),
  query: vi.fn(),
  execScript: vi.fn(),
  decryptLinks: vi.fn(),
  setLastUpdate: vi.fn(),
  addListener: vi.fn(),
}

let native = true

vi.mock('@octostream/palantir', () => ({ default: palantirMock }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native },
  registerPlugin: () => palantirMock,
}))

const { palantirFactory } = await import('./index.js')
const db = await import('./db.js')

const makePlugin = () => palantirFactory({ manifest: {} })

beforeEach(() => {
  vi.clearAllMocks()
  native = true
  palantirMock.getStatus.mockResolvedValue({ installed: true, version: '3.3.11', lastUpdate: '', sizeBytes: 1 })
  // No update check inside tests
  localStorage.setItem('palantir_last_update_check', String(Date.now()))
})

describe('Palantir catalogs', () => {
  it('returns paginated movie items mapped from DB rows', async () => {
    palantirMock.query.mockResolvedValue({
      columns: ['tmdb', 'titulo', 'fecha', 'poster', 'rating'],
      rows: [[2, 'Muere Hart 2', '2024-10-21', '/abc.jpg', '7.1/6.9']],
    })
    const plugin = makePlugin()
    const items = await plugin.getCatalog({ id: 'palantir-peliculas', skip: 0, top: 50 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'palantir:movie:2',
      type: CONTENT_TYPES.MOVIE,
      name: 'Muere Hart 2',
      year: '2024',
      poster: 'https://image.tmdb.org/t/p/w342/abc.jpg',
    })
    const sql = palantirMock.query.mock.calls[0][0].sql
    expect(sql).toMatch(/FROM pelis/)
    expect(sql).toMatch(/LIMIT \? OFFSET \?/)
    expect(palantirMock.query.mock.calls[0][0].args).toEqual([50, 0])
  })

  it('returns empty on non-native platforms without touching the DB', async () => {
    native = false
    const plugin = makePlugin()
    expect(await plugin.getCatalog({ id: 'palantir-peliculas' })).toEqual([])
    expect(palantirMock.query).not.toHaveBeenCalled()
  })

  it('does not install the DB from meta/streams/search (only catalogs install)', async () => {
    palantirMock.getStatus.mockResolvedValue({ installed: false })
    const plugin = makePlugin()
    expect(await plugin.getMeta({ id: 'palantir:movie:2' })).toBeNull()
    expect(await plugin.getStreams({ id: 'palantir:movie:2' })).toEqual([])
    expect(await plugin.search({ query: 'hart' })).toEqual([])
    expect(palantirMock.install).not.toHaveBeenCalled()
  })
})

describe('Palantir meta', () => {
  it('maps a movie row to meta', async () => {
    palantirMock.query.mockResolvedValue({
      columns: ['tmdb', 'titulo', 'plot', 'poster', 'fondo', 'categoria', 'genero', 'coleccion', 'duration', 'updated', 'mpaa', 'fecha', 'trailer', 'clearlogo', 'rating'],
      rows: [[2, 'Muere Hart 2', 'plot', '/p.jpg', '/f.jpg', 'Película', 'Acción#Comedia', '', 5560, '', '16', '2024-10-21', 'ytkey', '/l.png', '7.1/6.9']],
    })
    const plugin = makePlugin()
    const meta = await plugin.getMeta({ id: 'palantir:movie:2' })
    expect(meta).toMatchObject({
      id: 'palantir:movie:2',
      type: 'movie',
      name: 'Muere Hart 2',
      description: 'plot',
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w1280/f.jpg',
      genres: ['Acción', 'Comedia'],
      rating: 7.1,
      runtime: 93,
    })
  })

  it('builds seasonsList and episodes for series', async () => {
    palantirMock.query
      .mockResolvedValueOnce({
        columns: ['tmdb', 'titulo', 'plot', 'poster', 'fondo', 'categoria', 'genero', 'updated', 'mpaa', 'fecha', 'trailer', 'clearlogo', 'rating'],
        rows: [[9, 'Serie X', '', '/p.jpg', '', 'General', '', '', '', '2020-01-01', '', '', '8/8']],
      })
      .mockResolvedValueOnce({
        columns: ['temporada', 'episodio'],
        rows: [[1, 1], [1, 2], [2, 1]],
      })
    const plugin = makePlugin()
    const meta = await plugin.getMeta({ id: 'palantir:series:9' })
    expect(meta.seasonsList).toEqual([
      expect.objectContaining({ seasonNumber: 1, episodeCount: 2 }),
      expect.objectContaining({ seasonNumber: 2, episodeCount: 1 }),
    ])
    expect(meta.episodes).toHaveLength(3)
    expect(meta.episodes[0]).toMatchObject({ season: 1, episode: 1 })
  })

  it('ignores foreign ids', async () => {
    const plugin = makePlugin()
    expect(await plugin.getMeta({ id: 'tmdb-123' })).toBeNull()
    expect(await plugin.getStreams({ id: 'plurtasko:xyz', season: 1, episode: 1 })).toEqual([])
    expect(palantirMock.query).not.toHaveBeenCalled()
  })
})

describe('Palantir streams', () => {
  it('decrypts links and marks them for lazy debrid unlock', async () => {
    palantirMock.query.mockResolvedValue({
      columns: ['link', 'calidad', 'audio', 'info'],
      rows: [['ENC1', '1080p', 'esp,eng', 'AAC'], ['ENC2', '720p', 'eng', null]],
    })
    palantirMock.decryptLinks.mockResolvedValue({
      urls: ['https://1fichier.com/?abc', 'https://1fichier.com/?def'],
    })
    const plugin = makePlugin()
    const streams = await plugin.getStreams({ id: 'palantir:series:9', season: 2, episode: 3 })
    const sql = palantirMock.query.mock.calls[0][0].sql
    expect(sql).toMatch(/enlaces_series/)
    expect(palantirMock.query.mock.calls[0][0].args).toEqual([9, 2, 3])
    expect(streams).toHaveLength(2)
    expect(streams[0]).toMatchObject({
      url: 'https://1fichier.com/?abc',
      streamType: 'debrid',
      server: '1fichier',
      quality: '1080p',
      pluginName: 'Palantir',
    })
    expect(streams[0].lang).toContain('ESP')
  })

  it('drops links that fail decryption', async () => {
    palantirMock.query.mockResolvedValue({
      columns: ['link', 'calidad', 'audio', 'info'],
      rows: [['BAD', '1080p', 'esp', null], ['OK', '720p', 'esp', null]],
    })
    palantirMock.decryptLinks.mockResolvedValue({ urls: [null, 'https://1fichier.com/?ok'] })
    const plugin = makePlugin()
    const streams = await plugin.getStreams({ id: 'palantir:movie:5' })
    expect(streams).toHaveLength(1)
    expect(streams[0].url).toBe('https://1fichier.com/?ok')
  })
})

describe('Palantir search', () => {
  it('queries both tables and returns mixed items', async () => {
    palantirMock.query
      .mockResolvedValueOnce({ columns: ['tmdb', 'titulo', 'fecha', 'poster', 'rating'], rows: [[1, 'Peli', '2020', '/a.jpg', '7'] ] })
      .mockResolvedValueOnce({ columns: ['tmdb', 'titulo', 'fecha', 'poster', 'rating'], rows: [[2, 'Serie', '2021', '/b.jpg', '8'] ] })
    const plugin = makePlugin()
    const items = await plugin.search({ query: 'test' })
    expect(items.map(i => i.id)).toEqual(['palantir:movie:1', 'palantir:series:2'])
    const pattern = palantirMock.query.mock.calls[0][0].args[0]
    expect(pattern).toBe('%test%')
  })
})

describe('p3b64decode', () => {
  // JS port of the addon's p3b64encode for a round-trip check.
  const p3b64encode = (value) => {
    let b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    const q = Math.floor(b64.length / 4)
    b64 = b64.replace(/=/g, '')
    const rev = s => s.split('').reverse().join('')
    return encodeURIComponent(rev(b64.slice(0, q)) + rev(b64.slice(q)))
  }

  it('round-trips a SQL update script', () => {
    const sql = "INSERT INTO pelis (tmdb, titulo) VALUES (1, 'It''s fine');\nDELETE FROM series WHERE tmdb = 2;"
    const encoded = p3b64encode(sql)
    expect(db.p3b64decodeToUtf8(encoded)).toBe(sql)
  })

  it('round-trips a short string with padding edge cases', () => {
    for (const s of ['a', 'ab', 'abc', 'SELECT 1', 'UPDATE keys SET value=?']) {
      expect(db.p3b64decodeToUtf8(p3b64encode(s))).toBe(s)
    }
  })
})
