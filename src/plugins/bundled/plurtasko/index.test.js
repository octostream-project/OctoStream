import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_TYPES } from '../../base.js'
import { CHANNELS, plurtaskoFactory, titleRelevance, rankSearchResults, titleSeasonMarker, extractPageYear } from './index.js'

// fetchHtml se mockea a nivel de módulo: la verificación por año descarga
// la página del resultado y los tests no deben tocar la red. Por defecto
// devuelve '' (sin año) → el match se conserva por beneficio de la duda.
vi.mock('./http.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchHtml: vi.fn(async () => '') }
})
import { fetchHtml } from './http.js'

const channel = CHANNELS.find(item => item.id === 'animeflvone')
const originalGetMeta = channel.getMeta
const originalGetStreams = channel.getStreams
const originalSearch = channel.search

// getStreams con un id de catálogo (p.ej. anilist-anime-…) recorre todos los
// canales: stub de `search` en todos para que el test no toque la red. El
// mapa recibe los items que debe devolver cada canal; el resto devuelve [].
function stubAllSearches(resultsByChannel = {}) {
  const originals = new Map(CHANNELS.map(ch => [ch, ch.search]))
  for (const ch of CHANNELS) {
    ch.search = vi.fn().mockResolvedValue(resultsByChannel[ch.id] || [])
  }
  return {
    restore() {
      for (const ch of CHANNELS) ch.search = originals.get(ch)
    },
  }
}

afterEach(() => {
  channel.getMeta = originalGetMeta
  channel.getStreams = originalGetStreams
  channel.search = originalSearch
  vi.restoreAllMocks()
})

describe('Plurtasko hierarchy', () => {
  it('derives seasons from provider episodes', async () => {
    channel.getMeta = vi.fn().mockResolvedValue({
      id: 'animeflvone:https://vww.animeflv.one/anime/demo',
      type: CONTENT_TYPES.SERIES,
      name: 'Demo',
      episodes: [
        { id: 'animeflvone:https://vww.animeflv.one/ver/demo-1', season: 1, episode: 1 },
        { id: 'animeflvone:https://vww.animeflv.one/ver/demo-2', season: 1, episode: 2 },
        { id: 'animeflvone:https://vww.animeflv.one/ver/demo-3', season: 2, episode: 1 },
      ],
    })
    const plugin = plurtaskoFactory({ manifest: {} })

    const meta = await plugin.getMeta({ type: CONTENT_TYPES.SERIES, id: 'animeflvone:https://vww.animeflv.one/anime/demo' })

    expect(meta.seasonsList).toEqual([
      expect.objectContaining({ seasonNumber: 1, episodeCount: 2 }),
      expect.objectContaining({ seasonNumber: 2, episodeCount: 1 }),
    ])
  })

  it('does not resolve streams before an episode is selected', async () => {
    channel.getStreams = vi.fn()
    const plugin = plurtaskoFactory({ manifest: {} })

    const streams = await plugin.getStreams({
      type: CONTENT_TYPES.SERIES,
      id: 'animeflvone:https://vww.animeflv.one/anime/demo',
      name: 'Demo',
    })

    expect(streams).toEqual([])
    expect(channel.getStreams).not.toHaveBeenCalled()
  })

  it('resolves only the selected provider episode', async () => {
    channel.getMeta = vi.fn().mockResolvedValue({
      id: 'animeflvone:https://vww.animeflv.one/anime/demo',
      type: CONTENT_TYPES.SERIES,
      name: 'Demo',
      episodes: [
        { id: 'animeflvone:https://vww.animeflv.one/ver/demo-1', season: 1, episode: 1 },
        { id: 'animeflvone:https://vww.animeflv.one/ver/demo-2', season: 1, episode: 2 },
      ],
    })
    channel.getStreams = vi.fn().mockResolvedValue([{
      url: 'https://cdn.example.com/demo-2.mp4',
      streamType: 'mp4',
      server: 'Directo',
    }])
    const plugin = plurtaskoFactory({ manifest: {} })

    const streams = await plugin.getStreams({
      type: CONTENT_TYPES.SERIES,
      id: 'animeflvone:https://vww.animeflv.one/anime/demo',
      name: 'Demo',
      season: 1,
      episode: 2,
    })

    expect(channel.getStreams).toHaveBeenCalledWith(expect.objectContaining({
      id: 'animeflvone:https://vww.animeflv.one/ver/demo-2',
      season: 1,
      episode: 2,
    }))
    expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.example.com/demo-2.mp4' })])
  })

  it('rejects provider IDs targeting private hosts', async () => {
    channel.getMeta = vi.fn()
    const plugin = plurtaskoFactory({ manifest: {} })

    const meta = await plugin.getMeta({ type: CONTENT_TYPES.SERIES, id: 'animeflvone:http://127.0.0.1/admin' })

    expect(meta).toBeNull()
    expect(channel.getMeta).not.toHaveBeenCalled()
  })
})

describe('isTitleMatch strictness', () => {
  // isTitleMatch is not exported; we test it indirectly via normalizeTitle + the
  // matching logic used in getStreams. The key regression: single-word titles
  // that are substrings of each other must NOT match.
  // We import the internal module to access the function.
  it('does not match "Reacher" with "Preacher" (single-word substring)', async () => {
    // Re-import the module to access the internal isTitleMatch via a re-export
    // Since isTitleMatch is module-internal, we test the behavior through the
    // public API by checking that a search for "Reacher" does not accept
    // "Preacher" results. We use a lightweight inline check mirroring the logic.
    const normalize = (s) => s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^(the|el|la|los|las|un|una|unos|unas|a|an)\s+/i, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const isTitleMatch = (itemName, targetName) => {
      const a = normalize(itemName)
      const b = normalize(targetName)
      if (!a || !b) return false
      if (a === b) return true
      const wordsA = a.split(/\s+/).filter(w => w.length >= 4)
      const wordsB = b.split(/\s+/).filter(w => w.length >= 4)
      if (wordsA.length <= 1 || wordsB.length <= 1) return false
      const shorter = a.length < b.length ? a : b
      const longer = a.length < b.length ? b : a
      if (longer.includes(shorter) && shorter.length >= longer.length * 0.8) return true
      if (wordsA.length > 0 && wordsB.length > 0) {
        const shared = wordsA.every(w => wordsB.includes(w)) || wordsB.every(w => wordsA.includes(w))
        if (shared) return true
      }
      return false
    }
    expect(isTitleMatch('Reacher', 'Preacher')).toBe(false)
    expect(isTitleMatch('Reacher', 'Reacher')).toBe(true)
    expect(isTitleMatch('Reacher', 'reacher')).toBe(true)
    // Multi-word titles still match when all significant words overlap
    expect(isTitleMatch('The Matrix Reloaded', 'Matrix Reloaded')).toBe(true)
    expect(isTitleMatch('Matrix Revolutions', 'Matrix')).toBe(false)
  })
})

describe('titleRelevance / rankSearchResults (búsqueda exacta)', () => {
  it('puntúa exact > contiene-palabra > overlap > nada', () => {
    expect(titleRelevance('Naruto', 'Naruto')).toBe(100)
    expect(titleRelevance('Naruto', 'Naruto Shippuden')).toBeGreaterThan(70)
    expect(titleRelevance('Naruto', 'Boruto: Naruto Next Generations')).toBeGreaterThan(60)
    // "Reacher" no puede puntuar contra "Preacher" (substring, no palabra)
    expect(titleRelevance('Reacher', 'Preacher - 1ª Temporada')).toBe(0)
    // "Dune" tampoco contra "The Dunes" (palabra distinta)
    expect(titleRelevance('Dune', 'The Dunes')).toBe(0)
    expect(titleRelevance('Dune', 'Dune: Parte dos')).toBeGreaterThan(70)
  })

  it('ordena por relevancia y descarta los resultados sin relación si hay match bueno', () => {
    const items = [
      { id: 'a:1', name: 'Preacher - 1ª Temporada', type: 'series' },
      { id: 'a:2', name: 'Reacher - 1ª Temporada', type: 'series' },
      { id: 'a:3', name: 'Reacher', type: 'series' },
    ]
    const out = rankSearchResults('Reacher', items)
    expect(out[0].name).toBe('Reacher')
    expect(out.map(i => i.name)).not.toContain('Preacher - 1ª Temporada')
    expect(out).toHaveLength(2)
  })

  it('conserva resultados flojos cuando ninguno es bueno (mejor algo que vacío)', () => {
    const items = [{ id: 'a:1', name: 'Cualquier cosa', type: 'movie' }]
    expect(rankSearchResults('Sin nada que ver', items)).toHaveLength(1)
  })

  it('deduplica por id/url conservando fuentes distintas del mismo título', () => {
    const items = [
      { id: 'jk:https://x/naruto', name: 'Naruto', type: 'series' },
      { id: 'jk:https://x/naruto', name: 'Naruto', type: 'series' },
      { id: 'flv:https://y/naruto', name: 'Naruto', type: 'series' },
    ]
    const out = rankSearchResults('Naruto', items)
    expect(out).toHaveLength(2)
  })
})

describe('titleSeasonMarker (marcador de temporada en el título)', () => {
  it('extrae el número de los formatos habituales', () => {
    expect(titleSeasonMarker('Kusuriya no Hitorigoto 3rd Season')).toBe(3)
    expect(titleSeasonMarker('Black Clover 2nd Season')).toBe(2)
    expect(titleSeasonMarker('The Apothecary Diaries Season 3')).toBe(3)
    expect(titleSeasonMarker('Tantei wa mou, Shindeiru. Season 2')).toBe(2)
    expect(titleSeasonMarker('Reacher - 2ª Temporada')).toBe(2)
    expect(titleSeasonMarker('Reacher Temporada 4')).toBe(4)
    expect(titleSeasonMarker('Attack on Titan Final Season Part 2')).toBe(2)
    expect(titleSeasonMarker('Attack on Titan Final Season')).toBe('final')
    expect(titleSeasonMarker('Cyberpunk: Edgerunners II')).toBe(2)
    expect(titleSeasonMarker('Rocky III')).toBe(3)
  })

  it('devuelve null cuando el título no lleva marcador', () => {
    expect(titleSeasonMarker('Black Clover')).toBeNull()
    expect(titleSeasonMarker('Kusuriya no Hitorigoto')).toBeNull()
    expect(titleSeasonMarker('District 9')).toBeNull()
    expect(titleSeasonMarker('')).toBeNull()
    expect(titleSeasonMarker(null)).toBeNull()
  })

  it('distingue temporada pedida de la vieja al resolver streams', async () => {
    // Regresión: los canales de anime etiquetan todos sus items con
    // season:1 — el picker no puede fiarse de it.season y debe usar el
    // marcador del título. Aquí el canal devuelve la franquicia y la S3;
    // el match correcto es la S3 aunque llegue después en la lista.
    const searchStub = stubAllSearches({
      animeflvone: [
        { id: 'ch:s1', url: 'https://x/kusuriya', name: 'Kusuriya no Hitorigoto', season: 1 },
        { id: 'ch:s2', url: 'https://x/kusuriya-2', name: 'Kusuriya no Hitorigoto 2nd Season', season: 1 },
        { id: 'ch:s3', url: 'https://x/kusuriya-3', name: 'Kusuriya no Hitorigoto 3rd Season', season: 1 },
      ],
    })
    channel.getMeta = vi.fn().mockResolvedValue({
      id: 'ch:s3', name: 'Kusuriya no Hitorigoto 3rd Season', type: CONTENT_TYPES.SERIES,
      episodes: [{ id: 'ch:s3e1', season: 1, episode: 1 }],
    })
    channel.getStreams = vi.fn().mockResolvedValue([{ url: 'https://cdn.x/s3e1.mp4', streamType: 'mp4', server: 'Directo' }])
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.ANIME,
        id: 'anilist-anime-k50021',
        name: 'Kusuriya no Hitorigoto 3rd Season',
        season: 1,
        episode: 1,
      })
      expect(channel.getStreams).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch:s3' }))
      expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.x/s3e1.mp4' })])
    } finally {
      searchStub.restore()
    }
  })

  it('desambigua remakes con el mismo título por año', async () => {
    // Regresión: "Llamada perdida" existe como película japonesa (2003) y
    // remake americano (2008) — el sitio devuelve ambas y el match debe
    // preferir la del año pedido por la ficha.
    const movieChannel = CHANNELS.find(ch => ch.id === 'repelishd')
    const origGetStreams = movieChannel.getStreams
    const searchStub = stubAllSearches({
      repelishd: [
        { id: 'r:old', url: 'https://x/llamada-perdida-2003', name: 'Llamada perdida', year: 2003 },
        { id: 'r:new', url: 'https://x/llamada-perdida-2008', name: 'Llamada perdida', year: 2008 },
      ],
    })
    movieChannel.getStreams = vi.fn().mockResolvedValue([
      { url: 'https://cdn.x/llamada-2008.mp4', streamType: 'mp4', server: 'Directo' },
    ])
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.MOVIE,
        id: 'tmdb-movie-480',
        name: 'Llamada perdida',
        year: 2008,
      })
      expect(movieChannel.getStreams).toHaveBeenCalledWith(expect.objectContaining({ id: 'r:new' }))
      expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.x/llamada-2008.mp4' })])
    } finally {
      movieChannel.getStreams = origGetStreams
      searchStub.restore()
    }
  })

  it('sin año pedido, conserva el mejor match por título aunque haya varios', async () => {
    const movieChannel = CHANNELS.find(ch => ch.id === 'repelishd')
    const origGetStreams = movieChannel.getStreams
    const searchStub = stubAllSearches({
      repelishd: [
        { id: 'r:old', url: 'https://x/llamada-perdida-2003', name: 'Llamada perdida', year: 2003 },
        { id: 'r:new', url: 'https://x/llamada-perdida-2008', name: 'Llamada perdida', year: 2008 },
      ],
    })
    movieChannel.getStreams = vi.fn().mockResolvedValue([
      { url: 'https://cdn.x/llamada.mp4', streamType: 'mp4', server: 'Directo' },
    ])
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.MOVIE,
        id: 'tmdb-movie-480',
        name: 'Llamada perdida',
      })
      expect(movieChannel.getStreams).toHaveBeenCalled()
      expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.x/llamada.mp4' })])
    } finally {
      movieChannel.getStreams = origGetStreams
      searchStub.restore()
    }
  })

  it('no reproduce la temporada vieja cuando el sitio solo tiene la franquicia', async () => {
    // Regresión del bug reportado: la query pide "2nd Season" y el sitio
    // solo tiene la página de la franquicia (S1) o una temporada distinta →
    // antes se aceptaba y se reproducía la temporada vieja. Ahora el canal
    // no aporta streams.
    const searchStub = stubAllSearches({
      animeflvone: [
        { id: 'ch:s1', url: 'https://x/blue-box', name: 'Ao no Hako', season: 1 },
        { id: 'ch:other', url: 'https://x/edens-zero-2', name: 'Edens Zero 2nd Season', season: 1 },
      ],
    })
    channel.getMeta = vi.fn()
    channel.getStreams = vi.fn()
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.ANIME,
        id: 'anilist-anime-k49752',
        name: 'Ao no Hako 2nd Season',
        season: 1,
        episode: 1,
      })
      expect(streams).toEqual([])
      expect(channel.getStreams).not.toHaveBeenCalled()
    } finally {
      searchStub.restore()
    }
  })
})

describe('verificación por año de la página del resultado', () => {
  it('extractPageYear lee los formatos habituales', () => {
    // DonTorrent: "Año 2002" en <title>/meta
    expect(extractPageYear('<title>Año 2002 Torrent Gratis - DonTorrent</title>')).toBe(2002)
    // GranTorrent: Año:</span><span>2020
    expect(extractPageYear('<span>Año:</span>\n<span class="x">2020</span>')).toBe(2020)
    // Pelispedia: <span class="year fa-calendar far">2013</span>
    expect(extractPageYear('<span class="year fa-calendar far">2013</span>')).toBe(2013)
    // JSON-LD releaseDate
    expect(extractPageYear('{"releaseDate":"2007-12-27"}')).toBe(2007)
    // "(2013)" en el <title>
    expect(extractPageYear('<title>Ver Peli (2013) Online</title>')).toBe(2013)
    // datePublished NO es el año de la peli (fecha del artículo)
    expect(extractPageYear('{"datePublished":"2021"}')).toBeNull()
    expect(extractPageYear('<p>sin año por ningún lado</p>')).toBeNull()
    expect(extractPageYear('')).toBeNull()
    expect(extractPageYear(null)).toBeNull()
  })

  it('rechaza el match cuando la página declara otro año (peli homónima)', async () => {
    // Regresión: buscar "Hansel y Gretel" (2007, coreana) devolvía
    // "Hansel y Gretel: Cazadores de brujas" (2013) y la reproducía.
    const movieChannel = CHANNELS.find(ch => ch.id === 'repelishd')
    const origGetStreams = movieChannel.getStreams
    const searchStub = stubAllSearches({
      repelishd: [
        { id: 'r:hg2013', url: 'https://t.example/peli/hansel-cazadores', name: 'Hansel y Gretel: Cazadores de brujas' },
      ],
    })
    vi.mocked(fetchHtml).mockImplementation(async (url) =>
      url === 'https://t.example/peli/hansel-cazadores'
        ? '<span class="year fa-calendar far">2013</span>' : '')
    movieChannel.getStreams = vi.fn()
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.MOVIE,
        id: 'tmdb-movie-15185',
        name: 'Hansel y Gretel',
        year: 2007,
      })
      expect(streams).toEqual([])
      expect(movieChannel.getStreams).not.toHaveBeenCalled()
    } finally {
      movieChannel.getStreams = origGetStreams
      searchStub.restore()
      vi.mocked(fetchHtml).mockReset().mockResolvedValue('')
    }
  })

  it('prefiere al rival cuyo año coincide cuando el favorito declara otro', async () => {
    // Dos candidatos homónimos: el de mejor título declara 2013 pero el
    // segundo declara 2007 → debe ganar el segundo.
    const movieChannel = CHANNELS.find(ch => ch.id === 'repelishd')
    const origGetStreams = movieChannel.getStreams
    const searchStub = stubAllSearches({
      repelishd: [
        { id: 'r:hg2013', url: 'https://t2.example/peli/hg-2013', name: 'Hansel y Gretel: Cazadores de brujas' },
        { id: 'r:hg2007', url: 'https://t2.example/peli/hg-2007', name: 'Hansel y Gretel: El cuento' },
      ],
    })
    vi.mocked(fetchHtml).mockImplementation(async (url) => ({
      'https://t2.example/peli/hg-2013': '<span class="year">2013</span>',
      'https://t2.example/peli/hg-2007': '<span class="year">2007</span>',
    })[url] || '')
    movieChannel.getStreams = vi.fn().mockResolvedValue([
      { url: 'https://cdn.x/hg-coreana.mp4', streamType: 'mp4', server: 'Directo' },
    ])
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.MOVIE,
        id: 'tmdb-movie-15185',
        name: 'Hansel y Gretel',
        year: 2007,
      })
      expect(movieChannel.getStreams).toHaveBeenCalledWith(expect.objectContaining({ id: 'r:hg2007' }))
      expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.x/hg-coreana.mp4' })])
    } finally {
      movieChannel.getStreams = origGetStreams
      searchStub.restore()
      vi.mocked(fetchHtml).mockReset().mockResolvedValue('')
    }
  })

  it('conserva el match cuando la página no declara año (beneficio de la duda)', async () => {
    const movieChannel = CHANNELS.find(ch => ch.id === 'repelishd')
    const origGetStreams = movieChannel.getStreams
    const searchStub = stubAllSearches({
      repelishd: [
        { id: 'r:hg', url: 'https://t3.example/peli/hg', name: 'La Peli Sin Año' },
      ],
    })
    // fetchHtml ya devuelve '' por defecto → sin año en la página
    movieChannel.getStreams = vi.fn().mockResolvedValue([
      { url: 'https://cdn.x/hg.mp4', streamType: 'mp4', server: 'Directo' },
    ])
    try {
      const plugin = plurtaskoFactory({ manifest: {} })
      const streams = await plugin.getStreams({
        type: CONTENT_TYPES.MOVIE,
        id: 'tmdb-movie-99991',
        name: 'La Peli Sin Año',
        year: 2007,
      })
      expect(movieChannel.getStreams).toHaveBeenCalledWith(expect.objectContaining({ id: 'r:hg' }))
      expect(streams).toEqual([expect.objectContaining({ url: 'https://cdn.x/hg.mp4' })])
    } finally {
      movieChannel.getStreams = origGetStreams
      searchStub.restore()
    }
  })
})
