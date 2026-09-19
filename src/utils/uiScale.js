// Escala de interfaz: ajusta el font-size raíz → todos los rem de Tailwind
// escalan juntos. Pensado para boxes/TV donde el WebView reporta un viewport
// CSS grande y la UI queda pequeña, o al revés.
import { isAndroidNative, isAndroidTv } from './platform.js'
import { getItemSync, setItemSync } from './storage.js'

const KEY = 'octostream_ui_scale' // entero 80-200 (%), '' = auto

export function getUiScale() {
  try {
    const v = parseInt(getItemSync(KEY) || '', 10)
    if (v >= 80 && v <= 200) return v
  } catch {}
  return 0 // auto
}

// Auto: en TV/boxes (sin pantalla táctil) el viewport CSS suele ser amplio y
// la UI queda pequeña — escalar proporcional al ancho respecto a ~1150px de
// referencia, con un suelo del 115% porque en TV siempre sienta bien algo más.
function autoScale() {
  if (!isAndroidNative()) return 100
  const looksLikeTv = isAndroidTv() || (navigator.maxTouchPoints === 0 && screen.width >= 960)
  if (!looksLikeTv) return 100
  const vw = window.innerWidth || screen.width
  return Math.min(165, Math.max(115, Math.round((vw / 1150) * 100)))
}

export function applyUiScale() {
  const pct = getUiScale() || autoScale()
  document.documentElement.style.fontSize = `${(16 * pct) / 100}px`
  return pct
}

export function setUiScale(pct) {
  if (!pct || pct < 80 || pct > 200) {
    setItemSync(KEY, '')
  } else {
    setItemSync(KEY, String(Math.round(pct)))
  }
  return applyUiScale()
}
