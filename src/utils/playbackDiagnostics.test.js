import { describe, expect, it } from 'vitest'
import { playbackHelpForError, sanitizePlaybackError } from './playbackDiagnostics.js'

describe('sanitizePlaybackError', () => {
  it('removes full signed URLs and secret query values', () => {
    expect(sanitizePlaybackError('HTTP 403 https://cdn.example/video.m3u8?token=secret&x=1'))
      .toBe('HTTP 403 [enlace oculto]')
    expect(sanitizePlaybackError('auth=secret signature=private'))
      .not.toContain('secret')
  })

  it('bounds and normalizes noisy native messages', () => {
    expect(sanitizePlaybackError(`  ${'x'.repeat(400)}  `)).toHaveLength(240)
  })
})

describe('playbackHelpForError', () => {
  it.each([
    ['HTTP 403 forbidden', 'El servidor rechazó el enlace'],
    ['HTTP 404 not found', 'ya no está disponible'],
    ['decoder initialization failed', 'no pudo decodificar'],
    ['connection timeout', 'No se pudo conectar'],
  ])('classifies %s into actionable guidance', (message, expected) => {
    expect(playbackHelpForError(message)).toContain(expected)
  })
})
