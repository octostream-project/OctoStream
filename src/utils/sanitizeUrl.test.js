import { describe, it, expect } from 'vitest'
import { sanitizeUrl, isSafeUrl } from './sanitizeUrl.js'

describe('sanitizeUrl', () => {
  it('allows https URLs', () => {
    expect(sanitizeUrl('https://example.com/video.mp4')).toBe('https://example.com/video.mp4')
  })

  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com')
  })

  it('allows vlc and mpv protocol URLs', () => {
    expect(sanitizeUrl('vlc://https://example.com')).toBe('vlc://https://example.com')
    expect(sanitizeUrl('mpv://https://example.com')).toBe('mpv://https://example.com')
  })

  it('rejects javascript protocol URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('')
  })

  it('rejects invalid URLs', () => {
    expect(sanitizeUrl('not-a-url')).toBe('')
    expect(sanitizeUrl('')).toBe('')
  })

  it('isSafeUrl returns boolean', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })
})
