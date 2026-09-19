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
