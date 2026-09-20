import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
const t0 = () => calls.length

vi.mock('../plugins/manager.js', () => ({
  pluginManager: {
    ensureReady: vi.fn(async () => {}),
    getCatalogContent: vi.fn(async (pluginId, catalogId) => {
      calls.push(`${pluginId}:${catalogId}`)
      return []
    }),
  },
}))
vi.mock('./warpStatus.js', () => ({ waitForWarp: vi.fn(async () => { calls.push('warp'); return true }) }))
vi.mock('./logger.js', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../plugins/bundled/fctv/index.js', () => ({
  fctvWarmupSitemap: vi.fn(async () => { calls.push('fctv:sitemap'); return true }),
}))
vi.mock('./sofascore.js', () => ({
  fetchLeagueEvents: vi.fn(async () => { calls.push('sofa:events'); return [] }),
  tournamentImg: vi.fn(() => ''),
}))
vi.mock('../data/sportsLeagues.js', () => ({
  MARCA_TO_SOFA: {},
  CAL_LEAGUES: [{ slug: 'laliga', name: 'LaLiga EA Sports', utId: 1, jornadas: [] }],
}))

const importPlan = () => import('./loadPlan.js')

describe('loadPlan', () => {
  beforeEach(() => {
    calls.length = 0
    vi.resetModules()
  })

  it('loads in order: TMDB → anime → sports (DLive first within sports)', async () => {
    const { startLoadPlan } = await importPlan()
    await startLoadPlan()

    const firstCall = (pfx) => calls.findIndex(c => c.startsWith(pfx))
    const lastCall = (pfx) => calls.map((c, i) => c.startsWith(pfx) ? i : -1).reduce((a, b) => Math.max(a, b), -1)

    expect(firstCall('warp')).toBe(0) // WARP gate antes de cualquier tráfico
    expect(calls.filter(c => c.startsWith('tmdb:')).length).toBeGreaterThan(0)
    expect(calls.filter(c => c.startsWith('anilist:')).length).toBeGreaterThan(0)
    expect(firstCall('dlive:')).toBeGreaterThan(-1)

    // Todas las llamadas TMDB antes que la primera de anime; todas las de
    // anime antes que la primera de deportes.
    expect(firstCall('anilist:')).toBeGreaterThan(lastCall('tmdb:'))
    expect(firstCall('dlive:')).toBeGreaterThan(lastCall('anilist:'))

    // Dentro de deportes, DLive siempre primero (antes que FCTV y Sofascore).
    expect(firstCall('dlive:')).toBeLessThan(firstCall('fctv:'))
    expect(firstCall('dlive:')).toBeLessThan(firstCall('sofa:'))
  })

  it('warms the shared DLive schedule via dlive-live', async () => {
    const { startLoadPlan } = await importPlan()
    await startLoadPlan()
    expect(calls).toContain('dlive:dlive-live')
    expect(calls).toContain('fctv:fctv-football')
    expect(calls).toContain('fctv:sitemap')
    expect(calls).toContain('sofa:events')
  })

  it('dedupes concurrent runs and skips re-runs inside the TTL', async () => {
    const { startLoadPlan } = await importPlan()
    const a = startLoadPlan()
    const b = startLoadPlan()
    expect(a).toBe(b) // misma promesa en curso
    await a
    const n = calls.length
    await startLoadPlan() // dentro del TTL → no repite
    expect(calls.length).toBe(n)
  })
})
