import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

const manifest = new PluginManifest({
  id: 'screensaver',
  name: 'Salvapantallas',
  version: '1.0.0',
  description: 'Salvapantallas animado con el logo de OctoStream',
  types: [CONTENT_TYPES.OTHER],
  catalogs: [
    { id: 'screensaver', name: 'Salvapantallas', type: CONTENT_TYPES.OTHER },
  ],
  icon: 'monitor',
})

export const screensaverPlugin = createPlugin(manifest, {
  async getCatalog({ type, id, skip = 0, top = 50 }) {
    if (type !== CONTENT_TYPES.OTHER) return []
    return [{
      id: 'screensaver',
      type: CONTENT_TYPES.OTHER,
      name: 'Salvapantallas',
      poster: './logo.png',
      description: 'Salvapantallas animado con el logo de OctoStream flotando con transparencia',
    }]
  },

  async getMeta({ type, id }) {
    if (type !== CONTENT_TYPES.OTHER || id !== 'screensaver') return null
    return {
      id: 'screensaver',
      type: CONTENT_TYPES.OTHER,
      name: 'Salvapantallas',
      poster: './logo.png',
      description: 'Salvapantallas animado con el logo de OctoStream flotando con transparencia',
    }
  },

  async getStreams() {
    return []
  },
})
