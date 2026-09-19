// Sondeo ligero de playlists HLS: descarga el master .m3u8 y extrae la
// resolución máxima anunciada (EXT-X-STREAM-INF RESOLUTION). Sirve para
// etiquetar streams live (FCTV/DLive) con "1080p"/"720p"/"4K" sin tener que
// abrir el player. Media playlists sin variantes devuelven null.

import { httpGetText, shortSignal } from './httpClient.js'

const RESOLUTION_RE = /RESOLUTION=\s*\d+\s*x\s*(\d+)/gi

export function parseMasterQuality(text) {
  let max = 0
  let m
  RESOLUTION_RE.lastIndex = 0
  while ((m = RESOLUTION_RE.exec(text))) max = Math.max(max, +m[1])
  if (max >= 2160) return '4K'
  if (max > 0) return `${max}p`
  return null
}

// Devuelve "1080p"/"4K"/… o null si la playlist no declara variantes o la
// sonda falla (timeout, CORS, token caducado). Nunca lanza.
export async function probeHlsQuality(url, headers, signal) {
  try {
    const text = await httpGetText(url, headers, shortSignal(signal, 6000))
    return parseMasterQuality(text)
  } catch {
    return null
  }
}
