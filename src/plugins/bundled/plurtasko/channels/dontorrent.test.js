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

import { fetchHtml, postHtml, postJson } from '../http.js'
import { dontorrent } from './dontorrent.js'

const HOST = 'https://dontorrent.supply/'

const SEARCH_HTML = `<html><body>
<!-- padding para superar el umbral de página válida de postToHost (>200 chars) -->
<a href='/pelicula/30971/Beast' class="text-decoration-none"><span class="text-secondary" >Beast</span> [4K]</a>
<a href='/serie/886/888/Breaking-Bad-1-Temporada' class="text-decoration-none">Breaking Bad - 1ª Temporada</a>
</body></html>`

const SERIE_HTML = `
<h2>Breaking Bad - 1ª Temporada</h2>
<meta property="og:image" content="https://img.example/bb.jpg" />
<table><tbody>
<tr><td style='vertical-align: middle;'>1x01</td><td><a class="protected-download" data-content-id="888" data-tabla="series">Descargar</a></td><td>2008-01-20</td></tr>
<tr><td style='vertical-align: middle;'>1x02</td><td><a class="protected-download" data-content-id="978" data-tabla="series">Descargar</a></td><td>2008-01-27</td></tr>
</tbody></table>
`

const MOVIE_HTML = `<h2>Beast</h2><a class="protected-download" data-content-id="30971" data-tabla="peliculas">Descargar</a>`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dontorrent channel', () => {
  it('search parses pelicula and serie results', async () => {
    postHtml.mockResolvedValue(SEARCH_HTML)
    const items = await dontorrent.search({ query: 'breaking bad' })
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe(`dontorrent:${HOST}pelicula/30971/Beast`)
    expect(items[0].type).toBe('movie')
    expect(items[0].name).toBe('Beast [4K]')
    expect(items[1].type).toBe('series')
    expect(items[1].name).toContain('Breaking Bad')
  })

  it('getMeta lists episodes with per-row content ids', async () => {
    fetchHtml.mockResolvedValue(SERIE_HTML)
    const meta = await dontorrent.getMeta({ id: `dontorrent:${HOST}serie/886/888/Breaking-Bad-1-Temporada` })
    expect(meta.name).toBe('Breaking Bad - 1ª Temporada')
    expect(meta.episodes).toHaveLength(2)
    expect(meta.episodes[0].season).toBe(1)
    expect(meta.episodes[0].episode).toBe(1)
    expect(meta.episodes[0].id).toContain('#cid=888')
  })

  it('search exposes base title and season for strict matching', async () => {
    postHtml.mockResolvedValue(SEARCH_HTML)
    const items = await dontorrent.search({ query: 'breaking bad' })
    expect(items[0].title).toBe('Beast')
    expect(items[1].title).toBe('Breaking Bad')
    expect(items[1].season).toBe(1)
  })

  it('getStreams picks the requested episode row on serie pages', async () => {
    fetchHtml.mockResolvedValue(SERIE_HTML)
    postJson.mockImplementation(async (url, body) => {
      if (body.action === 'generate') return { success: true, challenge: 'x', content_id: body.content_id }
      if (body.action === 'validate') return { success: true, download_url: `/t/e${body.nonce === 'x' ? '' : ''}.torrent` }
      return null
    })
    // 1x02 → content-id 978
    const streams = await dontorrent.getStreams({ id: `dontorrent:${HOST}serie/886/888/Breaking-Bad-1-Temporada`, season: 1, episode: 2 })
    expect(postJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ content_id: 978 }), undefined)
    expect(streams).toHaveLength(1)
    // Episodio inexistente → estricto: nada en vez de reproducir otro
    const none = await dontorrent.getStreams({ id: `dontorrent:${HOST}serie/886/888/Breaking-Bad-1-Temporada`, season: 1, episode: 9 })
    expect(none).toEqual([])
  })

  it('getStreams solves the PoW and returns a torrent stream', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    postJson
      .mockResolvedValueOnce({ success: true, challenge: 'aa' }) // generate — 'aa0' sha256 = 9bc7... not 000
      .mockImplementation(async (url, body) => {
        if (body.action === 'generate') return { success: true, challenge: 'x' }
        if (body.action === 'validate') return { success: true, download_url: '//h/torrents/peliculas/Beast.torrent' }
        return null
      })
    const streams = await dontorrent.getStreams({ id: `dontorrent:${HOST}pelicula/30971/Beast` })
    expect(streams).toHaveLength(1)
    expect(streams[0].streamType).toBe('torrent')
    expect(streams[0].url).toBe('https://h/torrents/peliculas/Beast.torrent')
    // Sin pista de idioma en el slug, el stream queda sin etiqueta (nada
    // de asumir 'Esp' — un release latino/vose se marcaría mal).
    expect(streams[0].lang).toBe('')
    expect(streams[0].server).toBe('DonTorrent')
  })

  it('getStreams returns [] when the PoW fails', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    postJson.mockResolvedValue({ success: false })
    const streams = await dontorrent.getStreams({ id: `dontorrent:${HOST}pelicula/30971/Beast` })
    expect(streams).toEqual([])
  })
})
