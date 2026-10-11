const ALLOWED_PROTOCOLS = ['http:', 'https:', 'vlc:', 'mpv:', 'magnet:', 'data:', 'blob:', 'cast:']
const REMOTE_ALLOWED_PROTOCOLS = ['http:', 'https:']

export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return ''
    return url
  } catch {
    return ''
  }
}

// URLs recibidas por la red (remote play, cast) solo pueden ser http(s):
// nunca data:/blob:/file: ni esquemas de apps externas.
export function sanitizeRemoteUrl(url) {
  if (!url || typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    if (!REMOTE_ALLOWED_PROTOCOLS.includes(parsed.protocol)) return ''
    if (parsed.username || parsed.password) return ''
    return url
  } catch {
    return ''
  }
}

export function isSafeUrl(url) {
  return !!sanitizeUrl(url)
}

// URLs entregadas a plugins nativos (ExoPlayer, embed WebViews, relay): solo
// http/https — el lado nativo las rechaza igualmente, pero cortar aquí evita
// que un stream malicioso empuje data:/vlc:/magnet: hasta la capa nativa.
// A diferencia de sanitizeRemoteUrl NO se rechazan credenciales: algunos
// proveedores IPTV incrustan user:pass@ en la URL de stream.
export function sanitizeHttpUrl(url) {
  if (!url || typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    if (!REMOTE_ALLOWED_PROTOCOLS.includes(parsed.protocol)) return ''
    return url
  } catch {
    return ''
  }
}
