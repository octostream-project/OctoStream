// Inferencia de tipo de stream a partir de la URL final ya resuelta.
//
// Se usa en el boundary del player y tras resoluciones (embeds, debrid)
// porque el streamType del proveedor puede quedar obsoleto: un enlace
// desbloqueado por AllDebrid que apunta a un .mkv llegaba como 'hls' y
// ExoPlayer lo parseaba como playlist → error 3002 → fallback a WebView.

const HLS_RE = /\.m3u8([?#]|$)|\/manifest\.m3u8|\/master\.m3u8/i
const DASH_RE = /\.mpd([?#]|$)/i
const TORRENT_RE = /^magnet:|\.torrent([?#]|$)/i
const FILE_RE = /\.(mp4|mkv|avi|webm|mov|m4v|ts|mpg|mpeg|wmv|flv|3gp|m2ts)([?#]|$)/i
const DEBRID_RE = /download\.alldebrid\.com|alldebrid\.com\/d\/|\.debrid\.(it|al|com|cx|ee|is)\//i
const GOOGLEVIDEO_RE = /videoplayback/i

// Devuelve 'hls' | 'dash' | 'torrent' | 'mp4' según la URL, o `fallback`
// cuando la URL no permite deducir el contenedor (embeds opacos, CDNs sin
// extensión…). `fallback` respeta el streamType declarado por el proveedor.
export function inferStreamType(url, fallback = 'hls') {
  const u = String(url || '')
  if (!u) return fallback
  if (TORRENT_RE.test(u)) return 'torrent'
  if (DASH_RE.test(u)) return 'dash'
  if (HLS_RE.test(u)) return 'hls'
  if (FILE_RE.test(u) || DEBRID_RE.test(u) || GOOGLEVIDEO_RE.test(u)) return 'mp4'
  return fallback
}
