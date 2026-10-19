import { describe, it, expect } from 'vitest'
import { inferStreamType } from './streamType.js'

describe('inferStreamType', () => {
  it('detecta HLS por extensión .m3u8', () => {
    expect(inferStreamType('https://cdn.example.com/master.m3u8')).toBe('hls')
    expect(inferStreamType('https://cdn.example.com/v.m3u8?token=abc')).toBe('hls')
  })

  it('detecta mp4/ficheros progresivos', () => {
    expect(inferStreamType('https://cdn.example.com/video.mp4')).toBe('mp4')
    expect(inferStreamType('https://cdn.example.com/video.mp4?sig=x')).toBe('mp4')
  })

  it('detecta .mkv como fichero progresivo (regresión: debrid .mkv llegaba como hls → 3002)', () => {
    expect(inferStreamType('https://i1j2k3.debrid.it/dl/abc/Ted.Lasso.4x08.1080p.mkv')).toBe('mp4')
    expect(inferStreamType('https://cdn.example.com/pelicula.mkv?x=1')).toBe('mp4')
    expect(inferStreamType('https://cdn.example.com/peli.avi')).toBe('mp4')
    expect(inferStreamType('https://cdn.example.com/peli.webm')).toBe('mp4')
  })

  it('detecta hosts de descarga debrid sin extensión clara', () => {
    expect(inferStreamType('https://n0o1p2.debrid.it/dl/xyz/file')).toBe('mp4')
    expect(inferStreamType('https://download.alldebrid.com/abc')).toBe('mp4')
  })

  it('detecta DASH y torrent', () => {
    expect(inferStreamType('https://cdn.example.com/manifest.mpd')).toBe('dash')
    expect(inferStreamType('magnet:?xt=urn:btih:abc')).toBe('torrent')
    expect(inferStreamType('https://t.example.com/file.torrent')).toBe('torrent')
  })

  it('un .m3u8 en host debrid sigue siendo hls', () => {
    expect(inferStreamType('https://x.debrid.it/dl/a/lista.m3u8')).toBe('hls')
  })

  it('respeta el fallback cuando la URL no informa', () => {
    expect(inferStreamType('https://server.com/video', 'hls')).toBe('hls')
    expect(inferStreamType('https://server.com/video', 'dash')).toBe('dash')
    expect(inferStreamType('', 'hls')).toBe('hls')
    expect(inferStreamType(null, 'mp4')).toBe('mp4')
  })

  it('videoplayback (googlevideo) es progresivo', () => {
    expect(inferStreamType('https://rr1---sn.googlevideo.com/videoplayback?x=1')).toBe('mp4')
  })
})
