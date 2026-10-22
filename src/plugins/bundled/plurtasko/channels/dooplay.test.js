import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../http.js', async () => {
  const actual = await vi.importActual('../http.js')
  return {
    ...actual,
    fetchHtml: vi.fn(),
    postHtml: vi.fn(),
    postJson: vi.fn(),
  }
})

import { fetchHtml, postHtml } from '../http.js'
import { estrenoscinesaa } from './estrenoscinesaa.js'
import { cinemitas } from './cinemitas.js'

const HOST = 'https://www.estrenoscinesaa.com/'

const PAD = '<!-- ' + 'x'.repeat(1100) + ' -->'

const CATALOG_HTML = `<html><body>${PAD}
<article class="item" id="post-18931"><div class="image"><a href="${HOST}movies/unabomber/">
<img src="https://image.tmdb.org/t/p/w780/x.jpg" alt="UNABOMBER" /></a>
<a href="${HOST}movies/unabomber/"><div class="data"><h3 class="title">UNABOMBER</h3><span>2026</span></div></a>
<span class="item_type">Película</span></div></article>
<article class="item" id="post-2"><div class="image"><a href="${HOST}tvshows/agatha/">
<img src="y.jpg" alt="Agatha" /></a>
<a href="${HOST}tvshows/agatha/"><div class="data"><h3 class="title">Agatha</h3><span>2024</span></div></a>
<span class="item_type">Serie</span></div></article>
</body></html>`

const SERIES_HTML = `<html><body>${PAD}<h1>Agatha en todas partes</h1>
<div id='seasons'><div class='se-c'><ul class='episodios'>
<li class='mark-1'><div class='numerando'>1 - 1</div><div class='episodiotitle'><a href='${HOST}episodes/agatha-1x1/'>Encontrad la Senda</a></div></li>
<li class='mark-2'><div class='numerando'>1 - 2</div><div class='episodiotitle'><a href='${HOST}episodes/agatha-1x2/'>Círculo</a></div></li>
</ul></div></div></body></html>`

const EPISODE_HTML = `<html><body>${PAD}<h1>1x1</h1>
<li class='dooplay_player_option' data-post='16603' data-type='tv' data-nume='1'><span class='title'>FilemoonCastellano</span></li>
<li class='dooplay_player_option' data-post='16603' data-type='tv' data-nume='2'><span class='title'>UqLoadLatino</span></li>
<li class='dooplay_player_option' data-post='16603' data-type='tv' data-nume='trailer'><span class='title'>Ver trailer</span></li>
</body></html>`

const MOVIE_HTML = `<html><body>${PAD}<h1>Unabomber</h1>
<li class='dooplay_player_option' data-post='18958' data-type='movie' data-nume='1'><span class='title'>UqLoadCastellano</span></li>
<li class='dooplay_player_option' data-post='18958' data-type='movie' data-nume='2'><span class='title'>StreamTapeCastellano</span></li>
</body></html>`

beforeEach(() => vi.clearAllMocks())

describe('dooplay channels', () => {
  it('catalog parses article.item cards and filters by section', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    const movies = await estrenoscinesaa.getCatalog({ id: 'estrenoscinesaa-movies' })
    expect(movies).toHaveLength(1)
    expect(movies[0].name).toBe('UNABOMBER')
    expect(movies[0].type).toBe('movie')
    expect(movies[0].year).toBe(2026)
    const series = await estrenoscinesaa.getCatalog({ id: 'estrenoscinesaa-series' })
    expect(series).toHaveLength(1)
    expect(series[0].type).toBe('series')
  })

  it('search filters results by requested type', async () => {
    const CIN_HTML = CATALOG_HTML.replaceAll(HOST, 'https://cinemitas.org/')
    fetchHtml.mockResolvedValue(CIN_HTML)
    const m = await cinemitas.search({ query: 'x', type: 'movie' })
    expect(m).toHaveLength(1)
    expect(m[0].id.startsWith('cinemitas:')).toBe(true)
    const s = await cinemitas.search({ query: 'x', type: 'series' })
    expect(s).toHaveLength(1)
    expect(s[0].type).toBe('series')
  })

  it('getMeta extracts season/episode numbers from numerando', async () => {
    fetchHtml.mockResolvedValue(SERIES_HTML)
    const meta = await estrenoscinesaa.getMeta({ id: `estrenoscinesaa:${HOST}tvshows/agatha/` })
    expect(meta.type).toBe('series')
    expect(meta.episodes).toHaveLength(2)
    expect(meta.episodes[0]).toMatchObject({ season: 1, episode: 1 })
    expect(meta.episodes[1]).toMatchObject({ season: 1, episode: 2 })
    expect(meta.episodes[0].id).toBe(`estrenoscinesaa:${HOST}episodes/agatha-1x1/`)
  })

  it('getStreams resolves doo_player_ajax embeds with lang from option title', async () => {
    fetchHtml.mockResolvedValue(EPISODE_HTML)
    postHtml
      .mockResolvedValueOnce(JSON.stringify({ embed_url: 'https://filemoon.to/e/abc123', type: 'iframe' }))
      .mockResolvedValueOnce(JSON.stringify({ embed_url: 'https://uqload.vc/e/xyz789', type: 'iframe' }))
    const streams = await cinemitas.getStreams({ id: `cinemitas:${HOST}episodes/agatha-1x1/` })
    expect(streams).toHaveLength(2)
    expect(postHtml).toHaveBeenCalledTimes(2)
    const body = postHtml.mock.calls[0][1]
    expect(body).toContain('action=doo_player_ajax')
    expect(body).toContain('type=tv')
    expect(streams[0].url).toBe('https://filemoon.to/e/abc123')
    expect(streams[0].lang).toBe('ESP')
    expect(streams[1].lang).toBe('LAT')
    expect(streams[0].streamType).toBe('embed')
  })

  it('getStreams unwraps IFRAME-wrapped embed_url and skips trailer', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    postHtml.mockResolvedValue(JSON.stringify({
      embed_url: '<IFRAME SRC="https://uqload.vc/e/kyzz" FRAMEBORDER=0></IFRAME>', type: 'dtshcode'
    }))
    const streams = await estrenoscinesaa.getStreams({ id: `estrenoscinesaa:${HOST}movies/unabomber/` })
    expect(streams).toHaveLength(1) // same embed for both options → dedupe
    expect(streams[0].url).toBe('https://uqload.vc/e/kyzz')
    expect(streams[0].lang).toBe('ESP')
    expect(streams[0].server).toBe('uqload')
  })

  it('returns empty on site failure instead of throwing', async () => {
    fetchHtml.mockResolvedValue('')
    expect(await estrenoscinesaa.getStreams({ id: `estrenoscinesaa:${HOST}movies/x/` })).toEqual([])
    expect(await cinemitas.search({ query: 'x', type: 'movie' })).toEqual([])
  })
})
