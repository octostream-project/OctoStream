// Backup de configuración: exporta claves octostream_* de localStorage a un
// JSON (favoritos, historial, ajustes, claves debrid/TMDB, tokens de
// emparejamiento LAN, posiciones de archivos locales…) y las restaura desde
// otro backup. El usuario elige qué secciones incluir/restaurar.
// En Android va por SAF (Guardar como / Abrir); en web/Electron cae a
// descarga por blob + <input type=file>.

import { isAndroidNative } from './platform.js'
import { ExoPlayer } from '@octostream/exo-player'
import { sshCredsForTransfer, applyReceivedSshCreds } from './sshCreds.js'

const PREFIX = 'octostream_'
const BACKUP_NAME = 'octostream-backup.json'

// Secciones seleccionables del backup. `keys` casa exacto; `prefixes` casa
// por prefijo (posiciones localpos_<ruta>, credenciales aiostreams_*/trakt_*).
// Lo que no encaje en ninguna sección cae en 'settings'.
export const BACKUP_CATEGORIES = [
  {
    id: 'lists',
    label: 'Favoritos y Mi lista',
    keys: ['octostream_favorites', 'octostream_watchlist'],
    prefixes: [],
  },
  {
    id: 'history',
    label: 'Historial y progreso',
    keys: [
      'octostream_history',
      'octostream_watched_episodes',
      'octostream_search_history',
      'octostream_recent_searches',
      'octostream_youtube_search_history',
      'octostream_youtube_live_search_history',
    ],
    prefixes: ['octostream_localpos_'],
  },
  {
    id: 'accounts',
    label: 'Cuentas y claves',
    keys: [
      'octostream_alldebrid_key',
      'octostream_tmdb_key',
      'octostream_opensubs_apikey',
      'octostream_mdblist_key',
      'octostream_hdfull_username',
      'octostream_hdfull_password',
      'octostream_pair_tokens',
      // Acceso al VPS (host + SSH): viaja con las cuentas — en Android la
      // clave se inyecta desde el Keystore en exportSettings/localSyncPayload.
      'octostream_warp_remote',
      'octostream_warp_ssh_user',
      'octostream_warp_ssh_pass',
      'octostream_warp_ssh_port',
    ],
    prefixes: ['octostream_aiostreams_', 'octostream_trakt_'],
  },
  {
    id: 'settings',
    label: 'Ajustes de la app',
    keys: [],
    prefixes: [],
  },
]

export const ALL_CATEGORIES = BACKUP_CATEGORIES.map(c => c.id)

export function categoryOf(key) {
  for (const cat of BACKUP_CATEGORIES) {
    if (cat.id === 'settings') continue
    if (cat.keys.includes(key)) return cat.id
    if (cat.prefixes.some(p => key.startsWith(p))) return cat.id
  }
  return 'settings'
}

function storageKeys() {
  const keys = []
  for (let i = 0; i < (localStorage.length || 0); i++) {
    const k = localStorage.key(i)
    if (k) keys.push(k)
  }
  // El mock de Vitest no implementa length/key — fallback por propiedades.
  if (!keys.length && typeof localStorage === 'object') keys.push(...Object.keys(localStorage))
  return keys
}

export function collectSettings(categories, excludedKeys = null) {
  const wanted = categories ? new Set(categories) : null
  const settings = {}
  for (const k of storageKeys()) {
    if (!k?.startsWith(PREFIX) || excludedKeys?.has(k)) continue
    if (wanted && !wanted.has(categoryOf(k))) continue
    settings[k] = localStorage.getItem(k)
  }
  return settings
}

function buildBackup(categories, extraSettings = null) {
  return JSON.stringify({
    app: 'octostream',
    kind: 'settings-backup',
    version: 1,
    sections: categories || ALL_CATEGORIES,
    exportedAt: new Date().toISOString(),
    settings: { ...collectSettings(categories), ...(extraSettings || {}) },
  }, null, 2)
}

/**
 * Exporta la configuración. `categories` limita las secciones incluidas
 * (por defecto todas). Devuelve true si el usuario completó el guardado.
 */
export async function exportSettings(categories = null) {
  // La clave SSH del VPS no vive en localStorage en Android (Keystore):
  // se pide al plugin para que viaje con las demás cuentas.
  const extra = (!categories || categories.includes('accounts'))
    ? await sshCredsForTransfer() : null
  const content = buildBackup(categories, extra)
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
 * Importa una configuración desde un backup. `categories` limita qué
 * secciones se restauran (por defecto todas). Devuelve el nº de claves
 * restauradas, 0 si el usuario canceló. Lanza si el JSON no es un backup.
 */
export async function importSettings(categories = null) {
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
  const wanted = categories ? new Set(categories) : null
  let count = 0
  for (const [k, v] of Object.entries(data.settings)) {
    if (!k.startsWith(PREFIX) || typeof v !== 'string') continue
    if (wanted && !wanted.has(categoryOf(k))) continue
    localStorage.setItem(k, v)
    count++
  }
  // En Android la clave SSH recién restaurada sube al Keystore del plugin.
  await applyReceivedSshCreds()
  return count
}
