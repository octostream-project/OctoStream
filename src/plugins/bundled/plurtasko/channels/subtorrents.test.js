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

import { fetchHtml } from '../http.js'
import { subtorrents } from './subtorrents.js'

const HOST = 'https://www1.subtorrents.zip/'

const PAD = '<!-- ' + 'x'.repeat(1100) + ' -->'

const SEARCH_HTML = `<html><body>${PAD}<table class="searchResult">
<tr><td class="vertThseccion">
<img src="i.png" title="Idioma"/><a href="https://www1.subtorrents.zip/peliculas/matrix/" title="Matrix">Matrix</a>
</td><td>01-01-1999</td><td> </td><td>BRrip</td></tr>
<tr><td class="vertThseccion">
<img src="i.png" title="Idioma"/><a href="https://www1.subtorrents.zip/series/roots/" title="Roots (Miniserie)">Roots</a>
</td><td>01-01-2016</td><td> </td><td>HDTV</td></tr>
</table></body></html>`

const MOVIE_HTML = `<h1>Matrix</h1>
<a target="_blank" data-src="${btoa('https://www.subtorrents.in/up/m.torrent')}" href="https://www1.subtorrents.zip/up/m.torrent">D</a>`

const SERIE_HTML = `<h1>Roots</h1><table>
<td class="capitulonombre"><img src="f.png"/><a target="_blank" data-src="${btoa('https://www.subtorrents.in/up/roots-1x01.torrent')}" href="s.php?i=x" class="link-torrent-serie linktorrent" title="Roots 1x01 (2016)">Roots</a></td>
<td class="capitulonombre"><img src="f.png"/><a target="_blank" data-src="${btoa('https://www.subtorrents.in/up/roots-1x02.torrent')}" href="s.php?i=x" class="link-torrent-serie linktorrent" title="Roots 1x02 (2016)">Roots</a></td>
</table>`

beforeEach(() => vi.clearAllMocks())

describe('subtorrents channel', () => {
  it('search parses result rows with quality', async () => {
    fetchHtml.mockResolvedValue(SEARCH_HTML)
    const items = await subtorrents.search({ query: 'matrix' })
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('Matrix [BRrip]')
    expect(items[0].title).toBe('Matrix')
    expect(items[1].type).toBe('series')
  })

  it('getStreams returns direct .torrent links from movie pages', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    const streams = await subtorrents.getStreams({ id: `subtorrents:${HOST}peliculas/matrix/` })
    expect(streams).toHaveLength(1)
    expect(streams[0].url).toBe('https://www1.subtorrents.zip/up/m.torrent')
    expect(streams[0].streamType).toBe('torrent')
  })

  it('serie getStreams decodes data-src for the requested episode', async () => {
    fetchHtml.mockResolvedValue(SERIE_HTML)
    const meta = await subtorrents.getMeta({ id: `subtorrents:${HOST}series/roots/` })
    expect(meta.episodes).toHaveLength(2)
    expect(meta.episodes[0].episode).toBe(1)
    const streams = await subtorrents.getStreams({ id: `subtorrents:${HOST}series/roots/`, season: 1, episode: 2 })
    expect(streams[0].url).toBe('https://www1.subtorrents.zip/up/roots-1x02.torrent')
  })
})
