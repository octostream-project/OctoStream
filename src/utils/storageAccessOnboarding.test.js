import { describe, expect, it, vi } from 'vitest'
import { promptStorageAccessOnce } from './storageAccessOnboarding.js'

function setup(code = 2094, granted = false) {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, val) => values.set(key, val),
  }
  const engine = {
    getStorageAccess: vi.fn().mockResolvedValue({ granted }),
    requestStorageAccess: vi.fn().mockResolvedValue({ opened: true }),
  }
  return { storage, engine, getVersion: vi.fn().mockResolvedValue({ versionCode: code }),
    getEngine: vi.fn().mockResolvedValue(engine) }
}

describe('startup storage access', () => {
  it('opens Settings once on first launch of the installed update', async () => {
    const args = setup()
    expect(await promptStorageAccessOnce(args)).toBe('opened')
    expect(await promptStorageAccessOnce(args)).toBe('already-prompted')
    expect(args.engine.requestStorageAccess).toHaveBeenCalledTimes(1)
    args.getVersion.mockResolvedValue({ versionCode: 2095 })
    expect(await promptStorageAccessOnce(args)).toBe('opened')
  })

  it('does not prompt when permission is already granted or the APK is older', async () => {
    const granted = setup(2094, true)
    expect(await promptStorageAccessOnce(granted)).toBe('granted')
    expect(granted.engine.requestStorageAccess).not.toHaveBeenCalled()
    const older = setup(2093)
    expect(await promptStorageAccessOnce(older)).toBe('unsupported')
    expect(older.getEngine).not.toHaveBeenCalled()
  })

  it('retries a failed status check on next launch', async () => {
    const args = setup()
    args.engine.getStorageAccess.mockRejectedValueOnce(new Error('bridge unavailable'))
    await expect(promptStorageAccessOnce(args)).rejects.toThrow('bridge unavailable')
    expect(await promptStorageAccessOnce(args)).toBe('opened')
  })
})
