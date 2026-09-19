import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { torrentBytesToMagnet } from './torrentFile.js'

// Build a minimal valid .torrent buffer (bencoded dict).
function makeTorrent({ name = 'test-file', trackers = [], extra = '' } = {}) {
  const pieces = Buffer.alloc(20, 0xab) // fake sha1 piece hash
  const announce = trackers[0] || 'udp://tracker.example:1337/announce'
  const parts = [
    Buffer.from(`d8:announce${announce.length}:${announce}`),
    trackers.length > 1
      ? Buffer.from(`13:announce-listl${trackers.map(t => `l${t.length}:${t}e`).join('')}e`)
      : Buffer.alloc(0),
    Buffer.from(`4:infod6:lengthi100e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:`),
    pieces,
    Buffer.from(extra),
    Buffer.from('ee'),
  ]
  return Buffer.concat(parts)
}

describe('torrentBytesToMagnet', () => {
  it('computes the infohash as SHA-1 of the raw info dict', async () => {
    const bytes = makeTorrent({ name: 'Mi Pelicula' })
    const magnet = await torrentBytesToMagnet(new Uint8Array(bytes))

    // Expected hash: SHA-1 over the exact "info" dict span
    const infoStart = bytes.indexOf('4:info') + 6
    const infoEnd = bytes.lastIndexOf('ee') + 1 // last 'e' closes info, then root 'e'
    const expected = createHash('sha1').update(bytes.subarray(infoStart, infoEnd - 1 + 1)).digest('hex')

    expect(magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/)
    expect(magnet).toContain(`xt=urn:btih:${expected.slice(0, 40)}`)
    expect(magnet).toContain('dn=Mi%20Pelicula')
    expect(magnet).toContain('tr=' + encodeURIComponent('udp://tracker.example:1337/announce'))
  })

  it('handles multi-tracker torrents', async () => {
    const bytes = makeTorrent({
      name: 'x',
      trackers: ['udp://t1:1/a', 'udp://t2:2/b'],
    })
    const magnet = await torrentBytesToMagnet(new Uint8Array(bytes))
    expect(magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/)
  })

  it('rejects non-bencoded data', async () => {
    await expect(torrentBytesToMagnet(new TextEncoder().encode('<html>nope</html>')))
      .rejects.toThrow()
  })
})
