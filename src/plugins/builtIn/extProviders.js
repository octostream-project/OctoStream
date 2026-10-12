// Catálogos temáticos externos: MDBList, Trakt, Letterboxd y FilmAffinity.
//
// - MDBList y Trakt son APIs reales pero necesitan API key (ajustes → APIs):
//   octostream_mdblist_key / octostream_trakt_key. Sus catálogos se ocultan
//   del sidebar hasta que la key está configurada (getter en manifest.catalogs).
// - Letterboxd y FilmAffinity no tienen API pública: son scrapers best-effort.
//   Ambos sitios pueden devolver un challenge de Cloudflare; en ese caso el
//   catálogo devuelve [] en vez de romper la UI.
//
// Los items usan ids `tmdb-{movie|series}-{id}` cuando se conoce el tmdb_id,
// así Details/getMeta/streams se resuelven por el pipeline TMDB habitual.
// Cuando solo hay imdb_id/slug, el id es `{plugin}-movie-{ref}` y getMeta del
// propio plugin resuelve a TMDB vía /find o búsqueda.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../base.js'
import { getItemSync } from '../../utils/storage.js'
import { tmdbPlugin, findByImdb, searchMulti } from './tmdb.js'

const TIMEOUT_MS = 15000
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 60

// Pósters por imdb_id sin petición extra (metahub, mismo origen que usa el
// ecosistema Stremio). Si no hay imdb_id la tarjeta muestra título+año.
const metahubPoster = imdbId =>
  imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : null

const apiCache = new Map()

function cacheGet(key) {
  const e = apiCache.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    apiCache.delete(key)
    return null
  }
  return e.data
}

function cacheSet(key, data) {
  if (apiCache.size >= CACHE_MAX) apiCache.delete(apiCache.keys().next().value)
  apiCache.set(key, { data, ts: Date.now() })
}

// Test helper: la caché es a nivel de módulo y sobrevive entre tests.
export function __clearExtProvidersCache() {
  apiCache.clear()
  lbItemCache?.clear()
  faItemCache?.clear()
}

function withTimeout(signal) {
  const t = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : null
  if (!signal) return t || undefined
  if (!t) return signal
  return AbortSignal.any ? AbortSignal.any([signal, t]) : signal
}

async function fetchJson(url, { signal, headers } = {}) {
  const res = await fetch(url, { signal: withTimeout(signal), headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url, { signal, headers } = {}) {
  const res = await fetch(url, {
    signal: withTimeout(signal),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      ...headers,
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// Las páginas servidas por un challenge de Cloudflare se reconocen por su
// título ("Just a moment...") — no intentar parsearlas como contenido.
const isCfChallenge = html => /<title>\s*Just a moment/i.test(html) || html.includes('_cf_chl_opt')

// Items de catálogo mínimos cuando el proveedor solo da nombre/año/póster.
// Así el item se puede abrir en Details aunque falle la resolución a TMDB.
function minimalMeta(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    originalName: item.originalName || item.name,
    year: item.year || null,
    poster: item.poster || null,
    backdrop: null,
    description: '',
  }
}

// Resuelve el getMeta completo de un item externo vía TMDB. Devuelve null si
// no se puede resolver (Details mostrará el fallback mínimo).
async function tmdbMetaFor(type, tmdbId, signal) {
  const id = `tmdb-${type === CONTENT_TYPES.SERIES ? 'series' : 'movie'}-${tmdbId}`
  return tmdbPlugin.getMeta({ type, id, signal })
}

// ============================================================================
// MDBList — https://api.mdblist.com (key gratuita en mdblist.com → preferences)
// ============================================================================

export function getMdblistKey() {
  try { return (getItemSync('octostream_mdblist_key') || '').trim() } catch { return '' }
}

// Listas públicas conocidas de MDBList (usuario/slug).
const MDBLIST_LISTS = [
  ['imdb-top-250-movies', 'IMDb Top 250 películas', 'snoak/imdb-top-250-movies', CONTENT_TYPES.MOVIE],
  ['imdb-top-250-shows', 'IMDb Top 250 series', 'snoak/imdb-top-250-shows', CONTENT_TYPES.SERIES],
  ['trending-movies', 'Películas en tendencia', 'snoak/trending-movies', CONTENT_TYPES.MOVIE],
  ['trending-shows', 'Series en tendencia', 'snoak/trakt-s-trending-shows', CONTENT_TYPES.SERIES],
  ['trending-anime', 'Anime en tendencia', 'snoak/trending-anime-shows', CONTENT_TYPES.SERIES],
  ['week-watched', 'Más vistas esta semana', 'linaspurinis/top-watched-movies-of-the-week', CONTENT_TYPES.MOVIE],
  ['moviemeter-100', 'IMDb MovieMeter Top 100', 'linaspurinis/imdb-moviemeter-top-100', CONTENT_TYPES.MOVIE],
  ['netflix-movies', 'Netflix películas', 'garycrawfordgc/netflix-movies', CONTENT_TYPES.MOVIE],
  ['netflix-shows', 'Netflix series', 'garycrawfordgc/netflix-shows', CONTENT_TYPES.SERIES],
  ['prime-movies', 'Prime Video películas', 'garycrawfordgc/amazon-prime-movies', CONTENT_TYPES.MOVIE],
  ['prime-shows', 'Prime Video series', 'garycrawfordgc/amazon-prime-shows', CONTENT_TYPES.SERIES],
  ['hbo-shows', 'HBO / Max series', 'garycrawfordgc/hbo-shows', CONTENT_TYPES.SERIES],
  ['hulu-movies', 'Hulu películas', 'garycrawfordgc/hulu-movies', CONTENT_TYPES.MOVIE],
  ['hulu-shows', 'Hulu series', 'garycrawfordgc/hulu-shows', CONTENT_TYPES.SERIES],
  ['disney-movies', 'Disney+ películas', 'garycrawfordgc/disney-movies', CONTENT_TYPES.MOVIE],
  ['disney-shows', 'Disney+ series', 'garycrawfordgc/disney-shows', CONTENT_TYPES.SERIES],
  ['bbc-shows', 'BBC series', 'garycrawfordgc/bbc-shows', CONTENT_TYPES.SERIES],
  ['horror', 'Terror', 'garycrawfordgc/horror', CONTENT_TYPES.MOVIE],
  ['horror-shows', 'Series de terror', 'garycrawfordgc/horror-shows', CONTENT_TYPES.SERIES],
  ['thriller', 'Suspense / Thriller', 'garycrawfordgc/thriller', CONTENT_TYPES.MOVIE],
  ['scifi', 'Ciencia ficción', 'garycrawfordgc/sci-fi', CONTENT_TYPES.MOVIE],
  ['comedy', 'Comedia', 'garycrawfordgc/comedy', CONTENT_TYPES.MOVIE],
  ['action', 'Acción', 'garycrawfordgc/action', CONTENT_TYPES.MOVIE],
  ['drama', 'Drama', 'garycrawfordgc/drama', CONTENT_TYPES.MOVIE],
  ['crime', 'Crimen', 'garycrawfordgc/crime', CONTENT_TYPES.MOVIE],
  ['war', 'Bélicas', 'garycrawfordgc/war', CONTENT_TYPES.MOVIE],
  ['latest-bluray', 'Últimos Blu-ray', 'garycrawfordgc/latest-blu-ray-releases', CONTENT_TYPES.MOVIE],
  ['latest-shows', 'Últimas series', 'garycrawfordgc/latest-tv-shows', CONTENT_TYPES.SERIES],
  ['mindfuck', 'Mindfuck / Giros mentales', 'hdlists/mindfuck-movies', CONTENT_TYPES.MOVIE],
  ['retro-80s-90s', 'Nostalgia 80s y 90s', 'hdlists/nostalgiac-movies-from-the-80s-90s', CONTENT_TYPES.MOVIE],
  ['plot-twists', 'Giros de guion', 'hdlists/crazy-plot-twists', CONTENT_TYPES.MOVIE],
  ['rotten-100', '100% en RottenTomatoes', 'hdlists/100-on-rottentomatoes-com', CONTENT_TYPES.MOVIE],
  ['true-story', 'Basadas en hechos reales', 'hdlists/based-on-or-inspired-by-a-true-story', CONTENT_TYPES.MOVIE],
  ['hd-horror', 'Terror mejor valorado', 'hdlists/latest-hd-horror-movies-top-rated-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-scifi-fantasy', 'Fantasía y Sci-Fi mejor valorado', 'hdlists/latest-hd-fantasy-sci-fi-movies-top-rated-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-animated', 'Animación mejor valorada', 'hdlists/latest-hd-animated-movies-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-action', 'Acción mejor valorada', 'hdlists/latest-hd-action-movies-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-drama', 'Drama mejor valorado', 'hdlists/latest-hd-drama-movies-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-superhero', 'Superhéroes', 'hdlists/latest-hd-superhero-movies-from-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-documentary', 'Documentales', 'hdlists/latest-hd-documentary-movies-1980-to-today', CONTENT_TYPES.MOVIE],
  ['hd-mystery', 'Misterio mejor valorado', 'hdlists/latest-hd-mystery-movies-top-rated-from-1980-to-today', CONTENT_TYPES.MOVIE],
]

const MDBLIST_BY_ID = new Map(MDBLIST_LISTS.map(l => [l[0], l]))

// Los items sin tmdb_id pero con imdb_id se resuelven perezosamente en getMeta.
function mapMdblistItem(raw) {
  if (!raw) return null
  const media = raw.mediatype || raw.type || ''
  const type = media === 'show' || media === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
  const kind = type === CONTENT_TYPES.SERIES ? 'series' : 'movie'
  const tmdbId = raw.tmdb_id || raw.tmdbid || null
  const imdbId = raw.imdb_id || null
  const name = raw.title || raw.name || ''
  if (!name || (!tmdbId && !imdbId)) return null
  return {
    id: tmdbId ? `tmdb-${kind}-${tmdbId}` : `mdblist-${kind}-${imdbId}`,
    type,
    name,
    originalName: name,
    year: raw.release_year || raw.year || null,
    poster: metahubPoster(imdbId),
    rating: null,
    imdbId,
  }
}

async function mdblistGetCatalog({ id, skip = 0, top = 50, signal }) {
  const apiKey = getMdblistKey()
  const list = MDBLIST_BY_ID.get(id)
  if (!apiKey || !list) return []
  const [, , ref] = list
  const ck = `mdb:${ref}`
  let items = cacheGet(ck)
  if (!items) {
    const url = `https://api.mdblist.com/lists/${ref}/items?apikey=${encodeURIComponent(apiKey)}`
    const data = await fetchJson(url, { signal })
    const raw = [...(data.movies || []), ...(data.shows || [])]
    items = raw.map(mapMdblistItem).filter(Boolean)
    cacheSet(ck, items)
  }
  return items.slice(skip, skip + top)
}

const mdblistManifest = new PluginManifest({
  id: 'mdblist',
  name: 'MDBList',
  version: '1.0.0',
  description: 'Listas temáticas de MDBList (requiere API key gratuita en Ajustes → APIs)',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  catalogs: [],
  icon: 'list',
})

export const mdblistPlugin = createPlugin(mdblistManifest, {
  getCatalog: mdblistGetCatalog,

  getMeta: async ({ id, signal }) => {
    const m = id.match(/^mdblist-(movie|series)-(.+)$/)
    if (!m) return null
    try {
      const found = await findByImdb(m[2], signal)
      if (found) return tmdbMetaFor(found.type, found.tmdbId, signal)
    } catch { /* sin resolución → meta mínima abajo */ }
    return minimalMeta({ id, type: m[1] === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE, name: m[2], poster: metahubPoster(m[2]) })
  },

  getStreams: async () => [],
  search: async () => [],
})

// Sin API key los catálogos no se muestran en el sidebar.
Object.defineProperty(mdblistManifest, 'catalogs', {
  configurable: true,
  get: () => (getMdblistKey()
    ? MDBLIST_LISTS.map(([id, name, , type]) => ({ id, name: `MDBList · ${name}`, type }))
    : []),
})

// ============================================================================
// Trakt — https://api.trakt.tv (Client ID gratis en trakt.tv/oauth/applications)
// ============================================================================

export function getTraktKey() {
  try { return (getItemSync('octostream_trakt_key') || '').trim() } catch { return '' }
}

const TRAKT_HEADERS = key => ({
  'trakt-api-version': '2',
  'trakt-api-key': key,
  'Content-Type': 'application/json',
})

// Catálogos fijos: endpoint Trakt → tipo. Las respuestas envuelven el objeto
// en `movie`/`show` salvo los endpoints /popular, que lo devuelven directo.
const TRAKT_LISTS = [
  ['trending-movies', 'Tendencia películas', '/movies/trending', CONTENT_TYPES.MOVIE],
  ['trending-shows', 'Tendencia series', '/shows/trending', CONTENT_TYPES.SERIES],
  ['popular-movies', 'Populares películas', '/movies/popular', CONTENT_TYPES.MOVIE],
  ['popular-shows', 'Populares series', '/shows/popular', CONTENT_TYPES.SERIES],
  ['anticipated-movies', 'Más esperadas películas', '/movies/anticipated', CONTENT_TYPES.MOVIE],
  ['anticipated-shows', 'Más esperadas series', '/shows/anticipated', CONTENT_TYPES.SERIES],
  ['boxoffice', 'Taquilla', '/movies/boxoffice', CONTENT_TYPES.MOVIE],
  ['watched-movies', 'Más vistas (semana)', '/movies/watched/weekly', CONTENT_TYPES.MOVIE],
  ['watched-shows', 'Series más vistas (semana)', '/shows/watched/weekly', CONTENT_TYPES.SERIES],
  ['played-movies', 'Más reproducidas (semana)', '/movies/played/weekly', CONTENT_TYPES.MOVIE],
  ['played-shows', 'Series más reproducidas (semana)', '/shows/played/weekly', CONTENT_TYPES.SERIES],
]

const TRAKT_BY_ID = new Map(TRAKT_LISTS.map(l => [l[0], l]))

// Listas de usuario configurables en ajustes: octostream_trakt_lists =
// "usuario/slug, usuario/slug2:Nombre bonito" (separadas por coma).
export function getTraktUserLists() {
  try {
    const raw = getItemSync('octostream_trakt_lists') || ''
    return raw.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).map(entry => {
      const [ref, label] = entry.split(/:(.+)/)
      const slug = ref?.trim()
      if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) return null
      return { ref: slug, name: (label || slug.split('/')[1]).trim() }
    }).filter(Boolean)
  } catch { return [] }
}

function mapTraktItem(raw, kind) {
  const obj = raw?.[kind] || raw?.movie || raw?.show || raw
  if (!obj) return null
  const name = obj.title || ''
  const tmdbId = obj.ids?.tmdb
  const imdbId = obj.ids?.imdb
  const type = kind === 'show' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
  const tkind = type === CONTENT_TYPES.SERIES ? 'series' : 'movie'
  if (!name || (!tmdbId && !imdbId)) return null
  return {
    id: tmdbId ? `tmdb-${tkind}-${tmdbId}` : `trakt-${tkind}-${imdbId}`,
    type,
    name,
    originalName: name,
    year: obj.year || null,
    poster: metahubPoster(imdbId),
    rating: obj.rating || null,
    imdbId,
  }
}

async function traktGetCatalog({ id, skip = 0, top = 50, signal }) {
  const apiKey = getTraktKey()
  if (!apiKey) return []
  const page = Math.floor(skip / top) + 1
  const headers = TRAKT_HEADERS(apiKey)

  // Listas de usuario: id "user-{user}-{slug}"
  const userList = id.match(/^user-list-(.+)$/)
  if (userList) {
    const ref = userList[1].replace(/-/g, '/') // user/slug (slugs no contienen '/')
    const data = await fetchJson(
      `https://api.trakt.tv/users/${ref}/items?page=${page}&limit=${top}`, { signal, headers })
    return (data || []).map(it => mapTraktItem(it, it.type === 'show' ? 'show' : 'movie')).filter(Boolean)
  }

  const list = TRAKT_BY_ID.get(id)
  if (!list) return []
  const [, , endpoint, type] = list
  const ck = `trakt:${endpoint}:${page}:${top}`
  let items = cacheGet(ck)
  if (!items) {
    const data = await fetchJson(`https://api.trakt.tv${endpoint}?page=${page}&limit=${top}`,
      { signal, headers })
    const kind = type === CONTENT_TYPES.SERIES ? 'show' : 'movie'
    items = (data || []).map(it => mapTraktItem(it, kind)).filter(Boolean)
    cacheSet(ck, items)
  }
  return items
}

const traktManifest = new PluginManifest({
  id: 'trakt',
  name: 'Trakt',
  version: '1.0.0',
  description: 'Tendencias y listas de Trakt.tv (requiere Client ID en Ajustes → APIs)',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
  catalogs: [],
  icon: 'trending-up',
})

export const traktPlugin = createPlugin(traktManifest, {
  getCatalog: traktGetCatalog,

  getMeta: async ({ id, signal }) => {
    const m = id.match(/^trakt-(movie|series)-(.+)$/)
    if (!m) return null
    try {
      const found = await findByImdb(m[2], signal)
      if (found) return tmdbMetaFor(found.type, found.tmdbId, signal)
    } catch { /* fallback mínimo */ }
    return minimalMeta({ id, type: m[1] === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE, name: m[2], poster: metahubPoster(m[2]) })
  },

  getStreams: async () => [],
  search: async () => [],
})

Object.defineProperty(traktManifest, 'catalogs', {
  configurable: true,
  get: () => {
    if (!getTraktKey()) return []
    const fixed = TRAKT_LISTS.map(([id, name, , type]) => ({ id, name: `Trakt · ${name}`, type }))
    const custom = getTraktUserLists().map(l => ({
      id: `user-list-${l.ref.replace(/\//g, '-')}`,
      name: `Trakt · ${l.name}`,
      type: CONTENT_TYPES.MOVIE,
    }))
    return [...fixed, ...custom]
  },
})

// ============================================================================
// Letterboxd — scraping best-effort (sin API pública; puede devolver []
// cuando Cloudflare sirve challenge en vez de HTML).
// ============================================================================

const LB_BASE = 'https://letterboxd.com'

const LB_LISTS = [
  ['popular', 'Populares', '/films/popular/'],
  ['this-week', 'Populares esta semana', '/films/popular/this/week/'],
  ['genre-horror', 'Terror', '/films/genre/horror/'],
  ['genre-thriller', 'Suspense', '/films/genre/thriller/'],
  ['genre-scifi', 'Ciencia ficción', '/films/genre/science-fiction/'],
  ['genre-drama', 'Drama', '/films/genre/drama/'],
  ['genre-comedy', 'Comedia', '/films/genre/comedy/'],
  ['genre-action', 'Acción', '/films/genre/action/'],
  ['genre-documentary', 'Documentales', '/films/genre/documentary/'],
  ['genre-animation', 'Animación', '/films/genre/animation/'],
  ['genre-fantasy', 'Fantasía', '/films/genre/fantasy/'],
  ['genre-crime', 'Crimen', '/films/genre/crime/'],
  ['genre-mystery', 'Misterio', '/films/genre/mystery/'],
  ['genre-romance', 'Romance', '/films/genre/romance/'],
  ['genre-war', 'Bélicas', '/films/genre/war/'],
  ['genre-western', 'Western', '/films/genre/western/'],
]

const LB_BY_ID = new Map(LB_LISTS.map(l => [l[0], l]))
const lbItemCache = new Map() // slug → item (para getMeta fallback)

function parseLetterboxdFilms(html) {
  if (isCfChallenge(html)) return []
  const items = []
  const seen = new Set()
  // Bloques <div ... data-film-slug="slug" ...> <img alt="Título" src="poster">
  const re = /data-film-slug="([^"]+)"[^>]*>[\s\S]{0,600}?<img[^>]+alt="([^"]+)"[^>]+src="([^"]+)"/g
  let m
  while ((m = re.exec(html))) {
    const [, slug, name, poster] = m
    if (seen.has(slug)) continue
    seen.add(slug)
    items.push({
      id: `lb-film-${slug}`,
      type: CONTENT_TYPES.MOVIE,
      name: decodeEntities(name.trim()),
      originalName: name.trim(),
      year: null,
      poster: poster.startsWith('http') ? poster : `${LB_BASE}${poster}`,
      slug,
    })
  }
  return items
}

async function lbGetCatalog({ id, skip = 0, top = 50, signal }) {
  const list = LB_BY_ID.get(id)
  if (!list) return []
  const page = Math.floor(skip / top) + 1
  const url = `${LB_BASE}${list[2]}${page > 1 ? `page/${page}/` : ''}`
  const ck = `lb:${url}`
  let items = cacheGet(ck)
  if (!items) {
    const html = await fetchText(url, { signal })
    items = parseLetterboxdFilms(html)
    if (items.length) cacheSet(ck, items)
  }
  items.forEach(it => lbItemCache.set(it.slug, it))
  return items
}

const lbManifest = new PluginManifest({
  id: 'letterboxd',
  name: 'Letterboxd',
  version: '1.0.0',
  description: 'Catálogos de Letterboxd (experimental: puede fallar si el sitio bloquea)',
  types: [CONTENT_TYPES.MOVIE],
  catalogs: LB_LISTS.map(([id, name]) => ({ id, name: `Letterboxd · ${name}`, type: CONTENT_TYPES.MOVIE })),
  icon: 'clapperboard',
})

export const letterboxdPlugin = createPlugin(lbManifest, {
  getCatalog: lbGetCatalog,

  getMeta: async ({ id, signal }) => {
    const m = id.match(/^lb-film-(.+)$/)
    if (!m) return null
    const slug = m[1]
    const cached = lbItemCache.get(slug)
    try {
      // La página de la película enlaza a TMDB en la barra lateral.
      const html = await fetchText(`${LB_BASE}/film/${slug}/`, { signal })
      if (!isCfChallenge(html)) {
        const tmdb = html.match(/themoviedb\.org\/movie\/(\d+)/) ||
                     html.match(/data-tmdb-id="(\d+)"/)
        if (tmdb) {
          const meta = await tmdbMetaFor(CONTENT_TYPES.MOVIE, tmdb[1], signal)
          if (meta) return meta
        }
      }
    } catch { /* cae al mínimo */ }
    return cached ? minimalMeta(cached) : null
  },

  getStreams: async () => [],
  search: async () => [],
})

// ============================================================================
// FilmAffinity — scraping best-effort (mismo caveat de Cloudflare).
// topgen.php devuelve el ranking global; el parámetro de género no filtra por
// query string, así que solo se expone el top general (verificado en vivo).
// ============================================================================

const FA_BASE = 'https://www.filmaffinity.com'
const faItemCache = new Map() // filmId → item

const FA_LISTS = [
  ['top', 'Top FilmAffinity', 'topgen.php'],
]

function parseFilmAffinity(html) {
  if (isCfChallenge(html)) return []
  const items = []
  const seen = new Set()
  // Tarjetas: data-movie-id + data-srcset de pics.filmaffinity + mc-title + mc-year
  const cards = html.split('data-movie-id="').slice(1)
  for (const card of cards) {
    const filmId = card.match(/^(\d+)/)?.[1]
    const title = card.match(/mc-title[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1]?.trim()
    if (!filmId || !title || seen.has(filmId)) continue
    seen.add(filmId)
    const srcset = card.match(/data-srcset="([^"]+)"/)?.[1] || ''
    const poster = (srcset.match(/(https:\/\/pics\.filmaffinity\.com\/[^\s]+?-mmed\.jpg)/) ||
                    srcset.match(/(https:\/\/pics\.filmaffinity\.com\/[^\s]+)/))?.[1] || null
    const year = parseInt(card.match(/mc-year[^>]*>(\d{4})/)?.[1] || '') || null
    const avg = card.match(/class="avg[^"]*">([\d,]+)</)?.[1]
    items.push({
      id: `fa-film-${filmId}`,
      type: CONTENT_TYPES.MOVIE,
      name: decodeEntities(title),
      originalName: title,
      year,
      poster,
      rating: avg ? parseFloat(avg.replace(',', '.')) : null,
      filmId,
    })
  }
  return items
}

async function faGetCatalog({ id, skip = 0, top = 50, signal }) {
  const list = FA_LISTS.find(l => l[0] === id)
  if (!list) return []
  const url = `${FA_BASE}/es/${list[2]}?from=${skip}`
  const ck = `fa:${url}`
  let items = cacheGet(ck)
  if (!items) {
    const html = await fetchText(url, { signal })
    items = parseFilmAffinity(html)
    if (items.length) cacheSet(ck, items)
  }
  items.forEach(it => faItemCache.set(it.filmId, it))
  return items
}

const faManifest = new PluginManifest({
  id: 'filmaffinity',
  name: 'FilmAffinity',
  version: '1.0.0',
  description: 'Top de FilmAffinity en español (experimental: puede fallar si el sitio bloquea)',
  types: [CONTENT_TYPES.MOVIE],
  catalogs: FA_LISTS.map(([id, name]) => ({ id, name: `FilmAffinity · ${name}`, type: CONTENT_TYPES.MOVIE })),
  icon: 'award',
})

export const filmaffinityPlugin = createPlugin(faManifest, {
  getCatalog: faGetCatalog,

  getMeta: async ({ id, signal }) => {
    const m = id.match(/^fa-film-(\d+)$/)
    if (!m) return null
    const cached = faItemCache.get(m[1])
    try {
      // Ficha FA → título español + año → búsqueda TMDB → meta completa.
      // El título en español casa muy bien con los sitios de streams.
      const html = await fetchText(`${FA_BASE}/es/film${m[1]}.html`, { signal })
      if (!isCfChallenge(html)) {
        const title = decodeEntities(
          (html.match(/<h1[^>]*id="main-title"[^>]*>[\s\S]*?<span[^>]*>([^<]+)</)?.[1] ||
           html.match(/og:title" content="([^"]+)"/)?.[1] || '').trim())
        const year = parseInt(html.match(/<dd[^>]*itemprop="datePublished"[^>]*>[^<]*?(\d{4})/)?.[1] ||
                              html.match(/dd-show.*?(\d{4})/s)?.[1] ||
                              cached?.year || '')
        if (title) {
          const hits = await searchMulti(title, signal)
          const hit = hits.find(h => h.year && year && Math.abs(h.year - year) <= 1) || hits[0]
          if (hit) {
            const meta = await tmdbPlugin.getMeta({ type: hit.type, id: hit.id, signal })
            if (meta) return meta
          }
        }
      }
    } catch { /* cae al mínimo */ }
    return cached ? minimalMeta(cached) : null
  },

  getStreams: async () => [],
  search: async () => [],
})

// ============================================================================
// Helpers compartidos
// ============================================================================

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
}
