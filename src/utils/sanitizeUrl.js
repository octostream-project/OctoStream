const ALLOWED_PROTOCOLS = ['http:', 'https:', 'vlc:', 'mpv:', 'magnet:', 'data:', 'blob:', 'cast:']

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

export function isSafeUrl(url) {
  return !!sanitizeUrl(url)
}
