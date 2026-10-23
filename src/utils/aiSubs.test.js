import { describe, it, expect } from 'vitest'
import { parseSubtitleText, chunkToCues } from './aiSubs.js'

describe('parseSubtitleText', () => {
  it('parsea SRT básico', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Hola mundo.

2
00:00:04,000 --> 00:00:06,000
Segunda línea
con dos filas.
`
    const { times, texts } = parseSubtitleText(srt)
    expect(times).toEqual([[1000, 3500], [4000, 6000]])
    expect(texts[0]).toBe('Hola mundo.')
    expect(texts[1]).toBe('Segunda línea\ncon dos filas.')
  })

  it('parsea WebVTT con cabecera y BOM', () => {
    const vtt = `\uFEFFWEBVTT

00:01.500 --> 00:03.000
<i>Cursiva</i> y normal.
`
    const { times, texts } = parseSubtitleText(vtt)
    expect(times).toEqual([[1500, 3000]])
    expect(texts[0]).toBe('Cursiva y normal.')
  })

  it('descarta cues rotos o sin texto', () => {
    const srt = `1
00:00:05,000 --> 00:00:02,000
invertido

2
texto sin tiempos

3
00:00:07,000 --> 00:00:08,000
ok
`
    const { times, texts } = parseSubtitleText(srt)
    expect(times).toEqual([[7000, 8000]])
    expect(texts).toEqual(['ok'])
  })

  it('soporta horas de dos dígitos y separador de punto', () => {
    const srt = `1
01:02:03.250 --> 01:02:05.000
largo
`
    const { times } = parseSubtitleText(srt)
    expect(times[0][0]).toBe(3723250)
    expect(times[0][1]).toBe(3725000)
  })
})

describe('chunkToCues', () => {
  it('reparte frases en ventanas proporcionales', () => {
    const cues = chunkToCues('Hola. ¿Cómo estás? Bien gracias.', 10000, 30000)
    expect(cues.length).toBe(3)
    expect(cues[0].t[0]).toBe(10000)
    expect(cues[cues.length - 1].t[1]).toBe(30000)
    // ventanas contiguas y ordenadas
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].t[0]).toBe(cues[i - 1].t[1])
    }
  })

  it('texto sin puntuación genera un solo cue', () => {
    const cues = chunkToCues('una frase larga sin punto', 0, 20000)
    expect(cues.length).toBe(1)
    expect(cues[0].t).toEqual([0, 20000])
  })

  it('divide líneas largas en máximo 2 filas', () => {
    const long = 'palabra '.repeat(30).trim() + '.'
    const cues = chunkToCues(long, 0, 20000)
    expect(cues[0].x.split('\n').length).toBeLessThanOrEqual(2)
  })
})
