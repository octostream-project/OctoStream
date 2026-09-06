import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

const series = [
  {
    id: 'series-1',
    type: CONTENT_TYPES.SERIES,
    name: 'Crónicas del Tiempo',
    poster: 'https://image.tmdb.org/t/p/w500/9PFonB7de5mXc5QH0J8kQ6r5K2t.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/9PFonB7de5mXc5QH0J8kQ6r5K2t.jpg',
    description: 'Un viajero del tiempo intenta arreglar el pasado sin destrozar el futuro.',
    year: 2024,
    genres: ['Ciencia Ficción', 'Drama'],
    rating: 9.0,
    seasons: 3,
    episodes: [
      { id: 's1e1', name: 'El Comienzo', season: 1, episode: 1, description: 'Todo empieza aquí.' },
      { id: 's1e2', name: 'Paradoja', season: 1, episode: 2, description: 'Una línea temporal se rompe.' },
      { id: 's1e3', name: 'El Precio del Tiempo', season: 1, episode: 3, description: 'Decisiones imposibles.' },
      { id: 's2e1', name: 'Nueva Era', season: 2, episode: 1, description: 'El futuro cambia.' },
      { id: 's2e2', name: 'Consecuencias', season: 2, episode: 2, description: 'El pasado no perdona.' },
    ],
  },
  {
    id: 'series-2',
    type: CONTENT_TYPES.SERIES,
    name: 'Reino de Sombras',
    poster: 'https://image.tmdb.org/t/p/w500/aDQZHvBdIeKqyZjtq7yHhGNxLq5.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/aDQZHvBdIeKqyZjtq7yHhGNxLq5.jpg',
    description: 'En un reino medieval, la traición y la magia luchan por el trono.',
    year: 2023,
    genres: ['Fantasía', 'Drama'],
    rating: 8.7,
    seasons: 2,
    episodes: [
      { id: 's1e1', name: 'La Corona Rota', season: 1, episode: 1, description: 'El rey ha muerto.' },
      { id: 's1e2', name: 'Alianzas', season: 1, episode: 2, description: 'Nadie es de fiar.' },
      { id: 's1e3', name: 'El Hechizo', season: 1, episode: 3, description: 'Magia prohibida desatada.' },
      { id: 's2e1', name: 'Guerra Abierta', season: 2, episode: 1, description: 'Las espadas hablan.' },
    ],
  },
  {
    id: 'series-3',
    type: CONTENT_TYPES.SERIES,
    name: 'Código Negro',
    poster: 'https://image.tmdb.org/t/p/w500/7d6EY00g1c39MGZ3yDg2qk6hYjU.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/7d6EY00g1c39MGZ3yDg2qk6hYjU.jpg',
    description: 'Una unidad secreta del gobierno opera fuera de la ley para proteger al país.',
    year: 2024,
    genres: ['Acción', 'Thriller'],
    rating: 8.2,
    seasons: 1,
    episodes: [
      { id: 's1e1', name: 'Misión Cero', season: 1, episode: 1, description: 'El equipo se forma.' },
      { id: 's1e2', name: 'Objetivo', season: 1, episode: 2, description: 'La primera misión.' },
      { id: 's1e3', name: 'Traición Interna', season: 1, episode: 3, description: 'Hay un topo.' },
    ],
  },
  {
    id: 'series-4',
    type: CONTENT_TYPES.SERIES,
    name: 'Vida en Marte',
    poster: 'https://image.tmdb.org/t/p/w500/5gzzkR7y3hnY8AD1wXjH7k6hYjU.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/5gzzkR7y3hnY8AD1wXjH7k6hYjU.jpg',
    description: 'Los primeros colonos marcianos enfrentan retos imposibles.',
    year: 2024,
    genres: ['Ciencia Ficción', 'Aventura'],
    rating: 8.5,
    seasons: 2,
    episodes: [
      { id: 's1e1', name: 'Aterrizaje', season: 1, episode: 1, description: 'Llegada al planeta rojo.' },
      { id: 's1e2', name: 'Supervivencia', season: 1, episode: 2, description: 'El primer día es crítico.' },
      { id: 's2e1', name: 'Nueva Colonia', season: 2, episode: 1, description: 'La colonia crece.' },
    ],
  },
]

export const sampleSeriesPlugin = createPlugin(
  new PluginManifest({
    id: 'sample-series',
    name: 'Series Demo',
    version: '1.0.0',
    description: 'Catálogo de series de demostración',
    types: [CONTENT_TYPES.SERIES],
    catalogs: [
      { id: 'popular', name: 'Series Populares', type: CONTENT_TYPES.SERIES },
      { id: 'latest', name: 'Nuevas Series', type: CONTENT_TYPES.SERIES },
    ],
    icon: 'tv',
  }),
  {
    getCatalog: async ({ id, skip = 0, top = 50 }) => {
      let result = [...series]
      if (id === 'latest') {
        result.sort((a, b) => b.year - a.year)
      } else {
        result.sort((a, b) => b.rating - a.rating)
      }
      return result.slice(skip, skip + top)
    },

    getMeta: async ({ type, id }) => {
      return series.find(s => s.id === id) || null
    },

    getStreams: async ({ type, id }) => {
      const s = series.find(s => s.id === id)
      if (!s) return []
      return [
        {
          name: 'Servidor HD',
          url: `https://example.com/embed/series/${id}`,
          streamType: 'embed',
          quality: '1080p',
        },
        {
          name: 'Servidor SD',
          url: `https://example.com/stream/series/${id}.mp4`,
          streamType: 'mp4',
          quality: '720p',
        },
      ]
    },

    search: async ({ query }) => {
      const q = query.toLowerCase()
      return series.filter(s => s.name.toLowerCase().includes(q) || s.genres.some(g => g.toLowerCase().includes(q)))
    },
  }
)
