import { describe, expect, it } from 'vitest'
import {
  isMatchInLiveWindow,
  matchesForSportsView,
  preferFctvMatchDate,
  LIVE_DURATION_MS,
  LIVE_EARLY_MS,
} from './sportsMatch.js'

describe('isMatchInLiveWindow', () => {
  const now = new Date('2026-10-31T12:00:00Z').getTime()

  it('accepts a match starting soon or recently started', () => {
    expect(isMatchInLiveWindow(now + LIVE_EARLY_MS, now)).toBe(true)
    expect(isMatchInLiveWindow(now - 90 * 60 * 1000, now)).toBe(true)
  })

  it('rejects yesterday matches and time-only/missing dates', () => {
    expect(isMatchInLiveWindow(now - 24 * 60 * 60 * 1000, now)).toBe(false)
    expect(isMatchInLiveWindow(0, now)).toBe(false)
  })

  it('rejects matches outside the early-start and live-duration window', () => {
    expect(isMatchInLiveWindow(now + LIVE_EARLY_MS + 1, now)).toBe(false)
    expect(isMatchInLiveWindow(now - LIVE_DURATION_MS, now)).toBe(false)
  })
})

describe('preferFctvMatchDate', () => {
  it('uses the FCTV kickoff instead of a fabricated schedule date', () => {
    const yesterday = new Date('2026-10-30T21:00:00Z').getTime()
    const fabricatedToday = new Date('2026-10-31T21:00:00Z').getTime()
    expect(preferFctvMatchDate(yesterday, fabricatedToday)).toBe(yesterday)
  })

  it('falls back only when FCTV has no valid date', () => {
    const marcaDate = new Date('2026-10-30T21:00:00Z').getTime()
    expect(preferFctvMatchDate(0, marcaDate)).toBe(marcaDate)
    expect(preferFctvMatchDate(Number.NaN, 0)).toBe(0)
  })
})

describe('matchesForSportsView', () => {
  const dayStart = new Date('2026-10-31T00:00:00').getTime()
  const dayEnd = dayStart + 24 * 60 * 60 * 1000
  const now = new Date('2026-10-31T12:00:00').getTime()
  const matches = [
    { id: 'live', _isLive: true, _matchDate: now, _score: { home: 1, away: 0 } },
    { id: 'finished', _isLive: false, _matchDate: now - 60_000, _score: { home: 2, away: 1 } },
    { id: 'later', _isLive: false, _matchDate: now + 60_000, _score: null },
    { id: 'yesterday', _isLive: false, _matchDate: dayStart - 1, _score: { home: 0, away: 1 } },
  ]

  it('separates live, today, results and future fixtures', () => {
    expect(matchesForSportsView(matches, 'live', dayStart, dayEnd, now).map(m => m.id)).toEqual(['live'])
    expect(matchesForSportsView(matches, 'today', dayStart, dayEnd, now).map(m => m.id))
      .toEqual(['live', 'finished', 'later'])
    expect(matchesForSportsView(matches, 'results', dayStart, dayEnd, now).map(m => m.id))
      .toEqual(['finished'])
    expect(matchesForSportsView(matches, 'upcoming', dayStart, dayEnd, now).map(m => m.id))
      .toEqual(['later'])
  })

  it('keeps results without a timestamp visible in results', () => {
    const item = { id: 'score-no-date', _score: { home: 1, away: 1 }, _matchDate: 0 }
    expect(matchesForSportsView([item], 'results', dayStart, dayEnd, now)).toEqual([item])
  })
})
