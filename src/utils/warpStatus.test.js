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
  },
}))

import { CloudProxy } from './cloudProxy.js'
import { waitForWarp, isWarpConnected, resetWarpReady } from './warpStatus.js'

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
})
