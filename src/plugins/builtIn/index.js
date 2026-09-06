// Official built-in plugins (Kodi-style repository).
// These plugins ship with the app and can be enabled/disabled by the user.

import { tmdbPlugin } from '../tmdb.js'
import { repelisPlugin } from '../repelis.js'
import { plurtaskoPlugin } from '../plurtasko.js'
import { plurtaskoLocalPlugin } from '../plurtaskoLocal.js'
import { liveTvPlugin } from '../liveTv.js'
import { tdtPlugin } from '../tdt.js'
import { cinemetaPlugin } from '../cinemeta.js'
import { embedStreamPlugin } from '../embedStream.js'
import { openSubtitlesPlugin } from '../openSubtitles.js'
import { screensaverPlugin } from '../screensaver.js'
import { sampleMoviesPlugin } from '../sampleMovies.js'
import { sampleSeriesPlugin } from '../sampleSeries.js'

export const builtInPlugins = [
  tmdbPlugin,
  repelisPlugin,
  plurtaskoPlugin,
  plurtaskoLocalPlugin,
  cinemetaPlugin,
  liveTvPlugin,
  tdtPlugin,
  embedStreamPlugin,
  openSubtitlesPlugin,
  screensaverPlugin,
  sampleMoviesPlugin,
  sampleSeriesPlugin,
]

export function getBuiltInPlugin(pluginId) {
  return builtInPlugins.find(p => p.id === pluginId) || null
}

export function isBuiltInPlugin(pluginId) {
  return builtInPlugins.some(p => p.id === pluginId)
}
