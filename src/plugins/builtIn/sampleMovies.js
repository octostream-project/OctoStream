import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

const movies = [
  {
    id: 'movie-1',
    type: CONTENT_TYPES.MOVIE,
    name: 'El Gran Viaje',
    poster: 'https://image.tmdb.org/t/p/w500/qhb1qOilapbapxLQry3SWelF2uZ.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/qhb1qOilapbapxLQry3SWelF2uZ.jpg',
    description: 'Un grupo de exploradores descubre un mundo oculto lleno de aventuras.',
    year: 2024,
    genres: ['Aventura', 'Ciencia Ficción'],
    rating: 8.5,
    runtime: '2h 15m',
  },
  {
    id: 'movie-2',
    type: CONTENT_TYPES.MOVIE,
    name: 'Sombras del Pasado',
    poster: 'https://image.tmdb.org/t/p/w500/8Vt6mWEReuy4Of61Lnj5xjmc4iq.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/8Vt6mWEReuy4Of61Lnj5xjmc4iq.jpg',
    description: 'Un detective retoma un caso olvidado que cambiará su vida para siempre.',
    year: 2023,
    genres: ['Thriller', 'Drama'],
    rating: 7.8,
    runtime: '1h 52m',
  },
  {
    id: 'movie-3',
    type: CONTENT_TYPES.MOVIE,
    name: 'Última Frontera',
    poster: 'https://image.tmdb.org/t/p/w500/5gzzkR7y3hnY8AD1wXjH7k6hYjU.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/5gzzkR7y3hnY8AD1wXjH7k6hYjU.jpg',
    description: 'En el año 2099, la humanidad busca un nuevo hogar entre las estrellas.',
    year: 2024,
    genres: ['Ciencia Ficción', 'Acción'],
    rating: 9.1,
    runtime: '2h 30m',
  },
  {
    id: 'movie-4',
    type: CONTENT_TYPES.MOVIE,
    name: 'Risas en el Paraíso',
    poster: 'https://image.tmdb.org/t/p/w500/aDQZHvBdIeKqyZjtq7yHhGNxLq5.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/aDQZHvBdIeKqyZjtq7yHhGNxLq5.jpg',
    description: 'Una comedia hilarante sobre unas vacaciones que salen mal.',
    year: 2023,
    genres: ['Comedia'],
    rating: 6.9,
    runtime: '1h 38m',
  },
  {
    id: 'movie-5',
    type: CONTENT_TYPES.MOVIE,
    name: 'El Código Perdido',
    poster: 'https://image.tmdb.org/t/p/w500/9PFonB7de5mXc5QH0J8kQ6r5K2t.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/9PFonB7de5mXc5QH0J8kQ6r5K2t.jpg',
    description: 'Una hacker descubre un secreto que podría destruir Internet.',
    year: 2024,
    genres: ['Thriller', 'Acción'],
    rating: 8.0,
    runtime: '2h 05m',
  },
  {
    id: 'movie-6',
    type: CONTENT_TYPES.MOVIE,
    name: 'Corazón de Acero',
    poster: 'https://image.tmdb.org/t/p/w500/7d6EY00g1c39MGZ3yDg2qk6hYjU.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/7d6EY00g1c39MGZ3yDg2qk6hYjU.jpg',
    description: 'Un soldado debe elegir entre el deber y su familia.',
    year: 2023,
    genres: ['Acción', 'Drama'],
    rating: 7.5,
    runtime: '1h 45m',
  },
]

export const sampleMoviesPlugin = createPlugin(
  new PluginManifest({
    id: 'sample-movies',
    name: 'Películas Demo',
    version: '1.0.0',
    description: 'Catálogo de películas de demostración',
    types: [CONTENT_TYPES.MOVIE],
    catalogs: [
      { id: 'popular', name: 'Películas Populares', type: CONTENT_TYPES.MOVIE },
      { id: 'latest', name: 'Estrenos', type: CONTENT_TYPES.MOVIE },
    ],
    icon: 'film',
  }),
  {
    getCatalog: async ({ id, skip = 0, top = 50 }) => {
      let result = [...movies]
      if (id === 'latest') {
        result.sort((a, b) => b.year - a.year)
      } else {
        result.sort((a, b) => b.rating - a.rating)
      }
      return result.slice(skip, skip + top)
    },

    getMeta: async ({ type, id }) => {
      return movies.find(m => m.id === id) || null
    },

    getStreams: async ({ type, id }) => {
      const movie = movies.find(m => m.id === id)
      if (!movie) return []
      return [
        {
          name: 'Servidor HD',
          url: `https://example.com/embed/movie/${id}`,
          streamType: 'embed',
          quality: '1080p',
        },
        {
          name: 'Servidor SD',
          url: `https://example.com/stream/movie/${id}.mp4`,
          streamType: 'mp4',
          quality: '720p',
        },
      ]
    },

    search: async ({ query }) => {
      const q = query.toLowerCase()
      return movies.filter(m => m.name.toLowerCase().includes(q) || m.genres.some(g => g.toLowerCase().includes(q)))
    },
  }
)
