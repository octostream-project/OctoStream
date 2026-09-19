import { describe, it, expect } from 'vitest'
import { sanitizeUrl, sanitizeRemoteUrl, isSafeUrl } from './sanitizeUrl.js'

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

describe('sanitizeRemoteUrl', () => {
  it('allows http/https stream URLs', () => {
    expect(sanitizeRemoteUrl('https://cdn.example.com/s.m3u8?tok=abc')).toBe('https://cdn.example.com/s.m3u8?tok=abc')
    expect(sanitizeRemoteUrl('http://192.168.1.10:8080/ch')).toBe('http://192.168.1.10:8080/ch')
  })

  it('rejects data: and blob: payloads from the network', () => {
    expect(sanitizeRemoteUrl('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(sanitizeRemoteUrl('blob:https://evil.example/uuid')).toBe('')
  })

  it('rejects file:, javascript: and app schemes', () => {
    expect(sanitizeRemoteUrl('file:///etc/passwd')).toBe('')
    expect(sanitizeRemoteUrl('javascript:alert(1)')).toBe('')
    expect(sanitizeRemoteUrl('intent://evil')).toBe('')
    expect(sanitizeRemoteUrl('vlc://https://example.com')).toBe('')
  })

  it('rejects URLs with embedded credentials', () => {
    expect(sanitizeRemoteUrl('http://user:pass@example.com/x')).toBe('')
  })

  it('rejects invalid and empty input', () => {
    expect(sanitizeRemoteUrl('not-a-url')).toBe('')
    expect(sanitizeRemoteUrl('')).toBe('')
    expect(sanitizeRemoteUrl(null)).toBe('')
    expect(sanitizeRemoteUrl(123)).toBe('')
  })
})
