import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../http.js', async () => {
  const actual = await vi.importActual('../http.js')
  return { ...actual, fetchHtml: vi.fn() }
})

import { fetchHtml } from '../http.js'
import { bloghorror } from './bloghorror.js'

const PAD = '<!-- ' + 'x'.repeat(1100) + ' -->'

const CARD = (url, title, img) => `<article class="post">
<div class="data-bg" data-background="${img}"><a href="${url}"></a></div>
<h3 class="article-title article-title-1"><a href="${url}" data-wpel-link="internal">
${title}</a></h3></article>`

const CATALOG_HTML = `<html><body>${PAD}
${CARD('https://bloghorror.com/2025/08/movie-one-2025.html', 'Movie One (2025)', 'https://bloghorror.com/wp/one.jpg')}
${CARD('https://bloghorror.com/2025/08/movie-two-2024.html', 'Movie Two (2024)', 'https://bloghorror.com/wp/two.jpg')}
</body></html>`

const MOVIE_HTML = `<html><body>${PAD}
<h1 class="entry-title">Movie One (2025)</h1>
<meta property="og:image" content="https://bloghorror.com/wp/one.jpg" />
<p>FICHA TECNICA decorativa de un widget</p>
<p style="text-align: center;"><span>FICHA TECNICA:</span><span><br /> Calidad</span>: 1080<span><br /> Audio</span>: Ingles<em><br />
<a href="magnet:?xt=urn:btih:ABC123&amp;dn=Movie+One+1080p&amp;tr=udp%3A%2F%2Ft">MF</a><br />
<a href="https://www.subdivx.com/693857">SUBTITULOS</a><br />
<a href="https://m.ok.ru/video/12345">ok</a><br />
<a href="https://ok.ru/group/9/topic/111">grupo ok</a><br />
<a href="https://megaup.net/abc/Movie.One.mkv">mkv</a><br />
<a href="https://bloghorror.com/otra-pagina.html">interno</a><br />
</em></p>
</body></html>`

beforeEach(() => vi.clearAllMocks())

describe('bloghorror channel', () => {
  it('catalog parses article cards', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    const items = await bloghorror.getCatalog({ id: 'bloghorror-terror' })
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('bloghorror:https://bloghorror.com/2025/08/movie-one-2025.html')
    expect(items[0].type).toBe('movie')
    expect(items[0].year).toBe(2025)
    expect(items[0].poster).toBe('https://bloghorror.com/wp/one.jpg')
  })

  it('getStreams keeps magnets and video hosts, skips junk', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    const streams = await bloghorror.getStreams({ id: 'bloghorror:https://bloghorror.com/2025/08/movie-one-2025.html' })
    const urls = streams.map(s => String(s.url))
    expect(urls.some(u => u.startsWith('magnet:'))).toBe(true)
    expect(streams.find(s => String(s.url).startsWith('magnet:'))?.quality).toBe('1080P')
    expect(urls).toContain('https://ok.ru/video/12345')
    expect(urls).toContain('https://megaup.net/abc/Movie.One.mkv')
    expect(urls.some(u => /subdivx|ok\.ru\/group|bloghorror\.com/.test(u))).toBe(false)
  })

  it('search returns movie items', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    const items = await bloghorror.search({ query: 'movie', type: 'movie' })
    expect(items).toHaveLength(2)
    expect(items[1].name).toBe('Movie Two (2024)')
  })

  it('search skips non-movie types', async () => {
    const items = await bloghorror.search({ query: 'movie', type: 'series' })
    expect(items).toHaveLength(0)
    expect(fetchHtml).not.toHaveBeenCalled()
  })

  it('getMeta picks title, year, poster and ficha fields', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    const meta = await bloghorror.getMeta({ id: 'bloghorror:https://bloghorror.com/2025/08/movie-one-2025.html' })
    expect(meta.name).toBe('Movie One (2025)')
    expect(meta.year).toBe(2025)
    expect(meta.poster).toBe('https://bloghorror.com/wp/one.jpg')
    expect(meta.extra.quality).toBe('1080')
    expect(meta.extra.audio).toBe('Ingles')
  })
})
