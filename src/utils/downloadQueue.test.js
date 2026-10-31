import { describe, expect, it, vi } from 'vitest'
import { createDownloadQueue } from './downloadQueue.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function mockEngine() {
  let progressListener
  return {
    addListener: vi.fn(async (_name, listener) => {
      progressListener = listener
      return { remove: vi.fn() }
    }),
    download: vi.fn(async () => ({ complete: false })),
    downloadHttp: vi.fn(async () => ({ complete: false })),
    stop: vi.fn(async () => ({})),
    emit: (event) => progressListener?.(event),
  }
}

describe('download queue', () => {
  it('runs one job at a time until the active engine reports completion', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const first = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:first' }))
    const second = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:second' }))

    queue.enqueue({ name: 'first', kind: 'torrent', start: first })
    queue.enqueue({ name: 'second', kind: 'torrent', start: second })
    await tick()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    engine.emit({ state: 'finished', progress: 1, fileName: 'first.mkv' })
    await tick()
    expect(second).toHaveBeenCalledTimes(1)
    queue.destroy()
  })

  it('waits for playback reservations before starting queued work', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const reservation = queue.reserveForPlayback()
    const start = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:waiting' }))

    queue.enqueue({ name: 'waiting', kind: 'torrent', start })
    await tick()
    expect(start).not.toHaveBeenCalled()

    reservation.release()
    await tick()
    expect(start).toHaveBeenCalledTimes(1)
    queue.destroy()
  })

  it('allows reordering queued jobs without starting a second engine task', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const reservation = queue.reserveForPlayback()
    const first = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:first' }))
    const second = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:second' }))
    queue.enqueue({ name: 'first', kind: 'torrent', start: first })
    const secondId = queue.enqueue({ name: 'second', kind: 'torrent', start: second })

    expect(queue.moveQueued(secondId, -1)).toBe(true)
    reservation.release()
    await tick()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    engine.emit({ state: 'finished', progress: 1 })
    await tick()
    expect(first).toHaveBeenCalledTimes(1)
    queue.destroy()
  })

  it('stops and requeues an active torrent when playback takes priority', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const start = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:resume' }))
    const id = queue.enqueue({ name: 'resume', kind: 'torrent', start })
    await tick()

    const reservation = queue.reserveForPlayback()
    await reservation.ready
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(queue.getSnapshot().find(job => job.id === id)?.status).toBe('queued')
    reservation.release()
    await tick()
    expect(start).toHaveBeenCalledTimes(2)
    queue.destroy()
  })

  it('pauses an active job and can resume it explicitly', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const start = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:pause' }))
    const id = queue.enqueue({ name: 'pause me', kind: 'torrent', start })
    await tick()

    expect(await queue.pauseActive()).toBe(true)
    expect(queue.getSnapshot().find(job => job.id === id)?.status).toBe('paused')
    expect(queue.resumeQueued(id)).toBe(true)
    await tick()
    expect(start).toHaveBeenCalledTimes(2)
    queue.destroy()
  })

  it('retries a failed job using its in-memory start handler', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const start = vi.fn(e => e.download({ url: 'magnet:?xt=urn:btih:retry' }))
    const id = queue.enqueue({ name: 'retry me', kind: 'torrent', start })
    await tick()

    engine.emit({ state: 'error', progress: 0 })
    expect(queue.getSnapshot().find(job => job.id === id)?.status).toBe('failed')
    expect(queue.retryFailed(id)).toBe(true)
    await tick()
    expect(start).toHaveBeenCalledTimes(2)
    queue.destroy()
  })

  it('finishes HTTP jobs on their completion event even if the bridge resolves early', async () => {
    const engine = mockEngine()
    const queue = createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
    })
    const id = queue.enqueue({
      name: 'direct',
      kind: 'http',
      start: e => e.downloadHttp({ url: 'https://media.example/video.mp4' }),
    })
    await tick()
    expect(queue.getSnapshot().find(job => job.id === id)?.status).toBe('downloading')
    engine.emit({ state: 'finished', progress: 1, fileName: 'direct.mp4' })
    expect(queue.getSnapshot().find(job => job.id === id)?.status).toBe('completed')
    queue.destroy()
  })

  it('persists queued torrent jobs and restores them on the next session', async () => {
    const mem = {}
    const store = { get: k => mem[k] ?? null, set: (k, v) => { mem[k] = v } }
    const engine = mockEngine()
    engine.download = vi.fn(async () => new Promise(() => {})) // never completes
    const make = () => createDownloadQueue({
      getEngine: async () => engine,
      isPlaybackActive: async () => false,
      persistStore: store,
    })
    const q1 = make()
    q1.enqueue({
      name: 'peli',
      kind: 'torrent',
      persist: { kind: 'torrent', url: 'magnet:?xt=urn:btih:abc', season: 1, episode: 2 },
      start: e => e.download({ url: 'magnet:?xt=urn:btih:abc' }),
    })
    await tick()
    const saved = mem.octostream_download_queue
    expect(saved[0].persist.url).toBe('magnet:?xt=urn:btih:abc')
    q1.destroy()

    const q2 = make()
    const restored = q2.restorePersisted()
    expect(restored).toBe(1)
    await tick()
    expect(engine.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'magnet:?xt=urn:btih:abc', season: 1, episode: 2 }))
    q2.destroy()
  })

  it('does not persist plain http jobs (signed URLs must not hit disk)', async () => {
    const mem = {}
    const store = { get: k => mem[k] ?? null, set: (k, v) => { mem[k] = v } }
    const queue = createDownloadQueue({
      getEngine: async () => mockEngine(),
      isPlaybackActive: async () => false,
      persistStore: store,
    })
    queue.enqueue({
      name: 'signed',
      kind: 'http',
      persist: { kind: 'http', url: 'https://cdn.example/signed?token=x' },
      start: () => ({}),
    })
    await tick()
    const saved = mem.octostream_download_queue || []
    expect(saved).toHaveLength(0)
    queue.destroy()
  })
})
