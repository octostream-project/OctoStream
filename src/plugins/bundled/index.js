// Registry of bundled external plugins.
// These plugins are installed from an external manifest JSON but their
// implementation is bundled inside the app (no external server required).
//
// To add a new bundled plugin:
// 1. Create the implementation in ./myPlugin.js
// 2. Export a factory function that receives the config and returns a Plugin
// 3. Register it in the bundledPlugins map below

import { bundledPlugins as tdtChannelsPlugins } from './tdtChannels.js'
import { tdtSpainFactory } from './tdtSpain.js'

export const bundledPlugins = {
  ...tdtChannelsPlugins,
  tdtspain: tdtSpainFactory,
}

export function getBundledPlugin(pluginId) {
  return bundledPlugins[pluginId] || null
}

export function isBundledPlugin(config) {
  const manifest = config.manifest || config
  return manifest.bundled === true || config.bundled === true
}
