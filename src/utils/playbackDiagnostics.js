const SECRET_PARAM_RE = /(^|[?&])((?:token|key|auth|sig|signature|cookie|authorization|session|expires)=)[^&#\s]*/gi
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi

export function sanitizePlaybackError(value) {
  return String(value || 'Error de reproducción')
    .replace(URL_RE, '[enlace oculto]')
    .replace(SECRET_PARAM_RE, '$1$2[oculto]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export function playbackHelpForError(value) {
  const message = String(value || '').toLowerCase()
  if (/403|401|forbidden|unauthorized|http.*status/.test(message)) {
    return 'El servidor rechazó el enlace. Puede haber caducado o requerir otra fuente; prueba otra opción.'
  }
  if (/404|not found|no encontrado/.test(message)) {
    return 'El archivo o canal ya no está disponible en ese servidor. Prueba otra fuente.'
  }
  if (/drm|widevine|license|licencia/.test(message)) {
    return 'Falló la licencia protegida. Comprueba que el contenido y el dispositivo admitan Widevine.'
  }
  if (/decoder|codec|decod|format|formato|unsupported/.test(message)) {
    return 'El dispositivo no pudo decodificar este formato. Prueba otra calidad, pista de audio o fuente.'
  }
  if (/timeout|timed out|network|connection|conexi[oó]n|internet|warp/.test(message)) {
    return 'No se pudo conectar con el servidor a tiempo. Comprueba la conexión y el estado del proxy/VPN.'
  }
  return 'La fuente no pudo reproducirse. Prueba otra fuente o vuelve a intentarlo más tarde.'
}
