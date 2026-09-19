import { describe, it, expect } from 'vitest'
import {
  rot47, parseLiveResponse, parseDetailStreams, parseStreamDetail, parseUserInfo,
} from './proto.js'

// --- protobuf encoding helpers for tests -----------------------------------

function varint(v) {
  const out = []
  do { out.push(v & 0x7f); v = Math.floor(v / 128) } while (v > 0)
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80
  return out
}
const key = (f, w) => varint((f << 3) | w)
const len = (f, bytes) => [...key(f, 2), ...varint(bytes.length), ...bytes]
const num = (f, v) => [...key(f, 0), ...varint(v)]
const s = (f, text) => len(f, [...new TextEncoder().encode(text)])

// --- tests ------------------------------------------------------------------

describe('rot47', () => {
  it('decodes ROT47 text', () => {
    // rot47 is its own inverse — encode by applying it to plaintext
    const encoded = rot47('{"success":true}')
    expect(rot47(encoded)).toBe('{"success":true}')
  })
})

describe('parseLiveResponse', () => {
  function buildMatch({ matchId = 123, sportType = 1, title = '', home = '', away = '', matchDate = 1789597800000, leagueName = '', slug = '', leagueSlug = '', score = null } = {}) {
    const fields = [
      ...num(1, matchId),
      ...num(2, sportType),
      ...num(3, matchDate),
    ]
    if (leagueName) {
      fields.push(...len(10, [
        ...num(1, 99),
        ...len(3, s(2, leagueName)),
      ]))
    }
    if (title) fields.push(...len(30, s(2, title)))
    for (const [i, name] of [home, away].entries()) {
      if (!name) continue
      fields.push(...len(30, [
        ...num(1, i + 1),
        ...len(10, [
          ...num(1, 1000 + i),
          ...len(3, s(2, name)),
          ...s(4, 'https://logos1.example.com/team.png'),
        ]),
      ]))
    }
    if (score) {
      fields.push(...len(100, [
        ...len(1, num(10, score.home)),
        ...len(2, num(10, score.away)),
      ]))
    }
    if (slug || leagueSlug) {
      fields.push(...len(150, [
        ...(slug ? s(20, slug) : []),
        ...(leagueSlug ? s(21, leagueSlug) : []),
      ]))
    }
    return fields
  }

  function buildResponse(matches = [], streams = []) {
    const wrap = [
      ...matches.map(m => len(1, m)).flat(),
      ...streams.map(st => len(2, [...num(2, st.sportType), ...num(5, st.channelId), ...num(50, st.matchId)])).flat(),
    ]
    return new Uint8Array([...s(3, 'Success'), ...len(10, wrap)])
  }

  it('parses matches with teams, league, score and slugs', () => {
    const buf = buildResponse([
      buildMatch({
        matchId: 4502724, title: 'Uzbekistan Women vs China Women',
        home: 'Uzbekistan (w)', away: 'China (w)',
        leagueName: "OCA Women's Asian Games",
        slug: 'uzbekistan-women-vs-china-women',
        leagueSlug: 'oca-womens-asian-games',
        score: { home: 1, away: 1 },
      }),
    ], [{ sportType: 1, channelId: 1, matchId: 4502724 }])

    const r = parseLiveResponse(buf)
    expect(r.matches).toHaveLength(1)
    expect(r.streams).toHaveLength(1)
    const m = r.matches[0]
    expect(m.matchId).toBe(4502724)
    expect(m.sportType).toBe(1)
    expect(m.title).toBe('Uzbekistan Women vs China Women')
    expect(m.home.name).toBe('Uzbekistan (w)')
    expect(m.away.name).toBe('China (w)')
    expect(m.league.name).toBe("OCA Women's Asian Games")
    expect(m.slug).toBe('uzbekistan-women-vs-china-women')
    expect(m.leagueSlug).toBe('oca-womens-asian-games')
    expect(m.score).toEqual({ home: 1, away: 1 })
    expect(m.matchDate).toBe(1789597800000)
    expect(r.streams[0].matchId).toBe(4502724)
  })

  it('handles large varints (ms timestamps) without 32-bit overflow', () => {
    const buf = buildResponse([buildMatch({ matchId: 1, matchDate: 1789597800000 })])
    const r = parseLiveResponse(buf)
    expect(r.matches[0].matchDate).toBe(1789597800000)
  })

  it('returns empty arrays on malformed input', () => {
    expect(parseLiveResponse(new Uint8Array(0))).toEqual({ matches: [], streams: [] })
    expect(parseLiveResponse(new Uint8Array([0xff, 0xff, 0xff]))).toEqual({ matches: [], streams: [] })
  })

  it('parses nested title wrappers', () => {
    // {30: {2: {8: {5: "Title"}}}} — deeper nesting variant
    const titleMsg = len(30, len(2, len(8, s(5, 'Deep Title Match'))))
    const m = [...num(1, 7), ...num(2, 1), ...num(3, 1000), ...titleMsg]
    const buf = buildResponse([m])
    expect(parseLiveResponse(buf).matches[0].title).toBe('Deep Title Match')
  })
})

describe('parseDetailStreams', () => {
  it('extracts streamId/siteType/name from match detail stream entries', () => {
    const entry = len(2, [
      ...num(1, 818368),   // streamId
      ...num(2, 1),
      ...s(3, 'Tod Arabic'), // name
      ...num(5, 1),
      ...num(9, 2001),     // siteType
      ...num(50, 4502724), // matchId
    ])
    const buf = new Uint8Array([...s(3, 'Success'), ...len(10, entry)])
    const streams = parseDetailStreams(buf)
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({
      streamId: 818368, siteType: 2001, name: 'Tod Arabic', matchId: 4502724,
    })
  })

  it('returns empty on error responses', () => {
    const buf = new Uint8Array([...num(2, 100), ...s(3, 'Stream Not Found')])
    expect(parseDetailStreams(buf)).toEqual([])
  })
})

describe('parseStreamDetail', () => {
  it('extracts the ROT47 url and backup origins', () => {
    const enc = (t) => s(4, rot47('PREFIXED' + t))
    const stream = len(2, [
      ...s(3, 'SKA'),
      ...enc('https://cdn.example.com/live/index.m3u8'),
      ...len(12, [...new TextEncoder().encode(rot47('PREFIXED' + 'https://bk1.example.com'))]),
      ...len(12, [...new TextEncoder().encode(rot47('PREFIXED' + 'https://bk2.example.com'))]),
    ])
    const buf = new Uint8Array([...s(3, 'Success'), ...len(10, stream)])
    const r = parseStreamDetail(buf)
    expect(r.name).toBe('SKA')
    expect(rot47(r.url).slice(8)).toBe('https://cdn.example.com/live/index.m3u8')
    expect(r.backups.map(b => rot47(b).slice(8))).toEqual([
      'https://bk1.example.com', 'https://bk2.example.com',
    ])
  })
})

describe('parseUserInfo', () => {
  it('extracts country and continent', () => {
    const buf = new Uint8Array([
      ...s(3, 'Success'),
      ...len(10, [
        ...s(1, '2a09:bac5:310f:191::28:100'),
        ...s(2, 'ES'),
        ...s(3, 'EU'),
      ]),
    ])
    expect(parseUserInfo(buf)).toEqual({ country: 'ES', continent: 'EU' })
  })
})
