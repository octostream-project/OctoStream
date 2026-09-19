// Registry of bundled external plugins.
// These plugins are installed from an external manifest JSON but their
// implementation is bundled inside the app (no external server required).
//
// To add a new bundled plugin:
// 1. Create the implementation in ./myPlugin.js
// 2. Export a factory function that receives the config and returns a Plugin
// 3. Register it in the bundledPlugins map below
//
// Las factories se cargan con import() dinámico: cada plugin bundled va en su
// propio chunk y no se parsea/ejecuta hasta que el PluginManager lo necesita,
// en vez de inflar el bundle principal en el arranque.

const bundledLoaders = {
  tdtspain: () => import('./tdtSpain/index.js').then(m => m.tdtSpainFactory),
  plurtasko: () => import('./plurtasko/index.js').then(m => m.plurtaskoFactory),
  anilist: () => import('./kitsu/index.js').then(m => m.kitsuFactory),
  fctv: () => import('./fctv/index.js').then(m => m.fctvFactory),
  dlive: () => import('./dlive/index.js').then(m => m.dliveFactory),
}

// Cache de factories ya resueltas para no re-importar
const resolvedFactories = new Map()

export async function getBundledPlugin(pluginId) {
  if (resolvedFactories.has(pluginId)) return resolvedFactories.get(pluginId)
  const loader = bundledLoaders[pluginId]
  if (!loader) return null
  const factory = await loader()
  resolvedFactories.set(pluginId, factory)
  return factory
}

export function isBundledPlugin(config) {
  const manifest = config.manifest || config
  return manifest.bundled === true || config.bundled === true
}
