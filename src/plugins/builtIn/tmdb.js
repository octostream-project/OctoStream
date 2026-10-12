import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { getItemSync } from '../../utils/storage.js'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG = 'https://image.tmdb.org/t/p'

// API key resolution order: env var > user-provided key in settings > bundled demo key.
// Set VITE_TMDB_API_KEY in your .env to override the bundled demo key.
const ENV_API_KEY =
  (import.meta.env && import.meta.env.VITE_TMDB_API_KEY) ||
  (typeof process !== 'undefined' && process.env && process.env.TMDB_API_KEY) ||
  ''
const BUNDLED_DEMO_KEY = 'dd0f5c5a8c210793ce6570164e5f25e4'

// Cache de la API key: localStorage es síncrono y se llamaba en cada request.
let cachedApiKey = null
export function getTmdbApiKey() {
  if (cachedApiKey) return cachedApiKey
  try {
    cachedApiKey = getItemSync('octostream_tmdb_key') || ENV_API_KEY || BUNDLED_DEMO_KEY
  } catch {
    cachedApiKey = ENV_API_KEY || BUNDLED_DEMO_KEY
  }
  return cachedApiKey
}

// Invalida el caché cuando la clave cambia en settings
export function invalidateTmdbApiKey() {
  cachedApiKey = null
}

function getApiKey() {
  return getTmdbApiKey()
}

const IMAGE_SIZES = {
  poster: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
  backdrop: ['w300', 'w780', 'w1280', 'original'],
  profile: ['w45', 'w185', 'h632', 'original'],
}

// Calidad de imágenes (ajuste "ahorro de datos"): el tamaño pedido es el nivel
// 'high'; 'medium' y 'low' bajan N pasos dentro de la lista del tipo.
// Índice mínimo por tipo para no degradar demasiado (hero/perfiles).
const QUALITY_DROP = { medium: 1, low: 2 }
const QUALITY_MIN_IDX = { poster: 1, backdrop: 1, profile: 1 }

let cachedImgQuality = null
export function getImageQuality() {
  if (cachedImgQuality) return cachedImgQuality
  try {
    const q = getItemSync('octostream_image_quality')
    cachedImgQuality = (q === 'low' || q === 'medium' || q === 'high') ? q : 'medium'
  } catch {
    cachedImgQuality = 'medium'
  }
  return cachedImgQuality
}

// Invalida el caché cuando el ajuste cambia en Settings
export function invalidateImageQuality() {
  cachedImgQuality = null
}

function getImageUrl(path, type = 'poster', size = 'w500') {
  if (!path) return null
  const sizes = IMAGE_SIZES[type] || IMAGE_SIZES.poster
  let useSize = sizes.includes(size) ? size : sizes[Math.floor(sizes.length / 2)]
  const drop = QUALITY_DROP[getImageQuality()] || 0
  if (drop > 0) {
    const idx = sizes.indexOf(useSize)
    const minIdx = QUALITY_MIN_IDX[type] ?? 0
    // Nunca superar el tamaño pedido (un still w300 no debe saltar a w780)
    useSize = sizes[Math.min(idx, Math.max(minIdx, idx - drop))]
  }
  return `${TMDB_IMG}/${useSize}${path}`
}

// --- LRU cache for TMDB API responses (in-memory only) --------------------
const CACHE_MAX = 60
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const apiCache = new Map()

function cacheKey(endpoint, params) {
  const p = new URLSearchParams(params)
  p.delete('api_key')
  p.sort()
  return endpoint + '?' + p.toString()
}

function cacheGet(key) {
  const entry = apiCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    apiCache.delete(key)
    return null
  }
  // Move to end (most-recently-used)
  apiCache.delete(key)
  apiCache.set(key, entry)
  return entry.data
}

function cacheSet(key, data) {
  if (apiCache.size >= CACHE_MAX) {
    // Evict oldest entry (first in Map iteration order)
    const oldest = apiCache.keys().next().value
    if (oldest !== undefined) apiCache.delete(oldest)
  }
  apiCache.set(key, { data, ts: Date.now() })
}

// --- Mappers (strip raw TMDB data to save RAM) ---------------------------
function mapMovie(item, { includeRaw = false } = {}) {
  if (!item) return null
  const mapped = {
    id: `tmdb-movie-${item.id}`,
    tmdbId: item.id,
    type: CONTENT_TYPES.MOVIE,
    name: item.title || item.name || '',
    originalName: item.original_title || item.original_name || '',
    poster: getImageUrl(item.poster_path, 'poster', 'w342'),
    backdrop: getImageUrl(item.backdrop_path, 'backdrop', 'w780'),
    description: item.overview || '',
    year: item.release_date ? parseInt(item.release_date.slice(0, 4)) : null,
    rating: item.vote_average ? item.vote_average : null,
    genres: mapGenreIds(item.genre_ids || [], true),
    releaseDate: item.release_date,
  }
  if (includeRaw) mapped.tmdbData = item
  return mapped
}

function mapSeries(item, { includeRaw = false } = {}) {
  if (!item) return null
  const mapped = {
    id: `tmdb-series-${item.id}`,
    tmdbId: item.id,
    type: CONTENT_TYPES.SERIES,
    name: item.name || item.title || '',
    originalName: item.original_name || item.original_title || '',
    poster: getImageUrl(item.poster_path, 'poster', 'w342'),
    backdrop: getImageUrl(item.backdrop_path, 'backdrop', 'w780'),
    description: item.overview || '',
    year: item.first_air_date ? parseInt(item.first_air_date.slice(0, 4)) : null,
    rating: item.vote_average ? item.vote_average : null,
    genres: mapGenreIds(item.genre_ids || [], false),
    releaseDate: item.first_air_date,
    episodeCount: item.number_of_episodes,
    firstAirDate: item.first_air_date,
  }
  if (includeRaw) mapped.tmdbData = item
  return mapped
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

// Coalescing: peticiones idénticas en vuelo comparten el mismo fetch.
const tmdbInflight = new Map()

// El fetch compartido usa su propio timeout (20s) y NO el signal del llamador:
// si una pantalla aborta su navegación no debe matar la request que otra
// pantalla sigue esperando. El abort del llamador solo "desuscribe" su await.
function raceWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }),
  ])
}

async function tmdbFetch(endpoint, apiKey, params = {}, signal) {
  const url = new URL(`${TMDB_BASE}${endpoint}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('language', 'es-ES')
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })

  const key = cacheKey(endpoint, params)
  const cached = cacheGet(key)
  if (cached) return cached
  let inflight = tmdbInflight.get(key)
  if (!inflight) {
    inflight = (async () => {
      const fetchSignal = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
      const res = await fetch(url.toString(), { signal: fetchSignal })
      if (!res.ok) {
        if (res.status === 401) throw new Error('API key de TMDB inválida')
        throw new Error(`Error TMDB: ${res.status}`)
      }
      const data = await res.json()
      cacheSet(key, data)
      return data
    })().finally(() => tmdbInflight.delete(key))
    tmdbInflight.set(key, inflight)
  }
  return raceWithSignal(inflight, signal)
}

const CATALOG_ENDPOINTS = {
  'movie-popular': { endpoint: '/movie/popular', isMovie: true },
  'movie-top-rated': { endpoint: '/movie/top_rated', isMovie: true },
  'movie-now-playing': { endpoint: '/movie/now_playing', isMovie: true },
  'movie-upcoming': { endpoint: '/movie/upcoming', isMovie: true },
  'tv-popular': { endpoint: '/tv/popular', isMovie: false },
  'tv-top-rated': { endpoint: '/tv/top_rated', isMovie: false },
  'tv-on-air': { endpoint: '/tv/on_the_air', isMovie: false },
  'tv-airing-today': { endpoint: '/tv/airing_today', isMovie: false },
  'movie-action': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 28, sort_by: 'popularity.desc' } },
  'movie-comedy': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 35, sort_by: 'popularity.desc' } },
  'movie-horror': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 27, sort_by: 'popularity.desc' } },
  'movie-scifi': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 878, sort_by: 'popularity.desc' } },
  'movie-drama': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 18, sort_by: 'popularity.desc' } },
  'movie-animation': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 16, sort_by: 'popularity.desc' } },
  'movie-thriller': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 53, sort_by: 'popularity.desc' } },
  'movie-romance': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 10749, sort_by: 'popularity.desc' } },
  'movie-crime': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 80, sort_by: 'popularity.desc' } },
  'movie-fantasy': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 14, sort_by: 'popularity.desc' } },
  'movie-2025': { endpoint: '/discover/movie', isMovie: true, extra: { primary_release_year: 2025, sort_by: 'popularity.desc' } },
  'movie-2024': { endpoint: '/discover/movie', isMovie: true, extra: { primary_release_year: 2024, sort_by: 'popularity.desc' } },
  // Series genres (TMDB TV genre IDs differ from movie IDs)
  'tv-action': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 10759, sort_by: 'popularity.desc' } },
  'tv-comedy': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 35, sort_by: 'popularity.desc' } },
  'tv-drama': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 18, sort_by: 'popularity.desc' } },
  'tv-animation': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 16, sort_by: 'popularity.desc' } },
  'tv-crime': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 80, sort_by: 'popularity.desc' } },
  'tv-documentary': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 99, sort_by: 'popularity.desc' } },
  'tv-reality': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 10764, sort_by: 'popularity.desc' } },
  'tv-scifi': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 10765, sort_by: 'popularity.desc' } },
  'tv-family': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 10751, sort_by: 'popularity.desc' } },
  'tv-mystery': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 9648, sort_by: 'popularity.desc' } },
  'tv-2025': { endpoint: '/discover/tv', isMovie: false, extra: { first_air_date_year: 2025, sort_by: 'popularity.desc' } },
  'tv-2024': { endpoint: '/discover/tv', isMovie: false, extra: { first_air_date_year: 2024, sort_by: 'popularity.desc' } },
  // Anime: animación (16) originada en Japón (JP)
  'tv-anime-jp': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 16, with_origin_country: 'JP', sort_by: 'popularity.desc' } },
  // Anime movies: animación (16) originada en Japón (JP)
  'movie-anime-jp': { endpoint: '/discover/movie', isMovie: true, extra: { with_genres: 16, with_origin_country: 'JP', sort_by: 'popularity.desc' } },
  // Anime popular this week (JP animation, sorted by vote count)
  'tv-anime-jp-top': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 16, with_origin_country: 'JP', sort_by: 'vote_count.desc' } },
  // Anime airing today (JP animation currently airing)
  'tv-anime-jp-airing': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 16, with_origin_country: 'JP', 'air_status': 'returning', sort_by: 'popularity.desc' } },
  // Dorama: drama (18) originado en Corea (KR), Japón (JP) o China (CN)
  'tv-dorama-kr': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 18, with_origin_country: 'KR', sort_by: 'popularity.desc' } },
  'tv-dorama-jp': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 18, with_origin_country: 'JP', sort_by: 'popularity.desc' } },
  'tv-dorama-cn': { endpoint: '/discover/tv', isMovie: false, extra: { with_genres: 18, with_origin_country: 'CN', sort_by: 'popularity.desc' } },

  // ── Catálogos temáticos ─────────────────────────────────────────────
  // Estudios (with_companies): el id es la productora en TMDB.
  'movie-ghibli': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 10342, sort_by: 'popularity.desc' } },
  'movie-pixar': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 3, sort_by: 'popularity.desc' } },
  'movie-disney': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 2, sort_by: 'popularity.desc' } },
  'movie-marvel': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 420, sort_by: 'popularity.desc' } },
  'movie-dc': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 128064, sort_by: 'popularity.desc' } },
  'movie-a24': { endpoint: '/discover/movie', isMovie: true, extra: { with_companies: 41077, sort_by: 'popularity.desc' } },
  // Temáticas por keyword TMDB (with_keywords) — ids resueltos vía /search/keyword
  'movie-zombies': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 12377, sort_by: 'popularity.desc' } },
  'movie-vampiros': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 3133, sort_by: 'popularity.desc' } },
  'movie-halloween': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 3335, sort_by: 'popularity.desc' } },
  'movie-navidad': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 207317, sort_by: 'popularity.desc' } },
  'movie-aliens': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 9951, sort_by: 'popularity.desc' } },
  'movie-timetravel': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 4379, sort_by: 'popularity.desc' } },
  'movie-distopias': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 4565, sort_by: 'popularity.desc' } },
  'movie-ww2': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 1956, sort_by: 'popularity.desc' } },
  'movie-tiburones': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 15097, sort_by: 'popularity.desc' } },
  'movie-serial': { endpoint: '/discover/movie', isMovie: true, extra: { with_keywords: 10714, sort_by: 'popularity.desc' } },
  // Series temáticas por keyword
  'tv-zombies': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 12377, sort_by: 'popularity.desc' } },
  'tv-vampiros': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 3133, sort_by: 'popularity.desc' } },
  'tv-superheroes': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 9715, sort_by: 'popularity.desc' } },
  'tv-ww2': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 1956, sort_by: 'popularity.desc' } },
  'tv-distopias': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 4565, sort_by: 'popularity.desc' } },
  'tv-timetravel': { endpoint: '/discover/tv', isMovie: false, extra: { with_keywords: 4379, sort_by: 'popularity.desc' } },
  // Sagas completas (endpoint /collection/{id} → devuelve `parts`, no `results`)
  'movie-harry-potter': { endpoint: '/collection/1241', isMovie: true, collection: true },
  'movie-star-wars': { endpoint: '/collection/10', isMovie: true, collection: true },
  'movie-a-todo-gas': { endpoint: '/collection/9485', isMovie: true, collection: true },
  'movie-james-bond': { endpoint: '/collection/645', isMovie: true, collection: true },
  'movie-jurassic': { endpoint: '/collection/328', isMovie: true, collection: true },
  'movie-piratas': { endpoint: '/collection/295', isMovie: true, collection: true },
  'movie-toy-story': { endpoint: '/collection/10194', isMovie: true, collection: true },
  'movie-john-wick': { endpoint: '/collection/404609', isMovie: true, collection: true },
  'movie-scream': { endpoint: '/collection/2602', isMovie: true, collection: true },
  'movie-hobbit': { endpoint: '/collection/121938', isMovie: true, collection: true },
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
      { id: 'movie-action', name: 'Acción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-comedy', name: 'Comedia', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-horror', name: 'Terror', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-scifi', name: 'Ciencia Ficción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-drama', name: 'Drama', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-animation', name: 'Animación', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-thriller', name: 'Suspense', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-romance', name: 'Romance', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-crime', name: 'Crimen', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-fantasy', name: 'Fantasía', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2025', name: 'Estrenos 2025', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2024', name: 'Estrenos 2024', type: CONTENT_TYPES.MOVIE },
      { id: 'tv-popular', name: 'Series Populares', type: CONTENT_TYPES.SERIES },
      { id: 'tv-top-rated', name: 'Mejores Series', type: CONTENT_TYPES.SERIES },
      { id: 'tv-on-air', name: 'En Emisión', type: CONTENT_TYPES.SERIES },
      { id: 'tv-airing-today', name: 'Emisión Hoy', type: CONTENT_TYPES.SERIES },
      { id: 'tv-action', name: 'Series de Acción', type: CONTENT_TYPES.SERIES },
      { id: 'tv-comedy', name: 'Series de Comedia', type: CONTENT_TYPES.SERIES },
      { id: 'tv-drama', name: 'Series de Drama', type: CONTENT_TYPES.SERIES },
      { id: 'tv-animation', name: 'Anime/Animación', type: CONTENT_TYPES.SERIES },
      { id: 'tv-crime', name: 'Series de Crimen', type: CONTENT_TYPES.SERIES },
      { id: 'tv-documentary', name: 'Documentales', type: CONTENT_TYPES.SERIES },
      { id: 'tv-reality', name: 'Reality Shows', type: CONTENT_TYPES.SERIES },
      { id: 'tv-scifi', name: 'Series de Ciencia Ficción', type: CONTENT_TYPES.SERIES },
      { id: 'tv-family', name: 'Series Familiares', type: CONTENT_TYPES.SERIES },
      { id: 'tv-mystery', name: 'Series de Misterio', type: CONTENT_TYPES.SERIES },
      { id: 'tv-2025', name: 'Series 2025', type: CONTENT_TYPES.SERIES },
      { id: 'tv-2024', name: 'Series 2024', type: CONTENT_TYPES.SERIES },
      { id: 'tv-anime-jp', name: 'Anime (Japón)', type: CONTENT_TYPES.SERIES },
      { id: 'tv-anime-jp-top', name: 'Anime Mejor Valorado', type: CONTENT_TYPES.SERIES },
      { id: 'tv-anime-jp-airing', name: 'Anime En Emisión', type: CONTENT_TYPES.SERIES },
      { id: 'movie-anime-jp', name: 'Películas Anime', type: CONTENT_TYPES.MOVIE },
      { id: 'tv-dorama-kr', name: 'Doramas Coreanos', type: CONTENT_TYPES.SERIES },
      { id: 'tv-dorama-jp', name: 'Doramas Japoneses', type: CONTENT_TYPES.SERIES },
      { id: 'tv-dorama-cn', name: 'Doramas Chinos', type: CONTENT_TYPES.SERIES },
      // Estudios
      { id: 'movie-ghibli', name: 'Studio Ghibli', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-pixar', name: 'Pixar', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-disney', name: 'Disney', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-marvel', name: 'Marvel', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-dc', name: 'DC', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-a24', name: 'A24', type: CONTENT_TYPES.MOVIE },
      // Temáticas
      { id: 'movie-zombies', name: 'Zombis', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-vampiros', name: 'Vampiros', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-halloween', name: 'Halloween', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-navidad', name: 'Navidad', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-aliens', name: 'Alienígenas', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-timetravel', name: 'Viajes en el tiempo', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-distopias', name: 'Distopías', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-ww2', name: 'II Guerra Mundial', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-tiburones', name: 'Tiburones', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-serial', name: 'Asesinos en serie', type: CONTENT_TYPES.MOVIE },
      { id: 'tv-zombies', name: 'Series de zombis', type: CONTENT_TYPES.SERIES },
      { id: 'tv-vampiros', name: 'Series de vampiros', type: CONTENT_TYPES.SERIES },
      { id: 'tv-superheroes', name: 'Superhéroes', type: CONTENT_TYPES.SERIES },
      { id: 'tv-ww2', name: 'Series bélicas WWII', type: CONTENT_TYPES.SERIES },
      { id: 'tv-distopias', name: 'Series distópicas', type: CONTENT_TYPES.SERIES },
      { id: 'tv-timetravel', name: 'Series de viajes en el tiempo', type: CONTENT_TYPES.SERIES },
      // Sagas
      { id: 'movie-harry-potter', name: 'Harry Potter', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-star-wars', name: 'Star Wars', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-a-todo-gas', name: 'A todo gas', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-james-bond', name: 'James Bond', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-jurassic', name: 'Jurassic Park', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-piratas', name: 'Piratas del Caribe', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-toy-story', name: 'Toy Story', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-john-wick', name: 'John Wick', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-scream', name: 'Scream', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-hobbit', name: 'El Hobbit', type: CONTENT_TYPES.MOVIE },
    ],
    icon: 'film',
  }),
  {
    getCatalog: async ({ id, skip = 0, top = 20, signal }) => {
      const apiKey = getApiKey()
      const page = Math.floor(skip / 20) + 1
      const config = CATALOG_ENDPOINTS[id]
      if (!config) return []

      const params = { page, ...config.extra }
      const data = await tmdbFetch(config.endpoint, apiKey, params, signal)
      const mapper = config.isMovie ? mapMovie : mapSeries
      // Las colecciones devuelven `parts` (sagas ordenadas por fecha);
      // el resto devuelve `results`. Strip raw TMDB data to save RAM.
      const items = config.collection
        ? [...(data.parts || [])].sort((a, b) =>
            String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')))
        : (data.results || [])
      return items.map(item => mapper(item, { includeRaw: false }))
    },

    getMeta: async ({ type, id, signal }) => {
      const apiKey = getApiKey()
      const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
      if (!match) return null

      const [, kind, tmdbId] = match
      const isMovie = kind === 'movie'
      const endpoint = isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`
      const data = await tmdbFetch(endpoint, apiKey, {
        append_to_response: 'videos,similar,recommendations,credits,alternative_titles,external_ids',
      }, signal)
      const base = isMovie ? mapMovie(data, { includeRaw: false }) : mapSeries(data, { includeRaw: false })
      if (!base) return null

      if (data.genres) {
        base.genres = data.genres.map(g => g.name)
      }

      // IMDB id para búsqueda de subtítulos en addons estilo Stremio
      // (opensubtitles-v3.strem.io solo indexa por tt*)
      if (data.external_ids && data.external_ids.imdb_id) {
        base.imdbId = data.external_ids.imdb_id
      }

      // Origin country + language for anime/dorama detection
      // (TMDB returns ISO codes: JP, KR, CN, etc.)
      if (data.origin_country) base.originCountry = data.origin_country
      if (data.original_language) base.originalLanguage = data.original_language
      // For movies, production_countries is also available
      if (!isMovie && data.production_countries) {
        base.originCountry = base.originCountry || data.production_countries.map(c => c.iso_3166_1)
      }

      // English title for fallback searches: many dorama/anime providers
      // index by the English title (e.g. "Bloodhounds") while TMDB es-ES has
      // the Spanish title ("Perros de caza") and original_name is Korean
      // ("사냥개들"). Without the English title, providers can't be found.
      if (data.original_language === 'en') {
        base.englishName = data.original_title || data.original_name || ''
      } else if (data.alternative_titles?.results) {
        const en = data.alternative_titles.results.find(t => t.iso_3166_1 === 'US' || t.iso_3166_1 === 'GB')
        if (en) base.englishName = en.title
      }

      if (data.videos && data.videos.results) {
        const videos = data.videos.results.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
        // Prefer Spanish trailers (es-ES or es), then any, then English
        const trailer =
          videos.find(v => v.iso_639_1 === 'es' || v.iso_639_1 === 'es-ES') ||
          videos.find(v => v.iso_639_1 === 'es-419') ||
          videos[0]
        if (trailer) {
          base.trailer = `https://www.youtube.com/embed/${trailer.key}`
          base.trailerKey = trailer.key
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
        base.similar = data.similar.results.slice(0, 6).map(item =>
          (isMovie ? mapMovie : mapSeries)(item, { includeRaw: false })
        )
      }

      if (data.recommendations && data.recommendations.results) {
        base.recommendations = data.recommendations.results.slice(0, 6).map(item =>
          (isMovie ? mapMovie : mapSeries)(item, { includeRaw: false })
        )
      }

      // Extract cast from credits (included via append_to_response)
      if (data.credits && data.credits.cast) {
        base.cast = data.credits.cast.slice(0, 10).map(c => ({
          id: c.id,
          name: c.name,
          character: c.character,
          photo: c.profile_path ? getImageUrl(c.profile_path, 'profile', 'w185') : null,
        }))
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
      return []
    },

    search: async ({ query, signal }) => searchMulti(query, signal),

    // Load episodes for a specific season from TMDB
    getSeasonEpisodes: async ({ id, seasonNumber, signal }) => {
      const apiKey = getApiKey()
      const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
      if (!match) return []
      const [, kind, tmdbId] = match
      if (kind !== 'series') return []

      try {
        const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`, apiKey, {}, signal)
        if (!data || !data.episodes) return []

        return data.episodes.map(ep => ({
          id: `tmdb-series-${tmdbId}-s${seasonNumber}e${ep.episode_number}`,
          name: ep.name || `Episodio ${ep.episode_number}`,
          season: seasonNumber,
          episode: ep.episode_number,
          description: ep.overview || '',
          poster: ep.still_path ? getImageUrl(ep.still_path, 'backdrop', 'w300') : null,
          airDate: ep.air_date || null,
          runtime: ep.runtime || null,
        }))
      } catch {
        return []
      }
    },
  }
)

// Lightweight es-ES lookup used by the Kitsu anime plugin: Kitsu only ships
// English metadata, so Details merges the Spanish overview/genres from TMDB.
// Búsqueda multi ligera para autocompletado — pasa por tmdbFetch, así que
// comparte la caché LRU y la deduplicación inflight (una pausa de teclado
// lanza sugerencias+búsqueda a 200ms de diferencia → una sola petición real).
export async function searchMulti(query, signal) {
  const apiKey = getApiKey()
  const data = await tmdbFetch('/search/multi', apiKey, { query, page: 1 }, signal)
  return (data.results || [])
    .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
    .map(item => item.media_type === 'movie'
      ? mapMovie(item, { includeRaw: false })
      : mapSeries(item, { includeRaw: false }))
}

// Búsqueda por categoría: si la query es un género ("terror", "comedia") o
// un keyword de TMDB ("j-horror", "gore", "slasher", "found footage"),
// devuelve lo más popular de esa categoría vía /discover. La búsqueda por
// título sola no basta: "terror" solo devuelve títulos con esa palabra.
const CATEGORY_GENRES = {
  'accion': { movie: 28, tv: 10759 }, 'action': { movie: 28, tv: 10759 },
  'aventura': { movie: 12, tv: 10759 }, 'adventure': { movie: 12, tv: 10759 },
  'animacion': { movie: 16, tv: 16 }, 'animation': { movie: 16, tv: 16 },
  'anime': { movie: 16, tv: 16, origin: 'JP' },
  'comedia': { movie: 35, tv: 35 }, 'comedy': { movie: 35, tv: 35 },
  'crimen': { movie: 80, tv: 80 }, 'crime': { movie: 80, tv: 80 },
  'documental': { movie: 99, tv: 99 }, 'documentary': { movie: 99, tv: 99 },
  'drama': { movie: 18, tv: 18 },
  'familia': { movie: 10751, tv: 10751 }, 'family': { movie: 10751, tv: 10751 },
  'infantil': { movie: 10751, tv: 10762 }, 'kids': { movie: 10751, tv: 10762 },
  'fantasia': { movie: 14, tv: 10765 }, 'fantasy': { movie: 14, tv: 10765 },
  'historia': { movie: 36, tv: null }, 'history': { movie: 36, tv: null },
  'terror': { movie: 27, tv: null }, 'horror': { movie: 27, tv: null },
  'miedo': { movie: 27, tv: null },
  'musica': { movie: 10402, tv: null }, 'music': { movie: 10402, tv: null },
  'misterio': { movie: 9648, tv: 9648 }, 'mystery': { movie: 9648, tv: 9648 },
  'romance': { movie: 10749, tv: null }, 'romantica': { movie: 10749, tv: null },
  'ciencia ficcion': { movie: 878, tv: 10765 }, 'scifi': { movie: 878, tv: 10765 },
  'sci-fi': { movie: 878, tv: 10765 },
  'thriller': { movie: 53, tv: null }, 'suspense': { movie: 53, tv: 9648 },
  'belica': { movie: 10752, tv: 10768 }, 'guerra': { movie: 10752, tv: 10768 },
  'war': { movie: 10752, tv: 10768 },
  'western': { movie: 37, tv: 37 },
  'reality': { movie: null, tv: 10764 },
  'telenovela': { movie: null, tv: 10766 },
  'dorama': { movie: null, tv: 18, origin: 'KR|JP|CN|TW|TH' },
  'kdrama': { movie: null, tv: 18, origin: 'KR' },
  'jdrama': { movie: null, tv: 18, origin: 'JP' },
}

const normCategory = s => (s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim()

// Cache keyword nombre→id (los keywords de TMDB son estables)
const keywordIdCache = new Map()

// Resuelve un keyword exacto de TMDB ("j-horror", "found footage") a su id.
// Solo se acepta cuando el nombre coincide con la query — keywords de un
// solo match aproximado meterían ruido en búsquedas de título normales.
async function tmdbKeywordId(query, apiKey, signal) {
  const key = normCategory(query)
  if (keywordIdCache.has(key)) return keywordIdCache.get(key)
  const data = await tmdbFetch('/search/keyword', apiKey, { query }, signal)
  const hit = (data.results || []).find(k =>
    normCategory(k.name) === key || normCategory(k.name) === key.replace(/\s+/g, '-'))
  const id = hit?.id ?? null
  if (keywordIdCache.size > 100) keywordIdCache.delete(keywordIdCache.keys().next().value)
  keywordIdCache.set(key, id)
  return id
}

export async function searchCategory(query, signal) {
  const apiKey = getApiKey()
  if (!apiKey) return []
  const q = normCategory(query)
  if (q.length < 3 || q.length > 40) return []

  const genre = CATEGORY_GENRES[q]
  const tasks = []
  if (genre) {
    const origin = genre.origin ? { with_origin_country: genre.origin } : {}
    if (genre.movie) {
      tasks.push(tmdbFetch('/discover/movie', apiKey,
        { with_genres: genre.movie, sort_by: 'popularity.desc', ...origin }, signal)
        .then(d => (d.results || []).map(r => mapMovie(r))))
    }
    if (genre.tv) {
      tasks.push(tmdbFetch('/discover/tv', apiKey,
        { with_genres: genre.tv, sort_by: 'popularity.desc', ...origin }, signal)
        .then(d => (d.results || []).map(r => mapSeries(r))))
    } else {
      // TMDB TV no tiene género Terror/Suspense/etc.: intentar el keyword
      // homónimo para traer también series de esa categoría.
      const kwId = await tmdbKeywordId(q, apiKey, signal).catch(() => null)
      if (kwId) {
        tasks.push(tmdbFetch('/discover/tv', apiKey,
          { with_keywords: kwId, sort_by: 'popularity.desc', ...origin }, signal)
          .then(d => (d.results || []).map(r => mapSeries(r))))
      }
    }
  } else if (q.split(/[\s-]+/).length <= 3) {
    // No es un género: intentar keyword TMDB ("j-horror", "gore", …).
    // Limitado a queries cortas para no lanzar una request extra por cada
    // título largo que se busque.
    const kwId = await tmdbKeywordId(q, apiKey, signal)
    if (!kwId) return []
    tasks.push(
      tmdbFetch('/discover/movie', apiKey, { with_keywords: kwId, sort_by: 'popularity.desc' }, signal)
        .then(d => (d.results || []).map(r => mapMovie(r))),
      tmdbFetch('/discover/tv', apiKey, { with_keywords: kwId, sort_by: 'popularity.desc' }, signal)
        .then(d => (d.results || []).map(r => mapSeries(r))),
    )
  }
  if (!tasks.length) return []
  const groups = await Promise.all(tasks.map(p => p.catch(e => {
    if (e?.name === 'AbortError') throw e
    return []
  })))
  return groups.flat()
}

// Resuelve un id externo (IMDb tt*) a ids de TMDB. Usado por proveedores de
// catálogos externos (MDBList, Trakt, Letterboxd, FilmAffinity) que a veces
// solo conocen el imdb_id del item.
export async function findByImdb(imdbId, signal) {
  const apiKey = getApiKey()
  if (!apiKey || !imdbId) return null
  const data = await tmdbFetch(`/find/${imdbId}`, apiKey, { external_source: 'imdb_id' }, signal)
  const movie = data?.movie_results?.[0]
  if (movie) return { type: CONTENT_TYPES.MOVIE, tmdbId: movie.id }
  const tv = data?.tv_results?.[0]
  if (tv) return { type: CONTENT_TYPES.SERIES, tmdbId: tv.id }
  return null
}

export async function searchSpanishInfo(query, signal) {
  const apiKey = getApiKey()
  const data = await tmdbFetch('/search/multi', apiKey, { query, page: 1 }, signal)
  const hits = (data.results || [])
    .filter(r => r.media_type === 'tv' || r.media_type === 'movie')
  const hit = hits.find(r => r.overview) || hits[0]
  if (!hit) return null
  return {
    overview: hit.overview || '',
    name: hit.name || hit.title || '',
    genres: mapGenreIds(hit.genre_ids || [], hit.media_type === 'movie'),
    poster: getImageUrl(hit.poster_path, 'poster', 'w342'),
    backdrop: getImageUrl(hit.backdrop_path, 'backdrop', 'w780'),
  }
}

// Fetch cast for a movie/series from TMDB (loaded separately to avoid blocking getMeta)
export async function getCast(id, signal) {
  const apiKey = getApiKey()
  const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
  if (!match) {
    console.log('[getCast] no match for id:', id)
    return []
  }
  const [, kind, tmdbId] = match
  const endpoint = kind === 'movie' ? `/movie/${tmdbId}/credits` : `/tv/${tmdbId}/credits`
  try {
    // Add 10s timeout - if cast doesn't load fast, skip it
    const timeoutSignal = AbortSignal.timeout(10000)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const data = await tmdbFetch(endpoint, apiKey, {}, combinedSignal)
    if (!data || !data.cast) {
      console.log('[getCast] no cast data for:', id)
      return []
    }
    console.log('[getCast] got', data.cast.length, 'cast members for:', id)
    return data.cast.slice(0, 10).map(c => ({
      id: c.id,
      name: c.name,
      character: c.character,
      photo: c.profile_path ? getImageUrl(c.profile_path, 'profile', 'w185') : null,
    }))
  } catch (e) {
    console.error('[getCast] error:', e.message, 'for:', id)
    return []
  }
}

// Fetch person details (bio, birthday, known_for_department) from TMDB
export async function getPersonDetails(personId, signal) {
  const apiKey = getApiKey()
  try {
    const data = await tmdbFetch(`/person/${personId}`, apiKey, {}, signal)
    if (!data) return null
    return {
      id: data.id,
      name: data.name,
      biography: data.biography || '',
      birthday: data.birthday || '',
      deathday: data.deathday || '',
      placeOfBirth: data.place_of_birth || '',
      knownFor: data.known_for_department || '',
      photo: data.profile_path ? getImageUrl(data.profile_path, 'profile', 'w185') : null,
    }
  } catch {
    return null
  }
}

// Fetch upcoming/recent episodes for a series from TMDB.
// Returns { nextEpisode, lastEpisode, seasonsList } or null.
// nextEpisode: { season, episode, name, airDate, overview, still } or null
// lastEpisode: { season, episode, name, airDate, overview, still } or null
export async function getSeriesUpcoming(id, signal) {
  const apiKey = getApiKey()
  const match = id.match(/^tmdb-(movie|series)-(\d+)$/)
  if (!match) return null
  const [, kind, tmdbId] = match
  if (kind !== 'series') return null
  try {
    const data = await tmdbFetch(`/tv/${tmdbId}`, apiKey, {
      append_to_response: 'next_episode_to_air,last_episode_to_air',
    }, signal)
    if (!data) return null
    const mapEp = (ep) => ep?.air_date ? {
      season: ep.season_number,
      episode: ep.episode_number,
      name: ep.name || '',
      airDate: ep.air_date,
      overview: ep.overview || '',
      still: ep.still_path ? getImageUrl(ep.still_path, 'backdrop', 'w300') : null,
    } : null
    // Series terminadas/canceladas: TMDB a veces conserva un
    // next_episode_to_air obsoleto — no inventar episodios que no existirán.
    const ended = /ended|cancel/i.test(data.status || '')
    const next = mapEp(data.next_episode_to_air)
    return {
      nextEpisode: ended ? null : next,
      lastEpisode: mapEp(data.last_episode_to_air),
      seasonsList: (data.seasons || [])
        .filter(s => s.season_number > 0)
        .map(s => ({
          id: `s${s.season_number}`,
          name: s.name || `Temporada ${s.season_number}`,
          seasonNumber: s.season_number,
          episodeCount: s.episode_count,
          poster: s.poster_path ? getImageUrl(s.poster_path, 'poster', 'w342') : null,
        })),
    }
  } catch {
    return null
  }
}
