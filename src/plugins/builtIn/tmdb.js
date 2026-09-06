import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG = 'https://image.tmdb.org/t/p'

// API key resolution order: env var > user-provided key in settings > bundled demo key.
// Set VITE_TMDB_API_KEY in your .env to override the bundled demo key.
const ENV_API_KEY =
  (import.meta.env && import.meta.env.VITE_TMDB_API_KEY) ||
  (typeof process !== 'undefined' && process.env && process.env.TMDB_API_KEY) ||
  ''
const BUNDLED_DEMO_KEY = 'dd0f5c5a8c210793ce6570164e5f25e4'

function getApiKey() {
  return localStorage.getItem('optopus_tmdb_key') || ENV_API_KEY || BUNDLED_DEMO_KEY
}

const IMAGE_SIZES = {
  poster: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
  backdrop: ['w300', 'w780', 'w1280', 'original'],
  profile: ['w45', 'w185', 'h632', 'original'],
}

function getImageUrl(path, type = 'poster', size = 'w500') {
  if (!path) return null
  const sizes = IMAGE_SIZES[type] || IMAGE_SIZES.poster
  const useSize = sizes.includes(size) ? size : sizes[Math.floor(sizes.length / 2)]
  return `${TMDB_IMG}/${useSize}${path}`
}

function mapMovie(item) {
  if (!item) return null
  return {
    id: `tmdb-movie-${item.id}`,
    tmdbId: item.id,
    type: CONTENT_TYPES.MOVIE,
    name: item.title || item.name || '',
    poster: getImageUrl(item.poster_path, 'poster', 'w342'),
    backdrop: getImageUrl(item.backdrop_path, 'backdrop', 'w780'),
    description: item.overview || '',
    year: item.release_date ? parseInt(item.release_date.slice(0, 4)) : null,
    rating: item.vote_average ? item.vote_average : null,
    genres: mapGenreIds(item.genre_ids || [], true),
    releaseDate: item.release_date,
    tmdbData: item,
  }
}

function mapSeries(item) {
  if (!item) return null
  return {
    id: `tmdb-series-${item.id}`,
    tmdbId: item.id,
    type: CONTENT_TYPES.SERIES,
    name: item.name || item.title || '',
    poster: getImageUrl(item.poster_path, 'poster', 'w342'),
    backdrop: getImageUrl(item.backdrop_path, 'backdrop', 'w780'),
    description: item.overview || '',
    year: item.first_air_date ? parseInt(item.first_air_date.slice(0, 4)) : null,
    rating: item.vote_average ? item.vote_average : null,
    genres: mapGenreIds(item.genre_ids || [], false),
    releaseDate: item.first_air_date,
    episodes: item.number_of_episodes,
    firstAirDate: item.first_air_date,
    tmdbData: item,
  }
}

const GENRE_MAP_MOVIE = {
  28: 'Acción', 12: 'Aventura', 16: 'Animación', 35: 'Comedia',
  80: 'Crimen', 99: 'Documental', 18: 'Drama', 10751: 'Familiar',
  14: 'Fantasía', 36: 'Historia', 27: 'Terror', 10402: 'Música',
  9648: 'Misterio', 10749: 'Romance', 878: 'Ciencia Ficción',
  10770: 'Película de TV', 53: 'Suspense', 10752: 'Bélica', 37: 'Western',
}

const GENRE_MAP_TV = {
  10759: 'Acción y Aventura', 16: 'Animación', 35: 'Comedia', 80: 'Crimen',
  99: 'Documental', 18: 'Drama', 10751: 'Familiar', 10762: 'Infantil',
  9648: 'Misterio', 10763: 'Noticias', 10764: 'Reality', 10765: 'Ciencia Ficción y Fantasía',
  10766: 'Telenovela', 10767: 'Charla', 10768: 'Bélica y Política', 37: 'Western',
}

function mapGenreIds(ids, isMovie = true) {
  const map = isMovie ? GENRE_MAP_MOVIE : GENRE_MAP_TV
  return ids.map(id => map[id]).filter(Boolean)
}

async function tmdbFetch(endpoint, apiKey, params = {}) {
  const url = new URL(`${TMDB_BASE}${endpoint}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('language', 'es-ES')
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })

  const res = await fetch(url.toString())
  if (!res.ok) {
    if (res.status === 401) throw new Error('API key de TMDB inválida')
    throw new Error(`Error TMDB: ${res.status}`)
  }
  return res.json()
}

const CATALOG_ENDPOINTS = {
  'movie-popular': { endpoint: '/movie/popular', isMovie: true },
  'movie-top-rated': { endpoint: '/movie/top_rated', isMovie: true },
  'movie-now-playing': { endpoint: '/movie/now_playing', isMovie: true },
  'movie-upcoming': { endpoint: '/movie/upcoming', isMovie: true },
  'tv-popular': { endpoint: '/tv/popular', isMovie: false },
  'tv-top-rated': { endpoint: '/tv/top_rated', isMovie: false },
  'tv-on-air': { endpoint: '/tv/on_the_air', isMovie: false },
  'movie-action': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 28, sort_by: 'popularity.desc' } },
  'movie-comedy': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 35, sort_by: 'popularity.desc' } },
  'movie-horror': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 27, sort_by: 'popularity.desc' } },
  'movie-scifi': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 878, sort_by: 'popularity.desc' } },
  'movie-drama': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 18, sort_by: 'popularity.desc' } },
  'movie-animation': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 16, sort_by: 'popularity.desc' } },
  'movie-thriller': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 53, sort_by: 'popularity.desc' } },
  'movie-2025': { endpoint: '/discover/movie', isMovie: true, extra: { primary_release_year: 2025, sort_by: 'popularity.desc' } },
  'movie-2024': { endpoint: '/discover/movie', isMovie: true, extra: { primary_release_year: 2024, sort_by: 'popularity.desc' } },
  'tv-action': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 10759, sort_by: 'popularity.desc' } },
  'tv-comedy': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 35, sort_by: 'popularity.desc' } },
  'tv-drama': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 18, sort_by: 'popularity.desc' } },
  'tv-2025': { endpoint: '/discover/tv', isMovie: false, extra: { first_air_date_year: 2025, sort_by: 'popularity.desc' } },
  'tv-2024': { endpoint: '/discover/tv', isMovie: false, extra: { first_air_date_year: 2024, sort_by: 'popularity.desc' } },
}

export const tmdbPlugin = createPlugin(
  new PluginManifest({
    id: 'tmdb',
    name: 'TMDB - Películas y Series',
    version: '1.0.0',
    description: 'Catálogo real de películas y series con carteles desde The Movie Database (TMDB)',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
    catalogs: [
      { id: 'movie-popular', name: 'Películas Populares', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-top-rated', name: 'Mejor Valoradas', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-now-playing', name: 'En Cines', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-upcoming', name: 'Próximamente', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-action', name: 'Acción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-comedy', name: 'Comedia', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-horror', name: 'Terror', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-scifi', name: 'Ciencia Ficción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-drama', name: 'Drama', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-animation', name: 'Animación', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-thriller', name: 'Suspense', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2025', name: 'Estrenos 2025', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2024', name: 'Estrenos 2024', type: CONTENT_TYPES.MOVIE },
      { id: 'tv-popular', name: 'Series Populares', type: CONTENT_TYPES.SERIES },
      { id: 'tv-top-rated', name: 'Mejores Series', type: CONTENT_TYPES.SERIES },
      { id: 'tv-on-air', name: 'En Emisión', type: CONTENT_TYPES.SERIES },
      { id: 'tv-action', name: 'Series de Acción', type: CONTENT_TYPES.SERIES },
      { id: 'tv-comedy', name: 'Series de Comedia', type: CONTENT_TYPES.SERIES },
      { id: 'tv-drama', name: 'Series de Drama', type: CONTENT_TYPES.SERIES },
      { id: 'tv-2025', name: 'Series 2025', type: CONTENT_TYPES.SERIES },
      { id: 'tv-2024', name: 'Series 2024', type: CONTENT_TYPES.SERIES },
    ],
    icon: 'film',
  }),
  {
    getCatalog: async ({ id, skip = 0, top = 20 }) => {
      const apiKey = getApiKey()
      const page = Math.floor(skip / 20) + 1
      const config = CATALOG_ENDPOINTS[id]
      if (!config) return []

      const params = { page, ...config.extra }
      const data = await tmdbFetch(config.endpoint, apiKey, params)
      const mapper = config.isMovie ? mapMovie : mapSeries
      return (data.results || []).map(mapper)
    },

    getMeta: async ({ type, id }) => {
      const apiKey = getApiKey()
      const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
      if (!match) return null

      const [, kind, tmdbId] = match
      const isMovie = kind === 'movie'
      const endpoint = isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`
      const data = await tmdbFetch(endpoint, apiKey, {
        append_to_response: 'credits,videos,similar,recommendations',
      })

      const base = isMovie ? mapMovie(data) : mapSeries(data)
      if (!base) return null

      if (data.genres) {
        base.genres = data.genres.map(g => g.name)
      }

      if (data.credits && data.credits.cast) {
        base.cast = data.credits.cast.slice(0, 10).map(c => ({
          id: c.id,
          name: c.name,
          character: c.character,
          photo: c.profile_path ? getImageUrl(c.profile_path, 'profile', 'w185') : null,
        }))
      }

      if (data.videos && data.videos.results) {
        const trailer = data.videos.results.find(v =>
          v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
        )
        if (trailer) {
          base.trailer = `https://www.youtube.com/embed/${trailer.key}`
        }
      }

      if (data.runtime) {
        const h = Math.floor(data.runtime / 60)
        const m = data.runtime % 60
        base.runtime = h > 0 ? `${h}h ${m}m` : `${m}m`
      }

      if (data.episode_run_time && data.episode_run_time.length > 0) {
        const ep = data.episode_run_time[0]
        base.runtime = `${ep}m por episodio`
      }

      if (data.similar && data.similar.results) {
        base.similar = data.similar.results.slice(0, 6).map(isMovie ? mapMovie : mapSeries)
      }

      if (data.recommendations && data.recommendations.results) {
        base.recommendations = data.recommendations.results.slice(0, 6).map(isMovie ? mapMovie : mapSeries)
      }

      if (!isMovie && data.seasons) {
        base.seasonsList = data.seasons
          .filter(s => s.season_number > 0)
          .map(s => ({
            id: `s${s.season_number}`,
            name: s.name || `Temporada ${s.season_number}`,
            seasonNumber: s.season_number,
            episodeCount: s.episode_count,
            poster: s.poster_path ? getImageUrl(s.poster_path, 'poster', 'w342') : null,
          }))
      }

      return base
    },

    getStreams: async ({ type, id, name }) => {
      const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
      if (!match) return []

      const [, kind, tmdbId] = match
      const titleName = name || ''

      return [
        {
          name: 'YouTube - Película Completa',
          url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' pelicula completa en español')}`,
          streamType: 'embed',
          quality: 'Gratis',
        },
        {
          name: 'YouTube - Full Movie (English)',
          url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' full movie')}`,
          streamType: 'embed',
          quality: 'Free',
        },
        {
          name: 'YouTube - Tráiler',
          url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' trailer oficial')}`,
          streamType: 'embed',
          quality: 'Tráiler',
        },
        {
          name: 'Archive.org - Dominio Público',
          url: `https://archive.org/embed/?q=${encodeURIComponent(titleName)}`,
          streamType: 'embed',
          quality: 'Gratis',
        },
        {
          name: 'Plex - Gratis con anuncios',
          url: `https://www.plex.tv/watch-free-to-watch-movies-online/?query=${encodeURIComponent(titleName)}`,
          streamType: 'embed',
          quality: 'Gratis',
        },
        {
          name: 'Tubi (EEUU)',
          url: `https://tubitv.com/search/${encodeURIComponent(titleName)}`,
          streamType: 'embed',
          quality: 'Gratis',
        },
        {
          name: 'Pluto TV',
          url: `https://pluto.tv/en/on-demand/search/details?query=${encodeURIComponent(titleName)}`,
          streamType: 'embed',
          quality: 'Gratis',
        },
      ]
    },

    search: async ({ query }) => {
      const apiKey = getApiKey()
      const data = await tmdbFetch('/search/multi', apiKey, { query, page: 1 })
      return (data.results || [])
        .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
        .map(item => item.media_type === 'movie' ? mapMovie(item) : mapSeries(item))
    },
  }
)
