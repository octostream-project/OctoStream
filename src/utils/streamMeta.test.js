import { describe, it, expect } from 'vitest'
import { langFromChannelLabel } from './streamMeta.js'

describe('langFromChannelLabel', () => {
  it('detects language words in channel names', () => {
    expect(langFromChannelLabel('Tod Arabic')).toBe('Ara')
    expect(langFromChannelLabel('beIN Sports English')).toBe('Eng')
    expect(langFromChannelLabel('Movistar Spanish')).toBe('Esp')
    expect(langFromChannelLabel('Canal+ French')).toBe('Fra')
    expect(langFromChannelLabel('Sky Sport Deutsch')).toBe('Ale')
  })

  it('detects flag emojis', () => {
    expect(langFromChannelLabel('Sky Sports 🇬🇧')).toBe('Eng')
    expect(langFromChannelLabel('Movistar 🇪🇸')).toBe('Esp')
    expect(langFromChannelLabel('beIN 🇫🇷')).toBe('Fra')
  })

  it('returns Dual for two different flags', () => {
    expect(langFromChannelLabel('Multi 🇪🇸 / 🇬🇧')).toBe('Dual')
  })

  it('detects trailing country codes', () => {
    expect(langFromChannelLabel('Sky Sports (IT)')).toBe('Ita')
    expect(langFromChannelLabel('DAZN - ES')).toBe('Esp')
    expect(langFromChannelLabel('beIN Sports US')).toBe('Eng')
  })

  it('returns empty when no language is declared', () => {
    expect(langFromChannelLabel('Sky Sports Main Event')).toBe('')
    expect(langFromChannelLabel('HD')).toBe('')
    expect(langFromChannelLabel('Stream 1')).toBe('')
    expect(langFromChannelLabel('')).toBe('')
    expect(langFromChannelLabel(null)).toBe('')
  })
})
