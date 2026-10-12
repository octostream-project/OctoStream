import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_TYPES } from '../base.js'
import {
  mdblistPlugin,
  traktPlugin,
  letterboxdPlugin,
  filmaffinityPlugin,
  getTraktUserLists,
  getTraktToken,
  getTraktMyLists,
  traktDeviceCode,
  traktDeviceToken,
  traktMe,
  clearTraktTokens,
  __clearExtProvidersCache,
} from './extProviders.js'

function mockFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const body = handler(u)
    if (body == null) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    if (typeof body === 'string') {
      return { ok: true, status: 200, json: async () => ({}), text: async () => body }
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }))
}

beforeEach(() => {
  localStorage.clear()
  __clearExtProvidersCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('MDBList plugin', () => {
  it('hides catalogs without api key and shows them with key', () => {
    expect(mdblistPlugin.manifest.catalogs).toEqual([])
    localStorage.setItem('octostream_mdblist_key', 'k')
    expect(mdblistPlugin.manifest.catalogs.length).toBeGreaterThan(10)
    expect(mdblistPlugin.manifest.catalogs[0].id).toBe('imdb-top-250-movies')
  })

  it('returns [] without api key', async () => {
    mockFetch(() => { throw new Error('network should not be called') })
    const items = await mdblistPlugin.getCatalog({ id: 'imdb-top-250-movies' })
    expect(items).toEqual([])
  })

  it('normalizes list items to tmdb ids when available', async () => {
    localStorage.setItem('octostream_mdblist_key', 'k')
    mockFetch(u => {
      if (u.includes('api.mdblist.com/lists/snoak/imdb-top-250-movies/items')) {
        return {
          movies: [
            { title: 'The Shawshank Redemption', imdb_id: 'tt0111161', tmdb_id: 278, release_year: 1994, mediatype: 'movie' },
            { title: 'Matrix', imdb_id: 'tt0133093', release_year: 1999, mediatype: 'movie' },
          ],
          shows: [
            { title: 'Breaking Bad', imdb_id: 'tt0903747', tmdb_id: 1396, release_year: 2008, mediatype: 'show' },
          ],
        }
      }
    })
    const items = await mdblistPlugin.getCatalog({ id: 'imdb-top-250-movies', top: 50 })
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      id: 'tmdb-movie-278',
      type: CONTENT_TYPES.MOVIE,
      name: 'The Shawshank Redemption',
      year: 1994,
      poster: 'https://images.metahub.space/poster/medium/tt0111161/img',
    })
    // sin tmdb_id → id propio que getMeta resuelve vía /find
    expect(items[1].id).toBe('mdblist-movie-tt0133093')
    expect(items[2].id).toBe('tmdb-series-1396')
  })

  it('paginates client-side with skip/top', async () => {
    localStorage.setItem('octostream_mdblist_key', 'k2')
    mockFetch(u => {
      if (u.includes('api.mdblist.com')) {
        return { movies: Array.from({ length: 5 }, (_, i) => ({
          title: `Film ${i}`, imdb_id: `tt00000${i}`, tmdb_id: i + 1, mediatype: 'movie',
        })) }
      }
    })
    const items = await mdblistPlugin.getCatalog({ id: 'imdb-top-250-movies', skip: 2, top: 2 })
    expect(items.map(i => i.name)).toEqual(['Film 2', 'Film 3'])
  })

  it('resolves imdb-only items to TMDB meta via /find', async () => {
    mockFetch(u => {
      if (u.includes('/find/tt0133093')) {
        return { movie_results: [{ id: 603 }], tv_results: [] }
      }
      if (u.includes('/movie/603')) {
        return { id: 603, title: 'Matrix', release_date: '1999-03-31', overview: 'Neo…' }
      }
    })
    const meta = await mdblistPlugin.getMeta({ type: 'movie', id: 'mdblist-movie-tt0133093' })
    expect(meta).toMatchObject({ id: 'tmdb-movie-603', name: 'Matrix' })
  })
})

describe('Trakt plugin', () => {
  it('hides catalogs without client id', () => {
    expect(traktPlugin.manifest.catalogs).toEqual([])
    localStorage.setItem('octostream_trakt_key', 'cid')
    expect(traktPlugin.manifest.catalogs.length).toBeGreaterThan(5)
  })

  it('normalizes trending items (wrapped in movie/show)', async () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    let capturedHeaders
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      capturedHeaders = opts.headers
      return {
        ok: true, status: 200,
        json: async () => ([
          { watchers: 100, movie: { title: 'Dune: Part Two', year: 2024, ids: { trakt: 1, imdb: 'tt15239678', tmdb: 693134 } } },
        ]),
      }
    }))
    const items = await traktPlugin.getCatalog({ id: 'trending-movies', top: 50 })
    expect(capturedHeaders['trakt-api-key']).toBe('cid')
    expect(capturedHeaders['trakt-api-version']).toBe('2')
    expect(items[0]).toMatchObject({
      id: 'tmdb-movie-693134',
      type: CONTENT_TYPES.MOVIE,
      name: 'Dune: Part Two',
      year: 2024,
    })
  })

  it('normalizes popular items (bare objects)', async () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    mockFetch(() => ([
      { title: 'Andor', year: 2022, ids: { imdb: 'tt9253284', tmdb: 83867 } },
    ]))
    const items = await traktPlugin.getCatalog({ id: 'popular-shows', top: 50 })
    expect(items[0]).toMatchObject({ id: 'tmdb-series-83867', type: CONTENT_TYPES.SERIES })
  })

  it('parses configured user lists', () => {
    localStorage.setItem('octostream_trakt_lists', 'trakt/most-anticipated-movies, me/milista:Mi lista bonita, invalid entry')
    const lists = getTraktUserLists()
    expect(lists).toEqual([
      { ref: 'trakt/most-anticipated-movies', name: 'most-anticipated-movies' },
      { ref: 'me/milista', name: 'Mi lista bonita' },
    ])
    // y aparecen como catálogos cuando hay key
    localStorage.setItem('octostream_trakt_key', 'cid')
    const cats = traktPlugin.manifest.catalogs
    expect(cats.some(c => c.id === 'user-list-trakt-most-anticipated-movies')).toBe(true)
  })

  it('device code flow: POSTs client_id and returns user code', async () => {
    let body
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      body = JSON.parse(opts.body)
      return {
        ok: true, status: 200,
        json: async () => ({
          device_code: 'dev123', user_code: 'ABCD-1234',
          verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5,
        }),
      }
    }))
    const dc = await traktDeviceCode('cid')
    expect(body).toEqual({ client_id: 'cid' })
    expect(dc).toMatchObject({ deviceCode: 'dev123', userCode: 'ABCD-1234', interval: 5 })
  })

  it('device token poll: null while pending, saves tokens on success', async () => {
    // 400 = authorization_pending
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })))
    expect(await traktDeviceToken('dev', 'cid', 'sec')).toBeNull()
    expect(getTraktToken()).toBe('')

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        access_token: 'tok1', refresh_token: 'ref1',
        created_at: Math.floor(Date.now() / 1000), expires_in: 7776000,
      }),
    })))
    const res = await traktDeviceToken('dev', 'cid', 'sec')
    expect(res.access_token).toBe('tok1')
    expect(getTraktToken()).toBe('tok1')
    expect(localStorage.getItem('octostream_trakt_refresh')).toBe('ref1')
    clearTraktTokens()
    expect(getTraktToken()).toBe('')
    expect(localStorage.getItem('octostream_trakt_refresh') || '').toBe('')
  })

  it('device token poll: throws on definitive failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 410,
      json: async () => ({ error: 'expired', error_description: 'Code expired' }),
    })))
    await expect(traktDeviceToken('dev', 'cid', 'sec')).rejects.toThrow('Code expired')
  })

  it('exposes personal catalogs only when connected', () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    expect(traktPlugin.manifest.catalogs.some(c => c.id === 'my-watchlist-movies')).toBe(false)
    localStorage.setItem('octostream_trakt_token', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ([]) })))
    const cats = traktPlugin.manifest.catalogs
    expect(cats.some(c => c.id === 'my-watchlist-movies')).toBe(true)
    expect(cats.some(c => c.id === 'my-watchlist-shows')).toBe(true)
    expect(cats.some(c => c.id === 'my-rec-shows')).toBe(true)
  })

  it('fetches watchlist with Authorization Bearer header', async () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    localStorage.setItem('octostream_trakt_token', 'tok')
    let captured
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers }
      return {
        ok: true, status: 200,
        json: async () => ([
          { movie: { title: 'Dune', year: 2021, ids: { imdb: 'tt1160419', tmdb: 438631 } } },
        ]),
      }
    }))
    const items = await traktPlugin.getCatalog({ id: 'my-watchlist-movies', top: 50 })
    expect(captured.url).toContain('/users/me/watchlist/movies')
    expect(captured.headers.Authorization).toBe('Bearer tok')
    expect(items[0]).toMatchObject({ id: 'tmdb-movie-438631', type: CONTENT_TYPES.MOVIE })
  })

  it('fetches own lists and their items with auth headers', async () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    localStorage.setItem('octostream_trakt_token', 'tok')
    localStorage.setItem('octostream_trakt_mylists', JSON.stringify({
      lists: [{ slug: 'favoritas-2024', name: 'Favoritas 2024' }],
    }))
    expect(getTraktMyLists()[0].slug).toBe('favoritas-2024')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ([]) })))
    expect(traktPlugin.manifest.catalogs.some(c => c.id === 'my-list-favoritas-2024')).toBe(true)

    let url
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      url = String(u)
      return {
        ok: true, status: 200,
        json: async () => ([
          { type: 'movie', movie: { title: 'Alien', year: 1979, ids: { imdb: 'tt0078748', tmdb: 348 } } },
        ]),
      }
    }))
    const items = await traktPlugin.getCatalog({ id: 'my-list-favoritas-2024', top: 50 })
    expect(url).toContain('/users/me/lists/favoritas-2024/items')
    expect(items[0]).toMatchObject({ id: 'tmdb-movie-348', name: 'Alien' })
  })

  it('traktMe caches the connected username', async () => {
    localStorage.setItem('octostream_trakt_key', 'cid')
    localStorage.setItem('octostream_trakt_token', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { username: 'octofan', ids: { slug: 'octofan' } } }),
    })))
    const me = await traktMe()
    expect(me.username).toBe('octofan')
    expect(localStorage.getItem('octostream_trakt_user')).toBe('octofan')
  })
})

describe('Letterboxd plugin (scraping)', () => {
  const LB_HTML = `
    <li class="griditem"><div class="poster film-poster" data-film-id="1" data-film-slug="dune-part-two">
      <img alt="Dune: Part Two" src="https://a.ltrbxd.com/resized/film-poster/1/2/3/dune-part-two.jpg"></div></li>
    <li class="griditem"><div class="poster film-poster" data-film-id="2" data-film-slug="alien-1979">
      <img alt="Alien &amp; co" src="https://a.ltrbxd.com/resized/film-poster/4/5/6/alien.jpg"></div></li>`

  it('parses film grid items', async () => {
    mockFetch(() => LB_HTML)
    const items = await letterboxdPlugin.getCatalog({ id: 'genre-horror' })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'lb-film-dune-part-two',
      type: CONTENT_TYPES.MOVIE,
      name: 'Dune: Part Two',
    })
    expect(items[0].poster).toContain('ltrbxd.com')
    expect(items[1].name).toBe('Alien & co')
  })

  it('returns [] on Cloudflare challenge', async () => {
    mockFetch(() => '<html><head><title>Just a moment...</title></head></html>')
    const items = await letterboxdPlugin.getCatalog({ id: 'genre-horror' })
    expect(items).toEqual([])
  })

  it('resolves meta via the TMDB link in the film page', async () => {
    mockFetch(u => {
      if (u.includes('letterboxd.com/film/dune-part-two')) {
        return '<html><a href="https://www.themoviedb.org/movie/693134/">TMDB</a></html>'
      }
      if (u.includes('/movie/693134')) {
        return { id: 693134, title: 'Dune: Part Two', release_date: '2024-03-01', overview: '…' }
      }
    })
    const meta = await letterboxdPlugin.getMeta({ type: 'movie', id: 'lb-film-dune-part-two' })
    expect(meta).toMatchObject({ id: 'tmdb-movie-693134', name: 'Dune: Part Two' })
  })
})

describe('FilmAffinity plugin (scraping)', () => {
  const FA_HTML = `
    <div class="fa-card"><div class="row movie-card" data-movie-id="809297">
      <div class="mc-poster"><img data-srcset="https://pics.filmaffinity.com/godfather-msmall.jpg 150w, https://pics.filmaffinity.com/godfather-mmed.jpg 300w"></div>
      <div class="fs-6 mc-title"><a href="https://www.filmaffinity.com/es/film809297.html">El padrino</a></div>
      <span class="mc-year">1972</span>
      <div class="avg">9,0</div>
    </div></div>`

  it('parses top cards with spanish titles, year, poster and rating', async () => {
    mockFetch(() => FA_HTML)
    const items = await filmaffinityPlugin.getCatalog({ id: 'top' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'fa-film-809297',
      name: 'El padrino',
      year: 1972,
      rating: 9,
    })
    expect(items[0].poster).toContain('mmed.jpg')
  })

  it('returns [] on Cloudflare challenge', async () => {
    mockFetch(() => '<html><head><title>Just a moment...</title></head></html>')
    expect(await filmaffinityPlugin.getCatalog({ id: 'top' })).toEqual([])
  })

  it('falls back to cached minimal meta when film page fails', async () => {
    mockFetch(u => {
      if (u.includes('topgen.php')) return FA_HTML
      throw new Error('blocked')
    })
    await filmaffinityPlugin.getCatalog({ id: 'top' })
    const meta = await filmaffinityPlugin.getMeta({ type: 'movie', id: 'fa-film-809297' })
    expect(meta).toMatchObject({ name: 'El padrino', year: 1972 })
  })
})
