// Helpers de metadatos de streams extraídos de Details.jsx — la misma lógica
// la usan ahora la lista de fuentes (StreamList) y la ordenación por idioma.
import { inferStreamType } from './streamType.js'

// Extract language code from stream name like "vidhide (LAT)" or "HDFull Esp hd1080"
export function parseStreamLang(stream) {
  const fromText = (text) => {
    if (!text) return ''
    const t = String(text).toUpperCase()
    const m = t.match(/[()[{_\-\s](LAT(?:INO)?|ESP(?:SUB)?|CAST|VOSE|SUBS?|SUBT(?:ITULAD[OA])?|ENG|JAP|JPN|CAT|DUAL|MULTI)[)\]}_\-\s]/)
      || t.match(/^[\s()[_-]*(LAT(?:INO)?|ESP(?:SUB)?|CAST|VOSE|SUBS?|SUBT(?:ITULAD[OA])?|ENG|JAP|JPN|CAT|DUAL|MULTI)[)\]_\-\s.]/)
    const c = m?.[1] || ''
    if (c) {
      if (/^ESPSUB|^VOSE|^SUB/.test(c)) return 'SUB'
      if (/^ESP|^CAST/.test(c)) return 'ESP'
      if (/^LAT/.test(c)) return 'LAT'
      if (/^ENG/.test(c)) return 'ENG'
      if (/^JAP|^JPN/.test(c)) return 'JAP'
      if (/^CAT/.test(c)) return 'CAT'
      if (/^DUAL|^MULTI/.test(c)) return 'DUAL'
    }
    if (/\bVOSE\b|\bESPSUB\b|\bSUBT(ITULAD[OA]|ITULOS)?\b|\bSUBS?\b/.test(t)) return 'SUB'
    if (/\bDUAL\b|\bMULTI(AUDIO|LANG)?\b/.test(t)) return 'DUAL'
    if (/\bCASTELLANO\b|\bCAST\b|\bESPAÑOL\b|\bESPANOL\b|\bSPANISH\b|\bESP\b/.test(t)) return 'ESP'
    if (/\bLATINO\b|\bLATAM\b|\bLAT\b/.test(t)) return 'LAT'
    if (/\bENGLISH\b|\bINGLES\b|\bINGL[EÉ]S\b|\bENG\b/.test(t)) return 'ENG'
    if (/\bJAPON[EÉ]S\b|\bJAP\b|\bJPN\b/.test(t)) return 'JAP'
    if (/\bCATAL[AÀ]N?\b|\bCAT\b/.test(t)) return 'CAT'
    return ''
  }
  if (stream.lang) {
    const l = stream.lang.toUpperCase()
    if (l.includes('ESPSUB') || l.includes('VOSE') || l.includes('SUB')) return 'SUB'
    if (l.includes('ESP') || l.includes('CAST')) return 'ESP'
    if (l.includes('LAT')) return 'LAT'
    if (l.includes('DUAL') || l.includes('MULTI')) return 'DUAL'
    if (l.includes('ENG')) return 'ENG'
    if (l.includes('JAP') || l.includes('JPN')) return 'JAP'
    if (l.includes('CAT')) return 'CAT'
    return l
  }
  const fromName = fromText(stream.name) || fromText(stream.title)
  if (fromName) return fromName
  if (stream.url) {
    try {
      const file = decodeURIComponent(new URL(stream.url).pathname.split('/').pop() || '')
      const fromFile = fromText(file)
      if (fromFile) return fromFile
    } catch { /* URL malformada */ }
  }
  return ''
}

// Extract quality from stream name or field
export function parseStreamQuality(stream) {
  if (stream.quality) return stream.quality.toUpperCase()
  const name = (stream.name || '').toUpperCase()
  if (/4K|2160P/.test(name)) return '4K'
  if (/1080P|1080|FULLHD|FHD/.test(name)) return '1080P'
  if (/720P|720|HD/.test(name)) return '720P'
  if (/480P|480|DVD|RIP/.test(name)) return '480P'
  return ''
}

export function qualityColorClass(q) {
  if (!q) return 'bg-dark-600'
  if (q.includes('4K') || q.includes('2160')) return 'bg-purple-600'
  if (q.includes('1080') || q.includes('FULL')) return 'bg-green-600'
  if (q.includes('720') || q.includes('HD')) return 'bg-blue-600'
  if (q.includes('480') || q.includes('DVD') || q.includes('RIP')) return 'bg-yellow-600'
  return 'bg-dark-600'
}

export function langColorClass(lang) {
  if (lang === 'ESP' || lang === 'CAST') return 'text-green-400'
  if (lang === 'LAT') return 'text-blue-400'
  if (lang === 'SUB' || lang === 'VOSE') return 'text-yellow-400'
  if (lang === 'ENG') return 'text-orange-400'
  if (lang === 'DUAL') return 'text-purple-400'
  return 'text-dark-400'
}

// Get language priority from settings (default: ESP, LAT, SUB, ENG).
// Cacheada: antes leía localStorage + JSON.parse en cada llamada a sort.
let langPriorityCache = null
// Settings cambia 'octostream_lang_priority' sin recargar — sin invalidar,
// el orden nuevo no se aplicaba hasta reiniciar la app.
export function invalidateLangPriority() {
  langPriorityCache = null
}
function getLangPriority() {
  if (langPriorityCache) return langPriorityCache
  try {
    const saved = JSON.parse(localStorage.getItem('octostream_lang_priority') || '[]')
    if (Array.isArray(saved) && saved.length > 0) {
      langPriorityCache = saved
      return saved
    }
  } catch { /* JSON corrupto */ }
  langPriorityCache = ['ESP', 'LAT', 'DUAL', 'SUB', 'ENG']
  return langPriorityCache
}

// Sort streams by language priority. Streams with no language go last.
export function sortByLangPriority(streams) {
  if (!streams || streams.length === 0) return streams
  const priority = getLangPriority()
  const langRank = (stream) => {
    const lang = parseStreamLang(stream)
    if (!lang) return priority.length // no language = lowest priority
    const idx = priority.indexOf(lang)
    return idx === -1 ? priority.length : idx
  }
  return [...streams].sort((a, b) => langRank(a) - langRank(b))
}

// ─── Idioma por nombre de canal/emisora ─────────────────────────────────────
// Los agregadores deportivos (FCTV, DLive…) etiquetan sus fuentes con el
// nombre del canal — "Tod Arabic", "beIN Sports 🇫🇷", "Sky Sports (IT)".
// detectLangFromText solo conoce Esp/Lat/Eng/Jap/Cat; este mapa cubre los
// idiomas habituales de las retransmisiones internacionales.

const CHANNEL_FLAG_LANG = {
  '🇪🇸': 'Esp', '🇲🇽': 'Lat', '🇦🇷': 'Lat', '🇨🇴': 'Lat', '🇨🇱': 'Lat',
  '🇵🇪': 'Lat', '🇻🇪': 'Lat', '🇬🇧': 'Eng', '🇺🇸': 'Eng', '🇫🇷': 'Fra',
  '🇩🇪': 'Ale', '🇮🇹': 'Ita', '🇵🇹': 'Por', '🇧🇷': 'Por', '🇹🇷': 'Tur',
  '🇷🇺': 'Rus', '🇸🇦': 'Ara', '🇦🇪': 'Ara', '🇶🇦': 'Ara', '🇪🇬': 'Ara',
  '🇲🇦': 'Ara', '🇩🇿': 'Ara', '🇮🇳': 'Hin', '🇵🇱': 'Pol', '🇳🇱': 'Hol',
  '🇬🇷': 'Gre', '🇮🇱': 'Heb', '🇨🇳': 'Chi', '🇹🇼': 'Chi', '🇯🇵': 'Jap',
  '🇰🇷': 'Cor', '🇹🇭': 'Tai', '🇻🇳': 'Vie', '🇮🇩': 'Ind', '🇷🇴': 'Rum',
  '🇺🇦': 'Ucr', '🇨🇿': 'Che', '🇭🇺': 'Hun', '🇸🇪': 'Sue', '🇩🇰': 'Dan',
  '🇳🇴': 'Nor', '🇫🇮': 'Fin',
}
const CHANNEL_CC_LANG = {
  ES: 'Esp', MX: 'Lat', AR: 'Lat', CO: 'Lat', CL: 'Lat', PE: 'Lat',
  VE: 'Lat', US: 'Eng', GB: 'Eng', UK: 'Eng', EN: 'Eng', FR: 'Fra',
  DE: 'Ale', AT: 'Ale', CH: 'Ale', IT: 'Ita', PT: 'Por', BR: 'Por',
  TR: 'Tur', RU: 'Rus', SA: 'Ara', AE: 'Ara', QA: 'Ara', EG: 'Ara',
  MA: 'Ara', DZ: 'Ara', IN: 'Hin', PL: 'Pol', NL: 'Hol', GR: 'Gre',
  IL: 'Heb', CN: 'Chi', TW: 'Chi', JP: 'Jap', KR: 'Cor', TH: 'Tai',
  VN: 'Vie', ID: 'Ind', RO: 'Rum', UA: 'Ucr', CZ: 'Che', HU: 'Hun',
  SE: 'Sue', DK: 'Dan', NO: 'Nor', FI: 'Fin',
}
const CHANNEL_LANG_WORDS = [
  [/\b(spanish|español|espanol|castellano)\b/i, 'Esp'],
  [/\b(latino|latam)\b/i, 'Lat'],
  [/\b(english|ingles|ingl[eé]s)\b/i, 'Eng'],
  [/\b(french|fran[cç]ais)\b/i, 'Fra'],
  [/\b(arabic|[aá]rabe)\b/i, 'Ara'],
  [/\b(german|deutsch|alem[aá]n)\b/i, 'Ale'],
  [/\bitalian[oa]?\b/i, 'Ita'],
  [/\bportugu[eé]se?s?\b/i, 'Por'],
  [/\b(turkish|turco)\b/i, 'Tur'],
  [/\b(russian|ruso)\b/i, 'Rus'],
  [/\bhindi\b/i, 'Hin'],
  [/\b(polish|polaco)\b/i, 'Pol'],
  [/\b(dutch|holand[eé]s)\b/i, 'Hol'],
  [/\b(greek|griego)\b/i, 'Gre'],
  [/\b(hebrew|hebreo)\b/i, 'Heb'],
  [/\b(chinese|mandarin|chino)\b/i, 'Chi'],
  [/\b(korean|coreano)\b/i, 'Cor'],
  [/\b(japanese|japon[eé]s)\b/i, 'Jap'],
  [/\bvietnamese\b/i, 'Vie'],
  [/\bthai\b/i, 'Tai'],
  [/\bindonesian\b/i, 'Ind'],
  [/\b(romanian|rumano)\b/i, 'Rum'],
  [/\bukrainian\b/i, 'Ucr'],
]

// Idioma declarado por el propio nombre del canal/emisora. Orden: banderas
// emoji (dos distintas → Dual) → palabra de idioma → código de país al
// final "(ES)", "- IT". '' si no se puede saber.
export function langFromChannelLabel(text) {
  const t = String(text || '')
  if (!t) return ''
  const flags = t.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []
  const flangs = [...new Set(flags.map(f => CHANNEL_FLAG_LANG[f]).filter(Boolean))]
  if (flangs.length > 1) return 'Dual'
  if (flangs.length) return flangs[0]
  for (const [re, lang] of CHANNEL_LANG_WORDS) if (re.test(t)) return lang
  const cc = t.match(/\(([A-Za-z]{2})\)\s*$/) || t.match(/[\s\-|]([A-Z]{2})\s*$/)
  if (cc) return CHANNEL_CC_LANG[cc[1].toUpperCase()] || ''
  return ''
}

// Directo descargable: mp4/mkv progresivo o enlace debrid (se desbloquea a
// directo). HLS/DASH/embed/torrent no son descarga de archivo simple.
export function isDownloadableDirect(stream) {
  if (!stream?.url) return false
  if (stream.streamType === 'debrid') return true
  if (stream.streamType === 'torrent' || stream.streamType === 'embed'
      || stream.streamType === 'hls' || stream.streamType === 'dash') return false
  if (/\.m3u8([?#]|$)|\.mpd([?#]|$)/i.test(stream.url)) return false
  return stream.streamType === 'mp4' || inferStreamType(stream.url, '') === 'mp4'
}
