// Backup de configuración: exporta todas las claves octostream_* de
// localStorage a un JSON (favoritos, historial, ajustes, claves debrid/TMDB,
// tokens de emparejamiento LAN, posiciones de archivos locales…) y las
// restaura desde otro backup. En Android va por SAF (Guardar como / Abrir);
// en web/Electron cae a descarga por blob + <input type=file>.

import { isAndroidNative } from './platform.js'
import { ExoPlayer } from '@octostream/exo-player'

const PREFIX = 'octostream_'
const BACKUP_NAME = 'octostream-backup.json'

function collectSettings() {
  const settings = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) settings[k] = localStorage.getItem(k)
  }
  return settings
}

function buildBackup() {
  return JSON.stringify({
    app: 'octostream',
    kind: 'settings-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: collectSettings(),
  }, null, 2)
}

/** Exporta la configuración. Devuelve true si el usuario completó el guardado. */
export async function exportSettings() {
  const content = buildBackup()
  if (isAndroidNative()) {
    try {
      const r = await ExoPlayer.exportConfig({ filename: BACKUP_NAME, content })
      return r?.saved === true
    } catch (e) {
      if (e?.message === 'cancelled') return false
      throw e
    }
  }
  // Web/Electron: descarga por blob (Chromium la deja en Descargas).
  const blob = new Blob([content], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = BACKUP_NAME
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  return true
}

function readBackupText() {
  if (isAndroidNative()) {
    return ExoPlayer.importConfig().then(r => r?.content ?? null)
  }
  // Web/Electron: input file clásico.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      try { resolve(await f.text()) } catch { resolve(null) }
    }
    // Algunos navegadores disparan cancel; no hay evento fiable — si no
    // elige nada, la promesa queda pendiente sin daño (modal se cierra).
    input.click()
  })
}

/**
 * Importa una configuración desde un backup. Devuelve el nº de claves
 * restauradas, 0 si el usuario canceló. Lanza si el JSON no es un backup.
 */
export async function importSettings() {
  let text
  try {
    text = await readBackupText()
  } catch (e) {
    if (e?.message === 'cancelled') return 0
    throw e
  }
  if (!text) return 0

  let data
  try { data = JSON.parse(text) } catch { throw new Error('El archivo no es un JSON válido') }
  if (data?.app !== 'octostream' || data?.kind !== 'settings-backup' || typeof data.settings !== 'object' || !data.settings) {
    throw new Error('El archivo no es una copia de OctoStream')
  }
  let count = 0
  for (const [k, v] of Object.entries(data.settings)) {
    if (!k.startsWith(PREFIX) || typeof v !== 'string') continue
    localStorage.setItem(k, v)
    count++
  }
  return count
}
