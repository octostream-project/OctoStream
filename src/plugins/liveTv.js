import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

const channels = [
  {
    id: 'live-1',
    type: CONTENT_TYPES.LIVE,
    name: 'Canal Noticias 24h',
    poster: 'https://image.tmdb.org/t/p/w500/9PFonB7de5mXc5QH0J8kQ6r5K2t.jpg',
    description: 'Noticias en directo las 24 horas.',
    genres: ['Noticias'],
    logo: 'https://via.placeholder.com/150x150/1e293b/ffffff?text=N24',
  },
  {
    id: 'live-2',
    type: CONTENT_TYPES.LIVE,
    name: 'Deportes Total',
    poster: 'https://image.tmdb.org/t/p/w500/7d6EY00g1c39MGZ3yDg2qk6hYjU.jpg',
    description: 'Los mejores eventos deportivos en vivo.',
    genres: ['Deportes'],
    logo: 'https://via.placeholder.com/150x150/1e293b/ffffff?text=DT',
  },
  {
    id: 'live-3',
    type: CONTENT_TYPES.LIVE,
    name: 'Música Live',
    poster: 'https://image.tmdb.org/t/p/w500/aDQZHvBdIeKqyZjtq7yHhGNxLq5.jpg',
    description: 'Conciertos y videoclips en directo.',
    genres: ['Música'],
    logo: 'https://via.placeholder.com/150x150/1e293b/ffffff?text=ML',
  },
  {
    id: 'live-4',
    type: CONTENT_TYPES.LIVE,
    name: 'Cine Clásico',
    poster: 'https://image.tmdb.org/t/p/w500/5gzzkR7y3hnY8AD1wXjH7k6hYjU.jpg',
    description: 'Películas clásicas 24/7.',
    genres: ['Cine'],
    logo: 'https://via.placeholder.com/150x150/1e293b/ffffff?text=CC',
  },
]

export const liveTvPlugin = createPlugin(
  new PluginManifest({
    id: 'live-tv',
    name: 'TV en Vivo',
    version: '1.0.0',
    description: 'Canales de TV en directo',
    types: [CONTENT_TYPES.LIVE],
    catalogs: [
      { id: 'all', name: 'Todos los Canales', type: CONTENT_TYPES.LIVE },
    ],
    icon: 'radio',
  }),
  {
    getCatalog: async ({ skip = 0, top = 50 }) => {
      return channels.slice(skip, skip + top)
    },

    getMeta: async ({ type, id }) => {
      return channels.find(c => c.id === id) || null
    },

    getStreams: async ({ type, id }) => {
      const channel = channels.find(c => c.id === id)
      if (!channel) return []
      return [
        {
          name: 'Señal en Vivo',
          url: `https://example.com/live/${id}`,
          streamType: 'hls',
          quality: 'Live',
        },
      ]
    },

    search: async ({ query }) => {
      const q = query.toLowerCase()
      return channels.filter(c => c.name.toLowerCase().includes(q) || c.genres.some(g => g.toLowerCase().includes(q)))
    },
  }
)
