import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../http.js', async () => {
  const actual = await vi.importActual('../http.js')
  return {
    ...actual,
    fetchHtml: vi.fn(),
    postHtml: vi.fn(),
  }
})

import { fetchHtml } from '../http.js'
import { gnulatv } from './gnulatv.js'

const HOST = 'https://ww3.gnulahd.nu/'

// Inverso del gnrdUnpack del site: JSON → XOR [103,78,55,100] → base64
function gnrdPack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  const k = [103, 78, 55, 100]
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ^ k[i & 3])
  return btoa(bin)
}

const CATALOG_HTML = `<html><body>
<a class="gnrd-card" href="${HOST}ver/la-isla-olvidada/" title="La isla olvidada">
  <div class="gnrd-card-img"><img src="${HOST}wp-content/uploads/poster1.jpg" alt="La isla olvidada"></div>
  <div class="gnrd-card-body"><span class="gnrd-lang">LAT</span><span class="gnrd-card-title">La isla olvidada</span></div>
</a>
<a class="gnrd-card" href="${HOST}ver/tony/" title="Tony">
  <div class="gnrd-card-img"><img src="${HOST}wp-content/uploads/poster2.jpg" alt="Tony"></div>
  <div class="gnrd-card-body"><span class="gnrd-lang">SUB</span><span class="gnrd-card-title">Tony</span></div>
</a>
</body></html>`

const MOVIE_HTML = `<html><head>
<meta property="og:image" content="https://i2.wp.com/ww3.gnulahd.nu/wp-content/uploads/beast.jpg" />
<meta name="description" content="Tras un terrible accidente aéreo, el oficial queda varado en Alaska." />
</head><body>
<h1><img class="gnrd-fi-logo" src="logo.png" alt="Bestia"><span class="gnrd-sr">El corazón de la bestia</span></h1>
<script>var _gnrdPid=218067; var _gnrdTok="abc123tok";</script>
</body></html>`

const SERIES_HTML = `<html><head>
<meta property="og:image" content="${HOST}img/silo.jpg" />
<meta name="description" content="Un silo gigante bajo tierra." />
</head><body>
<h1><span class="gnrd-sr">Silo</span></h1>
<a class="gnrd-epc" href="${HOST}silo-3x10/" data-id="215749" data-t="tok310" data-s="3" data-e="10">
  <div class="gnrd-epc-body"><span class="gnrd-epc-n">3x10</span><span class="gnrd-epc-title">Troy</span>
  <p class="gnrd-epc-ov">Un líder despierta en un nuevo mundo.</p></div>
</a>
<a class="gnrd-epc" href="${HOST}silo-3x09/" data-id="213888" data-t="tok309" data-s="3" data-e="9">
  <div class="gnrd-epc-body"><span class="gnrd-epc-n">3x09</span><span class="gnrd-epc-title">La escalera</span></div>
</a>
</body></html>`

const PLAYER_JSON = {
  t: 'El corazón de la bestia',
  langs: [
    { label: 'Subtitulado', flag: 'US', servers: [
      { title: 'Servidor 1', src: 'https://vidara.to/e/SOmeYCJ015EjU' },
      { title: 'Servidor 2', src: 'https://voe.sx/e/fvsxd85jpupn' },
    ] },
    { label: 'Latino', flag: 'MX', servers: [
      { title: 'Servidor 1', src: 'https://filemoon.sx/e/xyz123' },
    ] },
  ],
  dl: [
    { name: '1fichier', lang: 'subtitulado', qual: '1080p', url: 'https://1fichier.com/?15m4pmp4' },
    { name: 'gofile', lang: 'subtitulado', qual: 'cam', url: 'https://gofile.io/d/F7p3CeFr' },
  ],
}

function mockPlayerApi(payload) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ p: gnrdPack(payload) }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('gnulatv channel', () => {
  it('getCatalog parses gnrd-card anchors', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    const items = await gnulatv.getCatalog({ id: 'gnulatv-movies' })
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe(`gnulatv:${HOST}ver/la-isla-olvidada/`)
    expect(items[0].name).toBe('La isla olvidada')
    expect(items[0].type).toBe('movie')
    expect(items[0].poster).toContain('poster1.jpg')
    expect(fetchHtml).toHaveBeenCalledWith(`${HOST}ver/peliculas/?page=1`)
  })

  it('getCatalog series uses the series path', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    await gnulatv.getCatalog({ id: 'gnulatv-series' })
    expect(fetchHtml).toHaveBeenCalledWith(`${HOST}ver/series/?page=1`)
  })

  it('getMeta movie extracts title, poster and description', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    const meta = await gnulatv.getMeta({ id: `gnulatv:${HOST}ver/bestia/` })
    expect(meta.type).toBe('movie')
    expect(meta.name).toBe('El corazón de la bestia')
    expect(meta.poster).toContain('beast.jpg')
    expect(meta.description).toContain('accidente aéreo')
    expect(meta.episodes).toBeUndefined()
  })

  it('getMeta series lists episodes with pid+token ids', async () => {
    fetchHtml.mockResolvedValue(SERIES_HTML)
    const meta = await gnulatv.getMeta({ id: `gnulatv:${HOST}ver/silo/` })
    expect(meta.type).toBe('series')
    expect(meta.episodes).toHaveLength(2)
    // Ordenados por episodio (9 antes que 10)
    expect(meta.episodes[0].episode).toBe(9)
    expect(meta.episodes[0].id).toBe('gnulatv:ep:213888:tok309')
    expect(meta.episodes[1].name).toBe('Troy')
    expect(meta.episodes[1].overview).toContain('nuevo mundo')
  })

  it('getStreams movie decodes the XOR player payload per language', async () => {
    fetchHtml.mockResolvedValue(MOVIE_HTML)
    mockPlayerApi(PLAYER_JSON)
    const streams = await gnulatv.getStreams({ id: `gnulatv:${HOST}ver/bestia/`, debridEnabled: false })
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('player?id=218067&t=abc123tok'),
      expect.anything(),
    )
    // Solo embeds (dl filtrado sin debrid)
    expect(streams).toHaveLength(3)
    const vose = streams.filter(s => s.lang === 'VOSE')
    const lat = streams.filter(s => s.lang === 'Lat')
    expect(vose.map(s => s.server).sort()).toEqual(['vidara', 'voe'])
    expect(lat[0].server).toBe('filemoon')
    expect(streams.every(s => s.streamType === 'embed')).toBe(true)
  })

  it('getStreams episode resolves by pid+token without fetching the page', async () => {
    mockPlayerApi(PLAYER_JSON)
    const streams = await gnulatv.getStreams({ id: 'gnulatv:ep:215749:tok310', debridEnabled: true })
    expect(fetchHtml).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('player?id=215749&t=tok310'),
      expect.anything(),
    )
    // Con debrid: 3 embeds + 1fichier (gofile no está soportado por AllDebrid)
    expect(streams).toHaveLength(4)
    const dl = streams.find(s => s.server === '1fichier')
    expect(dl.lang).toBe('VOSE')
    expect(dl.quality).toBe('1080P')
  })

  it('search returns cards from ?s= results', async () => {
    fetchHtml.mockResolvedValue(CATALOG_HTML)
    const items = await gnulatv.search({ query: 'isla' })
    expect(fetchHtml).toHaveBeenCalledWith(`${HOST}?s=isla`)
    expect(items).toHaveLength(2)
  })
})
