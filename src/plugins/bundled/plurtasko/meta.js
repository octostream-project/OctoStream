// Helpers compartidos para detectar idioma y calidad de un stream a partir
// de textos (nombre del release, título de la página del embed, nombre del
// fichero en la URL) y del propio HTML de la página del proveedor.

// Detect audio/subtitle language from a free-text string (stream name, title,
// provider label or filename). Returns a short label or '' when unknown.
// Ordered from most to least specific so "(ESPSUB)" wins over "(ESP)" etc.
export function detectLangFromText(text) {
  if (!text) return ''
  const t = String(text)
  // Parenthesized tags first: "(LAT)", "(ESPSUB)", "[CAST]", "_vose_"
  const tag = t.match(/[\(\[\{_\-\s](LAT(?:INO)?|ESP(?:SUB)?|CAST|VOSE|SUBS?|SUBT(?:ITULAD[OA])?|ENG|JAP|JPN|CAT|DUAL|MULTI)[\)\]\}_\-\s]/i)
    || t.match(/^[\s\(\[_-]*(LAT(?:INO)?|ESP(?:SUB)?|CAST|VOSE|SUBS?|SUBT(?:ITULAD[OA])?|ENG|JAP|JPN|CAT|DUAL|MULTI)[\)\]_\-\s\.]/i)
  const c = (tag?.[1] || '').toUpperCase()
  if (c) {
    if (/^ESPSUB|VOSE|^SUB|^SUBT/.test(c)) return 'VOSE'
    if (/^ESP/.test(c)) return 'Esp'
    if (/^CAST/.test(c)) return 'Esp'
    if (/^LAT/.test(c)) return 'Lat'
    if (/^ENG/.test(c)) return 'Eng'
    if (/^JAP|^JPN/.test(c)) return 'Jap'
    if (/^CAT/.test(c)) return 'Cat'
    if (/^DUAL|^MULTI/.test(c)) return 'Dual'
  }
  // Word-level tokens anywhere in the text (filename dots/hyphens count as
  // boundaries): "movie.esp.1080p", "the-matrix-lat-dual", "serie castellano"
  if (/\b(vose|espsub|subtitulad[oa]|subtitulos|subs?)\b/i.test(t)) return 'VOSE'
  if (/\b(dual|multi(?:audio|lang)?)\b/i.test(t)) return 'Dual'
  if (/\b(castellano|cast|español|espanol|spanish|esp)\b/i.test(t)) return 'Esp'
  if (/\b(latino|latam|lat)\b/i.test(t)) return 'Lat'
  if (/\b(english|ingles|ingl[eé]s|eng)\b/i.test(t)) return 'Eng'
  if (/\b(japones|japon[eé]s|jap|jpn)\b/i.test(t)) return 'Jap'
  if (/\b(catal[aà]n?|cat)\b/i.test(t)) return 'Cat'
  return ''
}

// Normalize a language code/string to a short consistent label.
export function normalizeLang(lang) {
  if (!lang) return ''
  const l = lang.toLowerCase().trim()
  if (/vose|subtitulado|espsub|^subs?$|^subt|^en$|eng|english|\bv\.?o\.?s\.?e\b/.test(l)) return 'VOSE'
  if (/^dual$|^multi/.test(l)) return 'Dual'
  if (/esp|cast|spain|español|espanol|castellano|^es$/.test(l)) return 'Esp'
  if (/^lat$|latino|latam|sp-lat|^la$/.test(l)) return 'Lat'
  if (/jap|japon|^jp/.test(l)) return 'Jap'
  if (/^cat|catala|catalán/.test(l)) return 'Cat'
  // If it's already a short code, keep it
  if (['Esp', 'Lat', 'VOSE', 'Jap', 'Cat', 'Eng', 'Dual'].includes(lang)) return lang
  return lang
}

// Extract quality hints from a resolved video URL.
// m3u8/mp4 URLs often contain quality hints like "_720p", "_1080p", "1080", etc.
export function extractQualityFromUrl(url) {
  if (!url) return ''
  const u = url.toLowerCase()
  if (/4k|2160p|uhd/.test(u)) return '4K'
  if (/1080p|1080|fullhd|fhd/.test(u)) return '1080P'
  if (/720p|720|hd720/.test(u)) return '720P'
  if (/480p|480|sd/.test(u)) return '480P'
  // HLS master playlists contain multiple qualities - default to HD
  if (/master\.m3u8|index\.m3u8/i.test(u)) return 'HD'
  return ''
}

// Extract a quality label from free text (page titles, release names).
// "Movie.2024.1080p.BluRay.LATINO" → '1080P'; "cam"|"hdcam"|"telesync" → 'CAM'.
export function extractQualityFromText(text) {
  if (!text) return ''
  const t = String(text)
  if (/\b(2160p|4k|uhd)\b/i.test(t)) return '4K'
  if (/\b(1080p|1080i|fhd|full[\s._-]?hd)\b/i.test(t)) return '1080P'
  if (/\b(720p|720i|hd720)\b/i.test(t)) return '720P'
  if (/\b(576p|480p|sd)\b/i.test(t)) return '480P'
  if (/\b(hd[\s._-]?cam|cam[\s._-]?rip|telesync|\bts\b|hdtc|screener|scr)\b/i.test(t)) return 'CAM'
  if (/\b(hdrip|web[\s._-]?dl|webrip|hdtv|bluray|bdrip|brrip|hd)\b/i.test(t)) return 'HD'
  return ''
}

// Minimal HTML entity decoding for <title> texts.
// Entidades HTML en títulos de página (no se comparte con http.js: esa
// versión se mockea entera en los tests del resolver).
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

// Extract { title, lang, quality } from an embed page's HTML. Provider pages
// usually carry the real release name in <title>/og:title and language info
// in JSON fields like "video_language" — much more precise than guessing.
export function extractPageMeta(html, pageUrl = '') {
  if (!html || typeof html !== 'string') return null
  const meta = {}
  const titleM = html.match(/<title[^>]*>([^<]{3,250})<\/title>/i)
    || html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{3,250})["']/i)
    || html.match(/<meta[^>]+content=["']([^"']{3,250})["'][^>]+property=["']og:title["']/i)
  if (titleM) meta.title = decodeEntities(titleM[1]).trim()

  meta.lang = detectLangFromText(meta.title)
  if (!meta.lang) {
    const vl = html.match(/"video_language"\s*:\s*"([^"]{1,30})"/i)
      || html.match(/["'](?:lang|language|audio_language)["']\s*:\s*["']([^"']{1,30})["']/i)
    if (vl) meta.lang = normalizeLang(vl[1]) || detectLangFromText(vl[1])
  }
  meta.quality = extractQualityFromText(meta.title) || extractQualityFromUrl(pageUrl)
  return meta.title || meta.lang || meta.quality ? meta : null
}
