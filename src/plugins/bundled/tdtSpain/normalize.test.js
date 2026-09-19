import { describe, it, expect } from 'vitest'
import { normKey, proxied, RESOLVABLE_TYPES, RTVE_HLS_FALLBACK } from './constants.js'
import { currentEvent, nextEvent, normalizeChannel } from './normalize.js'

describe('normKey', () => {
  it('lowercases and strips whitespace', () => {
    expect(normKey('La 1')).toBe('la1')
    expect(normKey('  TDP  ')).toBe('tdp')
  })

  it('strips non-word characters except dots and dashes', () => {
    expect(normKey('La 1.TV!')).toBe('la1.tv')
    // Underscore is part of \w, so it is preserved
    expect(normKey('Canal_24h')).toBe('canal_24h')
    expect(normKey('Canal+24h')).toBe('canal24h')
  })

  it('handles empty/null input', () => {
    expect(normKey('')).toBe('')
    expect(normKey(null)).toBe('')
    expect(normKey(undefined)).toBe('')
  })
})

describe('proxied', () => {
  it('returns the url unchanged when no proxy is configured', () => {
    expect(proxied('https://example.com/stream.m3u8')).toBe('https://example.com/stream.m3u8')
  })

  it('returns the url unchanged for 127.0.0.1 addresses', () => {
    window.octostream = { proxyUrl: 'https://proxy.example.com/?url=' }
    try {
      expect(proxied('http://127.0.0.1:8080/stream.m3u8')).toBe('http://127.0.0.1:8080/stream.m3u8')
    } finally {
      delete window.octostream
    }
  })

  it('returns the url unchanged for mediaset/dai/doubleclick', () => {
    window.octostream = { proxyUrl: 'https://proxy.example.com/?url=' }
    try {
      expect(proxied('https://mediaset.example.com/x.m3u8')).toBe('https://mediaset.example.com/x.m3u8')
      expect(proxied('https://dai.google.com/x.m3u8')).toBe('https://dai.google.com/x.m3u8')
      expect(proxied('https://doubleclick.net/x.m3u8')).toBe('https://doubleclick.net/x.m3u8')
    } finally {
      delete window.octostream
    }
  })

  it('proxies HLS and .gz URLs when proxyUrl is set', () => {
    window.octostream = { proxyUrl: 'https://proxy.example.com/?url=' }
    try {
      expect(proxied('https://example.com/stream.m3u8')).toBe('https://proxy.example.com/?url=' + encodeURIComponent('https://example.com/stream.m3u8'))
      expect(proxied('https://example.com/data.json.gz')).toBe('https://proxy.example.com/?url=' + encodeURIComponent('https://example.com/data.json.gz'))
    } finally {
      delete window.octostream
    }
  })

  it('does not proxy non-HLS, non-gz URLs', () => {
    window.octostream = { proxyUrl: 'https://proxy.example.com/?url=' }
    try {
      expect(proxied('https://example.com/page.html')).toBe('https://example.com/page.html')
      expect(proxied('https://example.com/api.json')).toBe('https://example.com/api.json')
    } finally {
      delete window.octostream
    }
  })
})

describe('RESOLVABLE_TYPES', () => {
  it('includes the expected stream types', () => {
    expect(RESOLVABLE_TYPES.has('hls')).toBe(true)
    expect(RESOLVABLE_TYPES.has('stream1')).toBe(true)
    expect(RESOLVABLE_TYPES.has('stream10')).toBe(true)
    expect(RESOLVABLE_TYPES.has('stream11')).toBe(true)
    expect(RESOLVABLE_TYPES.has('stream12')).toBe(true)
    expect(RESOLVABLE_TYPES.has('geturl')).toBe(true)
    expect(RESOLVABLE_TYPES.has('posturl')).toBe(true)
    expect(RESOLVABLE_TYPES.has('')).toBe(true)
  })

  it('excludes unknown types', () => {
    expect(RESOLVABLE_TYPES.has('youtube')).toBe(false)
    expect(RESOLVABLE_TYPES.has('unknown')).toBe(false)
  })
})

describe('RTVE_HLS_FALLBACK', () => {
  it('contains key Spanish channels', () => {
    expect(RTVE_HLS_FALLBACK['La1.TV']).toContain('rtvelivestream')
    expect(RTVE_HLS_FALLBACK['La2.TV']).toContain('rtvelivestream')
    expect(RTVE_HLS_FALLBACK['24Horas.TV']).toContain('rtvelivestream')
    expect(RTVE_HLS_FALLBACK['Clan.TV']).toContain('rtvelivestream')
  })
})

describe('currentEvent', () => {
  const now = Math.floor(Date.now() / 1000)
  const epg = {
    'La1.TV': [
      { hi: String(now - 3600), hf: String(now + 3600), t: 'Programa actual' },
      { hi: String(now + 3600), hf: String(now + 7200), t: 'Siguiente' },
    ],
    la2: [
      { startTimestamp: now - 1800, endTimestamp: now + 1800, title: 'La 2 actual' },
    ],
  }

  it('finds the current event by exact key', () => {
    const ev = currentEvent(epg, 'La1.TV')
    expect(ev).not.toBeNull()
    expect(ev.t).toBe('Programa actual')
  })

  it('finds the current event by normalized key', () => {
    const ev = currentEvent(epg, 'la2')
    expect(ev).not.toBeNull()
    expect(ev.title).toBe('La 2 actual')
  })

  it('finds the current event via .TV suffix variant', () => {
    const ev = currentEvent(epg, 'La1')
    // 'La1' → tries 'La1', 'la1', 'La1.TV', 'la1.tv', 'la1.tv'
    expect(ev).not.toBeNull()
  })

  it('returns null for unknown channels', () => {
    expect(currentEvent(epg, 'Unknown')).toBeNull()
  })

  it('returns null for null/undefined epg or epgId', () => {
    expect(currentEvent(null, 'La1.TV')).toBeNull()
    expect(currentEvent(epg, null)).toBeNull()
    expect(currentEvent(epg, '')).toBeNull()
  })

  it('returns null when no event covers the current time', () => {
    const futureEpg = {
      'Future.TV': [{ hi: String(now + 7200), hf: String(now + 10800), t: 'Future' }],
    }
    expect(currentEvent(futureEpg, 'Future.TV')).toBeNull()
  })
})

describe('nextEvent', () => {
  const now = Math.floor(Date.now() / 1000)
  const epg = {
    'La1.TV': [
      { hi: String(now - 3600), hf: String(now + 3600), t: 'Actual' },
      { hi: String(now + 3600), hf: String(now + 7200), t: 'Siguiente' },
      { hi: String(now + 7200), hf: String(now + 10800), t: 'Después' },
    ],
  }

  it('finds the next event after the current time', () => {
    const ev = nextEvent(epg, 'La1.TV')
    expect(ev).not.toBeNull()
    expect(ev.t).toBe('Siguiente')
  })

  it('returns null for unknown channels', () => {
    expect(nextEvent(epg, 'Unknown')).toBeNull()
  })

  it('returns null for null epg', () => {
    expect(nextEvent(null, 'La1.TV')).toBeNull()
  })
})

describe('normalizeChannel', () => {
  const now = Math.floor(Date.now() / 1000)
  const epg = {
    'La1.TV': [
      { hi: String(now - 3600), hf: String(now + 3600), t: 'Telediario', d: 'Noticias' },
      { hi: String(now + 3600), hf: String(now + 7200), t: 'Siguiente prog' },
    ],
  }

  it('produces a normalized channel object with EPG info', () => {
    const ch = { id: 'la1', name: 'La 1', logo: 'https://logo.png', group: 'TVE', epgid: 'La1.TV' }
    const norm = normalizeChannel(ch, epg)
    expect(norm.id).toBe('tdtspain-la1')
    expect(norm.name).toBe('La 1')
    expect(norm.logo).toBe('https://logo.png')
    expect(norm.poster).toBe('https://logo.png')
    expect(norm.nowPlaying).toBe('Telediario')
    expect(norm.nextPlaying).toBe('Siguiente prog')
    expect(norm.group).toBe('TVE')
    expect(norm.quality).toBe('LIVE')
  })

  it('falls back to channel name for EPG lookup', () => {
    const ch = { id: 'la1', name: 'La1.TV', logo: '', group: '' }
    const norm = normalizeChannel(ch, epg)
    expect(norm.nowPlaying).toBe('Telediario')
  })

  it('uses default overview when no EPG match', () => {
    const ch = { id: 'unknown', name: 'Unknown Channel', logo: '', group: 'Otros' }
    const norm = normalizeChannel(ch, {})
    expect(norm.nowPlaying).toBe('')
    expect(norm.description).toBe('Canal TDT en directo')
    expect(norm.group).toBe('Otros')
  })

  it('preserves EPG timestamps for the player progress bar', () => {
    const ch = { id: 'la1', name: 'La 1', epgid: 'La1.TV' }
    const norm = normalizeChannel(ch, epg)
    expect(norm.nowPlayingStart).toBe(now - 3600)
    expect(norm.nowPlayingEnd).toBe(now + 3600)
    expect(norm.nextPlayingStart).toBe(now + 3600)
  })
})
