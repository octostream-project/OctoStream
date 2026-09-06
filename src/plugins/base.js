export const PLUGIN_TYPES = {
  CATALOG: 'catalog',
  STREAM: 'stream',
  META: 'meta',
  SUBTITLES: 'subtitles',
}

export const CONTENT_TYPES = {
  MOVIE: 'movie',
  SERIES: 'series',
  CHANNEL: 'channel',
  LIVE: 'live',
  LANGUAGE: 'language',
  OTHER: 'other',
}

export class PluginManifest {
  constructor({ id, name, version, description, types = [], catalogs = [], icon }) {
    this.id = id
    this.name = name
    this.version = version
    this.description = description
    this.types = types
    this.catalogs = catalogs
    this.icon = icon
  }
}

export class Plugin {
  constructor(manifest) {
    this.manifest = manifest
    this.id = manifest.id
    this.name = manifest.name
  }

  async getCatalog({ type, id, skip = 0, top = 50 } = {}) {
    throw new Error('getCatalog not implemented')
  }

  async getMeta({ type, id }) {
    throw new Error('getMeta not implemented')
  }

  async getStreams({ type, id }) {
    throw new Error('getStreams not implemented')
  }

  async search({ query }) {
    return []
  }
}

export function createPlugin(manifest, handlers) {
  const plugin = new Plugin(manifest)
  // Copy all provided handlers onto the plugin so plugins can expose
  // custom methods (e.g. getLanguagePack, resolveEmbed, searchSubtitles).
  for (const [key, fn] of Object.entries(handlers)) {
    if (typeof fn === 'function') plugin[key] = fn
  }
  return plugin
}
