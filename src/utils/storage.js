const isElectron = () => typeof window !== 'undefined' && window.octo?.platform === 'electron'

export async function getItem(key) {
  if (isElectron()) {
    try {
      const value = await window.octo.getData(key)
      return value
    } catch (e) {
      console.warn('[Storage] electron get failed', e)
    }
  }
  try {
    const value = localStorage.getItem(key)
    return value
  } catch {
    return null
  }
}

export async function setItem(key, value) {
  if (isElectron()) {
    try {
      await window.octo.setData(key, value)
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
      await window.octo.removeData(key)
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
    window.octo.setData(key, value).catch(() => {})
  }
}

export function removeItemSync(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  if (isElectron()) {
    window.octo.removeData(key).catch(() => {})
  }
}

export async function syncFromElectron() {
  if (!isElectron()) return
  try {
    const keys = ['octo_installed_plugins', 'octo_custom_plugins', 'octo_language', 'octo_favorites', 'octo_history', 'octo_search_history', 'octo_tmdb_key', 'octo_opensubs_apikey', 'octo_screensaver_enabled', 'octo_screensaver_timeout', 'octo_sub_lang', 'octo_auto_subs', 'octo_player_engine', 'octo_default_quality', 'octo_hw_accel', 'octo_seek_secs', 'octo_buffer_size', 'octo_default_speed', 'octo_show_player_clock', 'octo_image_quality', 'octo_home_items_limit', 'octo_dark_mode', 'octo_audio_lang', 'octo_auto_skip_intro', 'octo_auto_skip_recap', 'octo_confirm_exit_player', 'octo_auto_next_episode']
    for (const key of keys) {
      const value = await window.octo.getData(key)
      if (value !== null && value !== undefined) {
        localStorage.setItem(key, value)
      }
    }
  } catch (e) {
    console.warn('[Storage] sync from electron failed', e)
  }
}
