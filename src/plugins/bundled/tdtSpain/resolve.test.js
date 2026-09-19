import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLiveStream } from './resolve.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('resolveLiveStream', () => {
  it('resolves protocol-relative HLS URLs returned by geturl providers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ m3u8: '//cdn.example.com/live/playlist.m3u8' }),
    })
    const headers = { Origin: 'https://provider.example', Referer: 'https://provider.example/' }

    const stream = await resolveLiveStream({
      streamtype: 'geturl',
      url: 'https://provider.example/player/1',
      headers,
    }, {})

    expect(stream).toEqual(expect.objectContaining({
      url: 'https://cdn.example.com/live/playlist.m3u8',
      streamType: 'hls',
      headers,
    }))
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://provider.example/player/1',
      expect.objectContaining({ headers: expect.objectContaining(headers) }),
    )
  })

  it('rejects non-HTTP direct stream URLs', async () => {
    await expect(resolveLiveStream({ streamtype: 'hls', url: 'file:///etc/passwd' }, {})).resolves.toBeNull()
  })
})
