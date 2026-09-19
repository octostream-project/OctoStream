import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    request: vi.fn(),
  },
}))

vi.mock('./platform.js', () => ({
  isAndroidNative: vi.fn(),
}))

import { CapacitorHttp } from '@capacitor/core'
import { isAndroidNative } from './platform.js'
import { createAndroidHlsLoader, setManifestBaseUrl } from './hlsAndroidLoader.js'

beforeEach(() => {
  vi.clearAllMocks()
  setManifestBaseUrl(null)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createAndroidHlsLoader', () => {
  it('returns null outside Android native', () => {
    isAndroidNative.mockReturnValue(false)
    expect(createAndroidHlsLoader()).toBeNull()
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })

  it('creates a loader class on Android native', () => {
    isAndroidNative.mockReturnValue(true)
    const Loader = createAndroidHlsLoader()
    expect(Loader).toBeDefined()
    expect(typeof new Loader({ timeout: 10000 }).load).toBe('function')
  })
})

describe('loader.load', () => {
  function makeLoader(config = { timeout: 10000 }) {
    const Loader = createAndroidHlsLoader()
    return new Loader(config)
  }

  function makeCallbacks() {
    return {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onProgress: vi.fn(),
    }
  }

  beforeEach(() => {
    isAndroidNative.mockReturnValue(true)
  })

  it('loads a manifest text response successfully', async () => {
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: '#EXTM3U\n' })
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/playlist.m3u8', type: 'manifest' }, {}, callbacks)

    await vi.runAllTimersAsync()

    expect(CapacitorHttp.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://example.com/playlist.m3u8',
      headers: {},
      responseType: 'text',
      connectTimeout: 10000,
      readTimeout: 10000,
    })
    expect(callbacks.onSuccess).toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('resolves relative segment URLs against the manifest base URL', async () => {
    setManifestBaseUrl('https://cdn.example.com/live/')
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: '#EXTM3U\n' })
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'playlist.m3u8', type: 'manifest' }, {}, callbacks)

    await vi.runAllTimersAsync()

    expect(CapacitorHttp.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://cdn.example.com/live/playlist.m3u8',
      headers: {},
      responseType: 'text',
      connectTimeout: 10000,
      readTimeout: 10000,
    })
  })

  it('decodes base64 arraybuffer responses into an ArrayBuffer', async () => {
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: btoa('segment-data') })
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/segment.ts', type: 'segment' }, {}, callbacks)

    await vi.runAllTimersAsync()

    expect(callbacks.onSuccess).toHaveBeenCalled()
    const payload = callbacks.onSuccess.mock.calls[0][0]
    expect(payload.data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(payload.data).length).toBe(12)
  })

  it('reports HTTP errors through onError', async () => {
    CapacitorHttp.request.mockResolvedValue({ status: 404, data: '' })
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/playlist.m3u8', type: 'manifest' }, {}, callbacks)

    await vi.runAllTimersAsync()

    expect(callbacks.onError).toHaveBeenCalled()
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })

  it('reports base64 decode errors', async () => {
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: '%%%invalid-base64%%%' })
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/segment.ts', type: 'segment' }, {}, callbacks)

    await vi.runAllTimersAsync()

    expect(callbacks.onError).toHaveBeenCalled()
  })

  it('times out long requests', async () => {
    CapacitorHttp.request.mockImplementation(() => new Promise(() => {}))
    const loader = makeLoader({ timeout: 5000 })
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/playlist.m3u8', type: 'manifest' }, {}, callbacks)

    await vi.advanceTimersByTimeAsync(5000)

    expect(callbacks.onError).toHaveBeenCalled()
    const error = callbacks.onError.mock.calls[0][0]
    expect(error.details.text).toBe('Request timeout')
  })

  it('aborts in-flight requests cleanly', async () => {
    const loader = makeLoader()
    const callbacks = makeCallbacks()

    loader.load({ url: 'https://example.com/playlist.m3u8', type: 'manifest' }, {}, callbacks)
    loader.abort()

    await vi.runAllTimersAsync()

    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})
