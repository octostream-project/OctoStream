// Estilo de subtítulos compartido: se guarda en `octostream_sub_style` y se
// aplica al SubtitleView nativo (Android) o a propiedades de mpv (Electron).
// Se empuja al arrancar la reproducción y al cambiarlo en Ajustes — así el
// cambio se ve en caliente si hay algo sonando.

import { ExoPlayer } from '@octostream/exo-player'
import { isAndroidNative, isElectron } from './platform.js'
import { getJsonSync, setJsonSync } from './storage.js'

const KEY = 'octostream_sub_style'

// scale = factor sobre el tamaño base; color/bg '#RRGGBB'/'#AARRGGBB';
// bottom = fracción del alto de pantalla desde abajo (0 = pegado abajo).
const DEFAULTS = { scale: 1.0, color: '#FFFFFF', bg: '#80000000', bottom: 0.05 }

export function getSubStyle() {
  return { ...DEFAULTS, ...(getJsonSync(KEY) || {}) }
}

export function saveSubStyle(style) {
  setJsonSync(KEY, { ...getSubStyle(), ...style })
  pushSubStyle()
}

/** Empuja el estilo guardado al reproductor activo (si lo hay). */
export function pushSubStyle() {
  const s = getSubStyle()
  if (isAndroidNative()) {
    ExoPlayer.setSubtitleStyle({
      scale: s.scale, color: s.color, bg: s.bg, bottom: s.bottom,
    }).catch(() => {})
    return
  }
  // Electron/mpv: sub-scale (0-100), sub-color/#AARRGGBB, sub-back-color,
  // sub-pos (0-100, posición vertical desde arriba; 100 = abajo).
  if (isElectron()) {
    const toAarrggbb = hex => {
      const h = String(hex || '').replace('#', '')
      return h.length === 8 ? `#${h}` : `#FF${h.padEnd(6, '0')}`
    }
    window.octostream?.player?.subStyle?.({
      scale: s.scale,
      color: toAarrggbb(s.color),
      backColor: toAarrggbb(s.bg),
      // bottom(0-0.4) → sub-pos(100-60): 0.05 ≈ 95, 0.16 ≈ 84, 0.30 ≈ 70
      pos: Math.round(100 - s.bottom * 100),
    })
  }
}
