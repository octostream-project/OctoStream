// Official built-in plugins.
// These plugins ship with the app and can be enabled/disabled by the user.

import { tmdbPlugin } from './tmdb.js'
import { embedStreamPlugin } from './embedStream.js'
import { openSubtitlesPlugin } from './openSubtitles.js'
import { screensaverPlugin } from './screensaver.js'

export const builtInPlugins = [
  tmdbPlugin,
  embedStreamPlugin,
  openSubtitlesPlugin,
  screensaverPlugin,
]

export {
  tmdbPlugin,
  embedStreamPlugin,
  openSubtitlesPlugin,
  screensaverPlugin,
}

export function getBuiltInPlugin(pluginId) {
  return builtInPlugins.find(p => p.id === pluginId) || null
}

export function isBuiltInPlugin(pluginId) {
  return builtInPlugins.some(p => p.id === pluginId)
}
