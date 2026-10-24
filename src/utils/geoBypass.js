// Lista canónica de hosts que DEBEN salir por la red física: geobloqueo
// regional o URLs firmadas ligadas a la IP que resuelve (error "opened on
// a different connection" si resuelven por WARP y reproducen directo).
// La MISMA lista vive duplicada en dos sitios que JS no puede importar:
//   - capacitor-plugins/cloud-proxy/android/.../CloudProxyPlugin.java
//     (GEO_HOST + http.nonProxyHosts + ProxyConfig bypass rules)
//   - electron/main.cjs (AETHER_BYPASS_SUFFIX + AETHER_BYPASS_CHROMIUM)
// src/utils/geoBypass.test.js verifica que las tres copias no deriven.
export const GEO_BYPASS_HOSTS = [
  'tdtspain.com',
  'tdtchannels.com',
  'rtve.es',
  'mediaset.net',
  'mediasetinfinity.es',
  'atresplayer.com',
  'atresmedia.com',
  'dai.google.com',
  'doubleclick.net',
]

const esc = h => h.replace(/\./g, '\\.')
export const GEO_HOST_RE = new RegExp(
  `(^|\\.)(${GEO_BYPASS_HOSTS.map(esc).join('|')})$`,
  'i'
)

export function isGeoBypassHost(url) {
  try { return GEO_HOST_RE.test(new URL(url).hostname) } catch { return false }
}
