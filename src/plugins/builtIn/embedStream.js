import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

export const embedStreamPlugin = createPlugin(
  new PluginManifest({
    id: 'embed-stream',
    name: 'Reproductor Embed',
    version: '1.0.0',
    description: 'Plugin para reproducir enlaces embed (iframe) de cualquier fuente',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.LIVE, CONTENT_TYPES.OTHER],
    catalogs: [],
    icon: 'play',
  }),
  {
    getStreams: async ({ type, id }) => {
      return []
    },

    search: async ({ query }) => {
      return []
    },

    resolveEmbed: (url) => {
      const embedPatterns = [
        { pattern: /youtube\.com\/watch\?v=([\w-]+)/, embed: 'https://www.youtube.com/embed/$1' },
        { pattern: /youtu\.be\/([\w-]+)/, embed: 'https://www.youtube.com/embed/$1' },
        { pattern: /vimeo\.com\/(\d+)/, embed: 'https://player.vimeo.com/video/$1' },
        { pattern: /dailymotion\.com\/video\/([\w-]+)/, embed: 'https://www.dailymotion.com/embed/video/$1' },
        { pattern: /streamable\.com\/([\w-]+)/, embed: 'https://streamable.com/e/$1' },
      ]

      for (const { pattern, embed } of embedPatterns) {
        const match = url.match(pattern)
        if (match) {
          return url.replace(pattern, embed)
        }
      }
      return url
    },
  }
)
