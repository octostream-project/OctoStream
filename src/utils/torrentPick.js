// Selección de archivo dentro de un torrent multi-archivo (fileIdx al estilo
// Peerflix): los packs de temporada llevan un .mkv por episodio y los torrents
// de película suelen traer samples/extras. Sin elegir archivo, el debrid baja
// el torrent entero (más lento de cachear), hay que desbloquear un link por
// fichero y se puede acabar reproduciendo el episodio equivocado.

const VIDEO_EXT = /\.(?:mkv|mp4|m4v|avi|wmv|mov|ts|webm|mpg|mpeg)$/i
const SAMPLE_JUNK = /\b(?:sample|trailer|extra|bonus|deleted\.scene|behind\.the\.scenes)\b/i

// Patrones de episodio habituales en nombres de archivo:
//   S01E03 / s1e3 · 1x03 · Season.1.Episode.3 · Episodio.03 (absoluto)
function episodePatterns(season, episode) {
  const s = Number(season), e = Number(episode)
  if (!s || !e) return []
  const pad = String(e).padStart(2, '0')
  return [
    new RegExp(`s0*${s}[ ._-]*e0*${e}(?!\\d)`, 'i'),
    new RegExp(`\\b${s}x0*${e}(?!\\d)`, 'i'),
    new RegExp(`season[ ._-]*0*${s}[ ._-]*episode[ ._-]*0*${e}(?!\\d)`, 'i'),
    // Numeración absoluta cuando solo hay una temporada
    ...(s === 1 ? [
      new RegExp(`\\b(?:ep(?:isode)?|cap(?:itulo)?)[ ._-]*0*${e}(?!\\d)`, 'i'),
      new RegExp(`\\b0*${e}(?!\\d)\\s*-\\s*`, 'i'),
    ] : []),
  ]
}

// entries: [{ name, size, id? }]. Devuelve el subconjunto a usar (normalmente
// uno) o null si no hay ningún archivo de vídeo (el llamador decide: suele
// significar "selecciona todo" porque el torrent es raro).
export function pickTorrentEntries(entries, { season, episode } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null
  const videos = entries.filter(f => VIDEO_EXT.test(f.name || '') && !SAMPLE_JUNK.test(f.name || ''))
  if (!videos.length) return null

  const pats = episodePatterns(season, episode)
  if (pats.length) {
    const match = videos.filter(f => pats.some(p => p.test(f.name || '')))
    if (match.length) {
      // Si varios archivos matchean el episodio (mismo ep en dos calidades
      // dentro del pack), quédate con el de mayor tamaño.
      match.sort((a, b) => (b.size || 0) - (a.size || 0))
      return [match[0]]
    }
  }
  // Sin episodio pedido o sin coincidencia: el vídeo más grande.
  return [videos.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a))]
}
