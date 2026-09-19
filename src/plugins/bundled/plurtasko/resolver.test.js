import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./http.js', () => ({
  fetchHtml: vi.fn().mockResolvedValue(''),
  postHtml: vi.fn().mockResolvedValue(''),
  postJson: vi.fn().mockResolvedValue(null),
}))

const { fetchHtml, postJson } = await import('./http.js')
const { resolveEmbed, isResolvable, listResolvers, DEAD_LINK } = await import('./resolver.js')

beforeEach(() => {
  vi.clearAllMocks()
  fetchHtml.mockResolvedValue('')
  postJson.mockResolvedValue(null)
})

describe('resolver domain coverage', () => {
  it('matches new host domains to a resolver', () => {
    for (const url of [
      'https://dood.re/e/abc123',
      'https://playmogo.com/e/abc123',
      'https://vidhidepro.com/v/abc123',
      'https://vidhidefast.com/e/abc123',
      'https://emturbovid.com/t/abc123',
      'https://bysefujedu.com/e/abc123',
      'https://vidara.to/e/abc123',
      'https://vidsonic.net/e/abc123',
      'https://streamplay.to/embed-abc123.html',
      'https://powvideo.org/embed-abc123.html',
      'https://vudeo.io/embed-abc123.html',
      'https://wolfstream.tv/e/abc123',
      'https://vgembed.com/e/abc123',
    ]) {
      expect(isResolvable(url), url).toBe(true)
    }
  })

  it('lists the new resolvers', () => {
    const names = listResolvers()
    for (const name of ['vidara', 'vidsonic', 'streamplay', 'powvideo', 'vudeo', 'wolfstream', 'vidguard']) {
      expect(names).toContain(name)
    }
  })
})

describe('vidara resolver', () => {
  it('posts to /api/stream and returns streaming_url', async () => {
    postJson.mockResolvedValue({
      streaming_url: 'https://cdn.example.com/hls/master.m3u8?token=abc',
    })
    const out = await resolveEmbed('https://vidara.to/e/0b0ee7cf268c')
    expect(postJson).toHaveBeenCalledWith(
      'https://vidara.to/api/stream',
      { filecode: '0b0ee7cf268c', device: 'web' },
      expect.anything(),
      expect.objectContaining({ Referer: 'https://vidara.to/e/0b0ee7cf268c' }),
    )
    expect(out).toBe('https://cdn.example.com/hls/master.m3u8?token=abc')
  })
})

describe('vidsonic resolver', () => {
  it('decodes the hex-pipe reversed URL', async () => {
    // 'https://x.test/v.mp4' → reverse → hex pairs joined with |
    const url = 'https://cdn.example.com/v/abc.mp4'
    const reversed = url.split('').reverse().join('')
    const hex = reversed.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('|')
    fetchHtml.mockResolvedValue(`<script>const _0x1 = '${hex}';</script>`)
    const out = await resolveEmbed('https://vidsonic.net/e/aSqOEMhmdaJ7')
    expect(out).toBe(url)
  })
})

describe('voe application/json decode', () => {
  // Encode a config object through the inverse of the VOE pipeline:
  // JSON → btoa → reverse → shift+3 → btoa → insert junk pairs → rot13
  const encodeVoe = (obj) => {
    const b64_1 = btoa(JSON.stringify(obj))
    const shifted = [...b64_1.split('').reverse().join('')]
      .map(c => String.fromCharCode(c.charCodeAt(0) + 3)).join('')
    let junked = btoa(shifted)
    const junk = ['@$', '^^', '~@', '%?', '*~', '!!', '#&']
    junked = junked.replace(/(.{5})/g, (m, g, i) => g + junk[i % junk.length])
    const rot13 = [...junked].map(c => {
      const x = c.charCodeAt(0)
      if (x >= 65 && x <= 90) return String.fromCharCode((x - 65 + 13) % 26 + 65)
      if (x >= 97 && x <= 122) return String.fromCharCode((x - 97 + 13) % 26 + 97)
      return c
    }).join('')
    return `<script type="application/json">["${rot13}"]</script>`
  }

  it('decodes the new array-format payload', async () => {
    const { extractVoeSourceFromHtml } = await import('./resolver.js')
    const html = encodeVoe({ source: 'https://cdn.x.com/v/master.m3u8?t=abc', file_code: 'xyz' })
    expect(extractVoeSourceFromHtml(html)).toBe('https://cdn.x.com/v/master.m3u8?t=abc')
  })

  it('falls back to direct_access_url when source is missing', async () => {
    const { extractVoeSourceFromHtml } = await import('./resolver.js')
    const html = encodeVoe({ direct_access_url: 'https://cdn.x.com/v/dl.mp4', file_code: 'xyz' })
    expect(extractVoeSourceFromHtml(html)).toBe('https://cdn.x.com/v/dl.mp4')
  })
})

describe('packed-js generic hosts', () => {
  it('extracts sources from streamplay page', async () => {
    fetchHtml.mockResolvedValue('<script>sources:[{file:"https://cdn.x.com/a/master.m3u8"}]</script>')
    const out = await resolveEmbed('https://streamplay.to/embed-abc123.html')
    expect(out).toBe('https://cdn.x.com/a/master.m3u8')
  })

  it('returns DEAD_LINK for 404/dead pages', async () => {
    fetchHtml.mockResolvedValue('<html><title>404 Not Found</title></html>')
    const out = await resolveEmbed('https://powvideo.org/embed-dead.html')
    expect(out).toBe(DEAD_LINK)
  })

  it('uqload: decodes packed jwplayer setup to the m3u8 file', async () => {
    // p.a.c.k.e.r block: 0→'v', 1→'"<m3u8 url>"' decodes to
    // jwplayer(v).setup({sources:[{file:"https://cdn.test/v.m3u8"}]})
    fetchHtml.mockResolvedValue(
      `<script>eval(function(p,a,c,k,e,d){}('jwplayer(0).setup({sources:[{file:1}]})',10,2,'v|"https://cdn.test/v.m3u8"'.split('|'),0,{}))</script>`,
    )
    const out = await resolveEmbed('https://uqload.is/embed-abc123.html')
    expect(out).toBe('https://cdn.test/v.m3u8')
  })
})
