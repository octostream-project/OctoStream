import { describe, it, expect } from 'vitest'
import {
  parseSchedule, parseEventTitle, extractLiveLiveUrl, catalogFor, eventId, stripIcons,
} from './parse.js'

const BASE = 'https://dlive.sx'

const cat = (name, events) => `
  <div class="schedule__catHeader"><div class="card__meta">${name}</div></div>
  ${events}`

const ev = (title, time, links) => `
  <div class="schedule__event">
    <div class="schedule__eventHeader" data-title="${title.toLowerCase()} ${time}">
      <span class="schedule__time" data-time="${time}">${time}</span>
      <span class="schedule__eventTitle">${title}</span>
    </div>
    <div class="schedule__channels">
      ${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
    </div>
  </div>`

describe('stripIcons', () => {
  it('removes emojis and flag indicators', () => {
    expect(stripIcons('⚽ 🇪🇸 La Liga 🇪🇸')).toBe('La Liga')
    expect(stripIcons('🏀 Basketball')).toBe('Basketball')
  })
  it('decodes entities', () => {
    expect(stripIcons('Women&#039;s Soccer &amp; Futsal')).toBe("Women's Soccer & Futsal")
  })
})

describe('parseEventTitle', () => {
  it('splits league and teams', () => {
    expect(parseEventTitle('⚽ 🇪🇸 La Liga : Real Betis 🇪🇸 vs Getafe 🇪🇸')).toEqual({
      league: 'La Liga', title: 'Real Betis vs Getafe', home: 'Real Betis', away: 'Getafe',
    })
  })
  it('handles events without league prefix', () => {
    expect(parseEventTitle('Al-Ahli Manama vs Al Riffa')).toEqual({
      league: '', title: 'Al-Ahli Manama vs Al Riffa', home: 'Al-Ahli Manama', away: 'Al Riffa',
    })
  })
  it('handles non-vs events', () => {
    const r = parseEventTitle('🎾 WTA 500 Guadalajara Quarterfinals')
    expect(r.home).toBeNull()
    expect(r.title).toContain('Guadalajara')
  })
})

describe('parseSchedule', () => {
  it('parses categories, events, times and links', () => {
    const html = cat('All Soccer Events ⚽',
      ev('⚽ 🇪🇸 La Liga : Betis vs Getafe', '19:00', [
        ['/watchextra.php?id=1', 'Extra Stream CH-1'],
        ['/watchextra.php?id=2', 'Extra Stream CH-2'],
      ]) +
      ev('Soccer : Al-Ahli vs Al Riffa', '16:00', [['/stream/stream-32.php', '']]))
    const events = parseSchedule(html, BASE)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      league: 'La Liga', home: 'Betis', away: 'Getafe',
      time: '19:00', live: false, category: 'All Soccer Events',
    })
    expect(events[0].links.map(l => l.url)).toEqual([
      `${BASE}/watchextra.php?id=1`, `${BASE}/watchextra.php?id=2`,
    ])
    expect(events[1].links[0].url).toBe(`${BASE}/stream/stream-32.php`)
  })

  it('marks LIVE NOW category events as live', () => {
    const html = cat('LIVE NOW', ev('RUS Premier League : FC Orenburg vs FK Krasnodar', '', [
      ['/watchlivelive.php?id=abc123', 'HD'],
    ]))
    const events = parseSchedule(html, BASE)
    expect(events[0].live).toBe(true)
    expect(events[0].links[0].label).toBe('HD')
  })

  it('skips events without links and categories without meta', () => {
    const html = cat('Soccer', ev('A vs B', '10:00', [])) + '<div class="schedule__catHeader"><p>no meta</p></div>'
    expect(parseSchedule(html, BASE)).toHaveLength(0)
  })
})

describe('extractLiveLiveUrl', () => {
  it('extracts the m3u8 from the playerFrame iframe src, keeping its own query params', () => {
    const html = `<iframe id="playerFrame" src="https://livelive24.com/dlhd.html?url=https://cdn.example.com/live/x.m3u8?txSecret=aa&amp;txTime=BB"></iframe>`
    expect(extractLiveLiveUrl(html)).toEqual({
      url: 'https://cdn.example.com/live/x.m3u8?txSecret=aa&txTime=BB',
      referer: 'https://livelive24.com/',
    })
  })
  it('returns null when no m3u8 present', () => {
    expect(extractLiveLiveUrl('<iframe src="https://x.com/p.html"></iframe>')).toBeNull()
    expect(extractLiveLiveUrl('')).toBeNull()
  })
})

describe('catalogFor', () => {
  it('maps categories to sport catalogs', () => {
    expect(catalogFor('All Soccer Events', 'La Liga')).toBe('dlive-football')
    expect(catalogFor('Basketball', 'NBA')).toBe('dlive-basketball')
    expect(catalogFor('Tennis', '')).toBe('dlive-tennis')
    expect(catalogFor('Motorsport', 'F1')).toBe('dlive-motor')
    expect(catalogFor('Darts', '')).toBe('dlive-others')
  })
  it('excludes american/college football from soccer', () => {
    expect(catalogFor('Am. Football (NFL)', '')).toBe('dlive-others')
    expect(catalogFor('College Football', '')).toBe('dlive-others')
    // El soccer universitario sí es fútbol.
    expect(catalogFor('College Soccer', '')).toBe('dlive-football')
    expect(catalogFor("Women's College Soccer", '')).toBe('dlive-football')
  })
  it('keeps other sports out of football even with football-like league names', () => {
    expect(catalogFor('Handball', 'Champions League')).toBe('dlive-others')
    expect(catalogFor('Volleyball', 'European Championships')).toBe('dlive-others')
    expect(catalogFor('Rugby Union', 'National Provincial Championship')).toBe('dlive-others')
    // En categorías genéricas manda la liga: la BCL es baloncesto.
    expect(catalogFor('LIVE NOW', 'Basketball Champions League-Qualification')).toBe('dlive-basketball')
    expect(catalogFor('LIVE NOW', 'VS-FB Exclusive EAFC24 Champions League')).toBe('dlive-football')
  })
  it('excludes horse racing from motor', () => {
    expect(catalogFor('Horse Racing', '')).toBe('dlive-others')
  })
})

describe('eventId', () => {
  it('is deterministic and distinguishes events', () => {
    const a = { home: 'Betis', away: 'Getafe', league: 'La Liga', title: 'x', category: 'c' }
    const b = { home: 'Betis', away: 'Getafe', league: 'Copa', title: 'x', category: 'c' }
    expect(eventId(a)).toBe(eventId({ ...a }))
    expect(eventId(a)).not.toBe(eventId(b))
    expect(eventId(a)).toMatch(/^dlive:/)
  })
})
