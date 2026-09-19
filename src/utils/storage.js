// Cross-platform storage abstraction.
// On Electron, mirrors localStorage to the Electron main process via IPC.
// On web/Android, uses localStorage directly.
// All functions are safe to call at module load time (no top-level access).

const isElectron = () =>
  typeof window !== 'undefined' && window.octostream?.platform === 'electron'

// Migración única: renombra claves antiguas (optopus_*/octo_*) a octostream_*.
// Copia el valor a la clave nueva (sin pisarla si ya existe) y borra la vieja.
try {
  if (typeof localStorage !== 'undefined') {
    const renames = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('optopus_')) renames.push([k, 'octostream_' + k.slice(8)])
      else if (k?.startsWith('octo_')) renames.push([k, 'octostream_' + k.slice(5)])
    }
    for (const [oldKey, newKey] of renames) {
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(oldKey)
        if (v !== null) localStorage.setItem(newKey, v)
      }
      localStorage.removeItem(oldKey)
    }
  }
} catch {
  // ignore
}

// Keys that are mirrored between Electron persistent storage and localStorage.
const SYNCED_KEYS = [
  'octostream_installed_plugins',
  'octostream_custom_plugins',
  'octostream_language',
  'octostream_favorites',
  'octostream_history',
  'octostream_search_history',
  'octostream_tmdb_key',
  'octostream_opensubs_apikey',
  'octostream_screensaver_enabled',
  'octostream_screensaver_timeout',
  'octostream_sub_lang',
  'octostream_auto_subs',
  'octostream_player_engine',
  'octostream_default_quality',
  'octostream_hw_accel',
  'octostream_seek_secs',
  'octostream_buffer_size',
  'octostream_default_speed',
  'octostream_show_player_clock',
  'octostream_image_quality',
  'octostream_home_items_limit',
  'octostream_dark_mode',
  'octostream_audio_lang',
  'octostream_auto_skip_intro',
  'octostream_auto_skip_recap',
  'octostream_confirm_exit_player',
  'octostream_auto_next_episode',
  'octostream_external_plugins',
  'octostream_recent_searches',
  'octostream_tdspain_cache',
  'octostream_youtube_search_history',
]

export async function getItem(key) {
  if (isElectron()) {
    try {
      const value = await window.octostream.getData(key)
      if (value !== null && value !== undefined) return value
    } catch (e) {
      console.warn('[Storage] electron get failed', e)
    }
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function setItem(key, value) {
  if (isElectron()) {
    try {
      await window.octostream.setData(key, value)
    } catch (e) {
      console.warn('[Storage] electron set failed', e)
    }
  }
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export async function removeItem(key) {
  if (isElectron()) {
    try {
      await window.octostream.removeData(key)
    } catch (e) {
      console.warn('[Storage] electron remove failed', e)
    }
  }
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function getItemSync(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function setItemSync(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
  if (isElectron()) {
    window.octostream.setData(key, value).catch(() => {})
  }
}

export function removeItemSync(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  if (isElectron()) {
    window.octostream.removeData(key).catch(() => {})
  }
}

/**
 * Get a JSON-parsed value from storage, with a fallback default.
 */
export async function getJson(key, fallback = null) {
  const raw = await getItem(key)
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Serialize and store a JSON value.
 */
export async function setJson(key, value) {
  try {
    await setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

/**
 * Synchronous JSON getter with fallback.
 */
export function getJsonSync(key, fallback = null) {
  const raw = getItemSync(key)
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Synchronous JSON setter.
 */
export function setJsonSync(key, value) {
  try {
    setItemSync(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

/**
 * Mirror all known keys from Electron persistent storage into localStorage.
 * Called once at app startup on Electron.
 */
export async function syncFromElectron() {
  if (!isElectron()) return
  try {
    for (const key of SYNCED_KEYS) {
      const value = await window.octostream.getData(key)
      if (value !== null && value !== undefined) {
        localStorage.setItem(key, value)
      }
    }
  } catch (e) {
    console.warn('[Storage] sync from electron failed', e)
  }
}

export { SYNCED_KEYS }
