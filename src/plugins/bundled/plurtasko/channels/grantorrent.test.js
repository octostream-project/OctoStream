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
import { grantorrent } from './grantorrent.js'

const HOST = 'https://grantorrent.foo/'

// s.php?i= payload: base64 x4 + rot13 of 'https://grantorrent.foo/f/x.torrent'
function encodeGt(url) {
  let s = url.replace(/[a-zA-Z]/g, c =>
    String.fromCharCode((c <= 'Z' ? 65 : 97) + (c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26))
  for (let i = 0; i < 4; i++) s = btoa(s)
  return `https://super-enlace.com/s.php?i=${s}&st=gtn`
}

const PAD = '<!-- ' + 'x'.repeat(1100) + ' -->'

const SEARCH_HTML = `<html><body>${PAD}
<div class="movie-list">
<div x-data="{ showDetail: true }"><div class="relative my-5 md:my-4">
<a href="https://grantorrent.foo/matrix/"><div x-show="showDetail" class="absolute">
<div class="text-center">
<span>DVDRip</span></div></div>
<img src="https://grantorrent.foo/up/m.jpg" alt="Matrix">
</a><p>x</p></div></div>
<div x-data="{ showDetail: true }"><div class="relative my-5 md:my-4">
<a href="https://grantorrent.foo/series/reacher/"><div>
<img src="https://grantorrent.foo/up/r.jpg" alt="Reacher">
</a><p>x</p></div></div>
</div></section></body></html>`

const MOVIE_HTML = `<h1>Matrix</h1><table>
<tr><td></td><td>HDRip</td><td></td><td>1.45 Gb.</td><td class="ml-auto"><a href="${encodeGt('https://grantorrent.foo/files/torrents/matrix-hdrip.torrent')}">Descargar</a></td></tr>
<tr><td></td><td>4K HDR</td><td></td><td>52 Gb.</td><td class="ml-auto"><a href="${encodeGt('https://grantorrent.foo/files/torrents/matrix-4k.torrent')}">Descargar</a></td></tr>
</table>`

const SERIE_HTML = `<h1>Reacher</h1><table><tbody>
<tr class="episode-1"><td class="px-6 py-4 whitespace-nowrap text-sm text-neutral-300">1x1 </td><td><a href="${encodeGt('https://grantorrent.foo/up/reacher-1x1.torrent')}">D</a></td></tr>
<tr class="episode-2"><td class="px-6 py-4 whitespace-nowrap text-sm text-neutral-300">1x2 </td><td><a href="${encodeGt('https://grantorrent.foo/up/reacher-1x2.torrent')}">D</a></td></tr>
</tbody></table>`

beforeEach(() => vi.clearAllMocks())

describe('grantorrent channel', () => {
  it('search parses cards and exposes base title', async () => {
    fetchHtml.mockResolvedValue(SEARCH_HTML)
    const items = await grantorrent.search({ query: 'matrix' })
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('Matrix [DVDRip]')
    expect(items[0].title).toBe('Matrix')
    expect(items[0].type).toBe('movie')
    expect(items[1].type).toBe('series')
  })

  it('getStreams decodes s.php links into .torrent urls', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    const streams = await grantorrent.getStreams({ id: `grantorrent:${HOST}matrix/` })
    expect(streams).toHaveLength(2)
    expect(streams[0].url).toBe('https://grantorrent.foo/files/torrents/matrix-hdrip.torrent')
    expect(streams[0].streamType).toBe('torrent')
    expect(streams[1].quality).toBe('4K')
  })

  it('serie getStreams picks the exact episode row', async () => {
    fetchHtml.mockResolvedValue(SERIE_HTML)
    const streams = await grantorrent.getStreams({ id: `grantorrent:${HOST}series/reacher/`, season: 1, episode: 2 })
    expect(streams[0].url).toBe('https://grantorrent.foo/up/reacher-1x2.torrent')
    const none = await grantorrent.getStreams({ id: `grantorrent:${HOST}series/reacher/`, season: 1, episode: 9 })
    expect(none).toEqual([])
  })
})
