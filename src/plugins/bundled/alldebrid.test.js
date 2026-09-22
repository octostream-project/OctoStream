import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

localStorage.setItem('octostream_alldebrid_key', 'testkey')

import { unlockLink, resolveMagnet } from './alldebrid.js'

const okJson = (data) => ({ ok: true, json: async () => ({ status: 'success', data }) })

function mockApi(handlers = {}) {
  return vi.fn(async (url) => {
    const u = String(url)
    for (const [frag, fn] of Object.entries(handlers)) {
      if (u.includes(frag)) {
        const out = typeof fn === 'function' ? fn(u) : fn
        return okJson(out)
      }
    }
    return okJson({})
  })
}

describe('alldebrid unlockLink', () => {
  let saved
  beforeEach(() => { saved = global.fetch })
  afterEach(() => { global.fetch = saved; vi.restoreAllMocks() })

  it('dedups concurrent unlocks of the same URL', async () => {
    global.fetch = mockApi({
      '/link/unlock': { link: 'https://cdn.example.com/dedup1.mp4', filename: 'v.mp4' },
    })
    const [a, b] = await Promise.all([
      unlockLink('https://1fichier.com/?aaa'),
      unlockLink('https://1fichier.com/?aaa'),
    ])
    expect(a.link).toBe('https://cdn.example.com/dedup1.mp4')
    expect(b.link).toBe('https://cdn.example.com/dedup1.mp4')
    expect(global.fetch.mock.calls.filter(c => String(c[0]).includes('/link/unlock'))).toHaveLength(1)
  })

  it('serves cached result within TTL without new API call', async () => {
    global.fetch = mockApi({
      '/link/unlock': { link: 'https://cdn.example.com/cached1.mp4' },
    })
    await unlockLink('https://1fichier.com/?bbb')
    const again = await unlockLink('https://1fichier.com/?bbb')
    expect(again.link).toBe('https://cdn.example.com/cached1.mp4')
    expect(global.fetch.mock.calls.filter(c => String(c[0]).includes('/link/unlock'))).toHaveLength(1)
  })

  it('does not cache failures', async () => {
    let n = 0
    global.fetch = mockApi({
      '/link/unlock': () => { n++; return { link: null } },
    })
    await unlockLink('https://1fichier.com/?ccc')
    await unlockLink('https://1fichier.com/?ccc')
    expect(n).toBe(2)
  })

  it('waits on delayed links until ready', async () => {
    let delayedCalls = 0
    global.fetch = mockApi({
      '/link/unlock': { delayed: 777 },
      '/link/delayed': () => {
        delayedCalls++
        return delayedCalls >= 2
          ? { status: 2, link: 'https://cdn.example.com/delayed.mp4' }
          : { status: 1 }
      },
    })
    const res = await unlockLink('https://1fichier.com/?ddd')
    expect(res.link).toBe('https://cdn.example.com/delayed.mp4')
    expect(delayedCalls).toBe(2)
  })
})

describe('alldebrid resolveMagnet', () => {
  let saved
  beforeEach(() => { saved = global.fetch })
  afterEach(() => { global.fetch = saved; vi.restoreAllMocks() })

  const magnetHandlers = (statusData) => ({
    '/magnet/upload': { magnets: [{ id: 42, ready: true }] },
    '/magnet/status': statusData,
    '/link/unlock': (u) => {
      const link = new URL(u).searchParams.get('link')
      return { link: `https://cdn.example.com/${encodeURIComponent(link)}` }
    },
    '/magnet/delete': {},
  })

  it('uploads, polls and unlocks picked links in parallel', async () => {
    // Sin archivos de vídeo claros, pickTorrentEntries devuelve null y se
    // desbloquean todos los links — en paralelo. Formato v4.1: árbol `files`.
    global.fetch = mockApi(magnetHandlers({
      magnets: [{
        statusCode: 4,
        files: [
          { n: 'a.bin', s: 1, l: 'https://alldebrid.com/f/one' },
          { n: 'sub', e: [{ n: 'b.bin', s: 1, l: 'https://alldebrid.com/f/two' }] },
        ],
        filename: 'pack',
      }],
    }))
    const links = await resolveMagnet('magnet:?xt=urn:btih:aaaa', 10000)
    expect(links).toHaveLength(2)
    expect(links[0]).toContain('one')
    expect(links[1]).toContain('two')
    const calls = global.fetch.mock.calls.map(c => String(c[0]))
    expect(calls.filter(u => u.includes('/magnet/upload'))).toHaveLength(1)
    expect(calls.filter(u => u.includes('/magnet/status'))).toHaveLength(1)
    expect(calls.filter(u => u.includes('/link/unlock'))).toHaveLength(2)
    expect(calls.filter(u => u.includes('/magnet/delete'))).toHaveLength(1)
  })

  it('picks only the matching episode file in season packs', async () => {
    global.fetch = mockApi(magnetHandlers({
      magnets: [{
        statusCode: 4,
        files: [
          { n: 'Show.S01E01.mkv', s: 100, l: 'https://alldebrid.com/f/e1' },
          { n: 'Show.S01E03.mkv', s: 100, l: 'https://alldebrid.com/f/e3' },
        ],
      }],
    }))
    const links = await resolveMagnet('magnet:?xt=urn:btih:eeee', 10000, { season: 1, episode: 3 })
    expect(links).toHaveLength(1)
    expect(links[0]).toContain('e3')
    expect(global.fetch.mock.calls.filter(c => String(c[0]).includes('/link/unlock'))).toHaveLength(1)
  })

  it('handles single-magnet object response (v4.1 with id)', async () => {
    // Con `id` la API real devuelve magnets como objeto, no array.
    global.fetch = mockApi({
      '/magnet/upload': { magnets: [{ id: 43 }] },
      '/magnet/status': {
        magnets: { statusCode: 4, files: [{ n: 'z.mkv', s: 1, l: 'https://alldebrid.com/f/z' }] },
      },
      '/link/unlock': () => ({ link: 'https://cdn.example.com/z.mp4' }),
      '/magnet/delete': {},
    })
    const links = await resolveMagnet('magnet:?xt=urn:btih:dddd', 10000)
    expect(links).toEqual(['https://cdn.example.com/z.mp4'])
  })

  it('dedups concurrent resolutions of the same magnet', async () => {
    global.fetch = mockApi(magnetHandlers({
      magnets: [{ statusCode: 4, files: [{ n: 'x.mkv', s: 1, l: 'https://alldebrid.com/f/x' }] }],
    }))
    const [a, b] = await Promise.all([
      resolveMagnet('magnet:?xt=urn:btih:bbbb', 10000),
      resolveMagnet('magnet:?xt=urn:btih:bbbb', 10000),
    ])
    expect(a).toEqual(b)
    const uploads = global.fetch.mock.calls.filter(c => String(c[0]).includes('/magnet/upload'))
    expect(uploads).toHaveLength(1)
  })

  it('caches resolved links for picker re-opens', async () => {
    global.fetch = mockApi(magnetHandlers({
      magnets: [{ statusCode: 4, files: [{ n: 'y.mkv', s: 1, l: 'https://alldebrid.com/f/y' }] }],
    }))
    await resolveMagnet('magnet:?xt=urn:btih:cccc', 10000)
    const again = await resolveMagnet('magnet:?xt=urn:btih:cccc', 10000)
    expect(again).toHaveLength(1)
    const uploads = global.fetch.mock.calls.filter(c => String(c[0]).includes('/magnet/upload'))
    expect(uploads).toHaveLength(1)
  })
})
