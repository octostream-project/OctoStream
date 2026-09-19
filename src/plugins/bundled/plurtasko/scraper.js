// Shared scraping utilities for Plurtasko channels.
// Lightweight regex helpers for scraping.

import { detectLangFromText } from './meta.js'

// Find first regex match in text. Returns '' if not found.
// Accepts a raw string or a previous match array (uses capture group 1).
// The 's' flag lets .?* span newlines — all channel patterns are non-greedy.
export function findSingleMatch(text, pattern) {
  try {
    if (Array.isArray(text)) text = text[1] ?? text[0] ?? ''
    if (typeof text !== 'string') return ''
    const re = new RegExp(pattern, 'is')
    const m = text.match(re)
    return m ? (m.length > 1 ? (m[1] ?? '') : (m[0] ?? '')) : ''
  } catch {
    return ''
  }
}

// Find all matches of a regex pattern. Returns array of full match arrays.
export function findMultipleMatches(text, pattern) {
  try {
    if (typeof text !== 'string') return []
    const re = new RegExp(pattern, 'gis')
    const results = []
    let m
    while ((m = re.exec(text)) !== null) {
      results.push(m)
    }
    return results
  } catch {
    return []
  }
}

// Extract year from a title like "Movie Name (2024)".
export function extractYear(title) {
  const m = title.match(/^(.*?)\((\d{4})\)\s*$/)
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) }
  return { title, year: null }
}

// Determine content type from URL path.
export function detectType(url) {
  if (/\/serie\//.test(url) || /\/animes?\//.test(url) || /\/series\//.test(url) || /\/doramas?\//.test(url)) return 'series'
  if (/\/pelicula\//.test(url) || /\/movie\//.test(url)) return 'movie'
  return 'movie'
}

// Normalize a server name from Plurtasko/Alfa to a stream type.
export function normalizeServer(server) {
  const s = (server || '').toLowerCase().trim()
  if (!s) return 'embed'
  const map = {
    'voe': 'embed', 'maxplay': 'embed',
    'doos': 'embed', 'dood': 'embed', 'doodstream': 'embed',
    'd0o0d': 'embed', 'do0od': 'embed', 'd0000d': 'embed', 'd000d': 'embed',
    'ok': 'embed', 'okru': 'embed',
    'netu': 'embed', 'hqq': 'embed', 'waaw': 'embed',
    'google': 'mp4', 'drive': 'mp4', 'google drive': 'mp4', 'gvideo': 'mp4',
    'mega': 'embed', 'streamtape': 'embed', 'streamwish': 'embed',
    'hlswish': 'embed', 'fembed': 'embed', 'filemoon': 'embed',
    'upstream': 'embed', 'mixdrop': 'embed', 'voe.sx': 'embed',
    'directo': 'mp4', 'torrent': 'torrent',
  }
  return map[s] || 'embed'
}

// Detecta el servidor/hoster a partir de la URL del embed o vídeo.
// Fallback 'embed' — la UI lo trata como "servidor desconocido".
export function detectServerFromUrl(url) {
  const u = (url || '').toLowerCase()
  if (/voe\.|eugenemakedraw|morencius/.test(u)) return 'voe'
  if (/streamwish|hglink|hanerix|audinifer/.test(u)) return 'streamwish'
  if (/dood|do0od|d000d/.test(u)) return 'doodstream'
  if (/streamtape|streamta\.pe/.test(u)) return 'streamtape'
  if (/filemoon|filelions/.test(u)) return 'filemoon'
  if (/mixdrop/.test(u)) return 'mixdrop'
  if (/upstream/.test(u)) return 'upstream'
  if (/uqload/.test(u)) return 'uqload'
  if (/fastream/.test(u)) return 'fastream'
  if (/ok\.ru|okru/.test(u)) return 'okru'
  if (/mp4upload/.test(u)) return 'mp4upload'
  if (/vidmoly/.test(u)) return 'vidmoly'
  if (/lulustream|lulu/.test(u)) return 'lulustream'
  if (/maxstream/.test(u)) return 'maxstream'
  if (/vidoza/.test(u)) return 'vidoza'
  if (/supervideo/.test(u)) return 'supervideo'
  if (/fastplay/.test(u)) return 'fastplay'
  if (/turbovid/.test(u)) return 'turbovid'
  if (/sendvid/.test(u)) return 'sendvid'
  if (/dr0pstream|dropstream/.test(u)) return 'dropstream'
  if (/youtube|youtu\.be/.test(u)) return 'youtube'
  if (/mega\.nz/.test(u)) return 'mega'
  if (/vimeo/.test(u)) return 'vimeo'
  if (/dailymotion|dai\.ly/.test(u)) return 'dailymotion'
  if (/rumble/.test(u)) return 'rumble'
  if (/vk\.com|vk\.me/.test(u)) return 'vk'
  return 'embed'
}

// Hex→string: algunos embeds ofuscan la URL del player en atributos con hex.
export function hex2a(hex) {
  let str = ''
  for (let i = 0; i + 1 < hex.length; i += 2) str += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  return str
}

// Nombre base de una página torrent: quita "- 1ª Temporada"/"- Temporada 1",
// "[720p]", "(4K)"… Devuelve { base, season } — season null si no la declara.
export function baseTitle(fullTitle) {
  const seasonM = fullTitle.match(/(\d+)\s*ª?\s*temporada/i) || fullTitle.match(/temporada\s*(\d+)/i)
  const base = fullTitle
    .replace(/\s*[-–—]?\s*\d+\s*ª?\s*temporada.*$/i, '')
    .replace(/\s*[-–—]?\s*temporada\s*\d+.*$/i, '')
    .replace(/\s*[\[(][^\])]*[\])]\s*\.?\s*$/, '')
    .replace(/[\s.]+$/, '')
    .trim()
  return { base: base || fullTitle, season: seasonM ? parseInt(seasonM[1], 10) : null }
}

// URL de página de serie en los sitios torrent (ruta /series/).
export const isSerieUrl = (url) => /\/series\//.test(url)

// Shape de stream compartido por los canales torrent (grantorrent, subtorrents…)
export function makeTorrentStream(provider, torrentUrl, quality, title) {
  const file = decodeURIComponent(torrentUrl.split('/').pop() || '')
  const label = title || file.replace(/\.torrent$/i, '')
  // El idioma se detecta del nombre del release (LATINO/Castellano/VOSE…);
  // sin pista queda sin etiqueta en vez de asumir un idioma.
  const lang = detectLangFromText(`${label} ${file}`)
  return {
    name: `${provider}${lang ? ` (${lang})` : ''} ${quality || 'HD'}`,
    url: torrentUrl,
    streamType: 'torrent',
    quality: quality || 'HD',
    server: provider,
    lang,
    title: label,
    pluginName: provider,
    pluginId: 'plurtasko',
  }
}
