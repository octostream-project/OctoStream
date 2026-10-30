import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./platform.js', () => ({
  isAndroidNative: () => true,
  isElectron: () => false,
}))

vi.mock('./cloudProxy.js', () => ({
  CloudProxy: {
    getStatus: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    directFetch: vi.fn(),
  },
}))

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: vi.fn(),
  },
}))

import { CloudProxy } from './cloudProxy.js'
import { CapacitorHttp } from '@capacitor/core'
import { waitForWarp, isWarpConnected, resetWarpReady, checkIpLeak } from './warpStatus.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let up = false

beforeEach(() => {
  vi.clearAllMocks()
  up = false
  resetWarpReady()
  CloudProxy.getStatus.mockImplementation(async () => ({ connected: up, connecting: false }))
  CloudProxy.connect.mockImplementation(async () => {
    await sleep(50)
    up = true
    return { status: 'connected' }
  })
})

describe('warpStatus', () => {
  it('la auto-reconexión es single-flight entre waiters concurrentes', async () => {
    const results = await Promise.all([
      waitForWarp(3000),
      waitForWarp(3000),
      waitForWarp(3000),
    ])
    expect(results).toEqual([true, true, true])
    expect(CloudProxy.connect).toHaveBeenCalledTimes(1)
    expect(isWarpConnected()).toBe(true)
  })

  it('resuelve rápido si WARP ya está conectado', async () => {
    up = true
    expect(await waitForWarp(100)).toBe(true)
    expect(CloudProxy.connect).not.toHaveBeenCalled()
  })

  it('la prueba de fugas acepta JSON ya parseado por CapacitorHttp', async () => {
    CapacitorHttp.get.mockResolvedValue({ data: { ip: '187.7.203.116' } })
    CloudProxy.directFetch.mockResolvedValue({ data: '{"ip":"80.10.20.30"}' })

    const result = await checkIpLeak()

    expect(result.tunnel.ip).toBe('187.7.203.116')
    expect(result.direct.ip).toBe('80.10.20.30')
  })
})
