import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    request: vi.fn(),
    get: vi.fn(),
  },
}))

vi.mock('./platform.js', () => ({
  isAndroidNative: vi.fn(),
}))

vi.mock('./cloudProxy.js', () => ({
  CloudProxy: {
    directFetch: vi.fn(),
  },
}))

vi.mock('./warpStatus.js', () => ({
  waitForWarp: vi.fn(async () => true),
}))

import { CapacitorHttp } from '@capacitor/core'
import { isAndroidNative } from './platform.js'
import {
  httpGetJson,
  httpGetText,
  httpPostJson,
  httpGetBlob,
} from './httpClient.js'
import { CloudProxy } from './cloudProxy.js'
import { waitForWarp } from './warpStatus.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('httpGetJson', () => {
  it('uses standard fetch on web/Electron', async () => {
    isAndroidNative.mockReturnValue(false)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    })

    const data = await httpGetJson('https://api.example.com/data')
    expect(data).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/data', {
      headers: { 'User-Agent': 'OctoStream/1.0' },
      signal: expect.any(AbortSignal), // timeout por defecto
    })
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })

  it('uses CapacitorHttp on Android and parses JSON text', async () => {
    isAndroidNative.mockReturnValue(true)
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: '{"ok":true}' })

    const data = await httpGetJson('https://api.example.com/data')
    expect(data).toEqual({ ok: true })
    expect(CapacitorHttp.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: { 'User-Agent': 'OctoStream/1.0' },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 20000,
      bypassVpn: false,
    })
  })

  it('routes debrid API calls through the VPS forward when vps is set', async () => {
    isAndroidNative.mockReturnValue(true)
    CloudProxy.directFetch.mockResolvedValue({ status: 200, data: '{"ok":true}' })

    const data = await httpGetJson('https://alldebrid.example/api', {}, undefined, false, true, true)

    expect(data).toEqual({ ok: true })
    expect(CloudProxy.directFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://alldebrid.example/api',
      vps: true,
    }))
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })

  it('does not bypass WARP by host for non-TDT traffic to broadcaster domains', async () => {
    isAndroidNative.mockReturnValue(true)
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: '{"ok":true}' })

    await httpGetJson('https://api.rtve.es/data')

    expect(CloudProxy.directFetch).not.toHaveBeenCalled()
    expect(CapacitorHttp.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.rtve.es/data',
      bypassVpn: false,
    }))
  })

  it('uses the physical network only when the caller explicitly requests bypass', async () => {
    isAndroidNative.mockReturnValue(true)
    CloudProxy.directFetch.mockResolvedValue({ status: 200, data: '{"ok":true}' })

    const result = await httpGetJson('https://rtve.es/tdt-feed', {}, undefined, true)

    expect(result).toEqual({ ok: true })
    expect(CloudProxy.directFetch).toHaveBeenCalledOnce()
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })

  it('throws on HTTP error', async () => {
    isAndroidNative.mockReturnValue(false)
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    await expect(httpGetJson('https://api.example.com/data')).rejects.toThrow('HTTP 500')
  })

  it('does not fall back to WebView fetch when native-only is requested', async () => {
    isAndroidNative.mockReturnValue(true)
    CapacitorHttp.request.mockRejectedValue(new Error('native request failed'))
    globalThis.fetch = vi.fn()

    await expect(httpGetJson('https://api.example.com/data', {}, undefined, false, true))
      .rejects.toThrow('native request failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('blocks native requests when WARP autoconnect is enabled but the proxy is down', async () => {
    isAndroidNative.mockReturnValue(true)
    waitForWarp.mockResolvedValueOnce(false)

    await expect(httpGetJson('https://api.example.com/data'))
      .rejects.toMatchObject({ code: 'WARP_NOT_CONNECTED' })
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })
})

describe('httpGetText', () => {
  it('returns text on Android', async () => {
    isAndroidNative.mockReturnValue(true)
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: 'hello', headers: {} })

    const text = await httpGetText('https://example.com/file.txt')
    expect(text).toBe('hello')
  })
})

describe('httpPostJson', () => {
  it('sends JSON body on web/Electron', async () => {
    isAndroidNative.mockReturnValue(false)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 1 }),
    })

    const data = await httpPostJson('https://api.example.com/login', { user: 'x' })
    expect(data).toEqual({ id: 1 })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ user: 'x' }),
      }),
    )
  })

  it('sends object body on Android', async () => {
    isAndroidNative.mockReturnValue(true)
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: { id: 2 } })

    const data = await httpPostJson('https://api.example.com/login', { user: 'x' })
    expect(data).toEqual({ id: 2 })
    expect(CapacitorHttp.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        data: { user: 'x' },
      }),
    )
  })
})

describe('httpGetBlob', () => {
  it('returns blob data on Android', async () => {
    isAndroidNative.mockReturnValue(true)
    const blob = new Blob(['abc'])
    CapacitorHttp.request.mockResolvedValue({ status: 200, data: blob })

    const result = await httpGetBlob('https://example.com/data.gz')
    expect(result).toBe(blob)
  })
})
