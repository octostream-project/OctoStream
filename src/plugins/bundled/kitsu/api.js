// Kitsu API client (JSON:API). Free, no API key, tolerant rate limits.
// Independent of MyAnimeList — Jikan/AniList were unreachable on-device.
// https://kitsu.docs.apiary.io/

import { httpGetJson } from '../../../utils/httpClient.js'

const KITSU_BASE = 'https://kitsu.io/api/edge'

// In-memory LRU cache (200 entries, 10 min TTL).
const cache = new Map()
const CACHE_TTL = 10 * 60 * 1000
const CACHE_MAX = 200

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.data
}

function setCached(key, data) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  cache.set(key, { data, ts: Date.now() })
}

// Serial queue with a short gap: Kitsu tolerates bursts but we stay polite
// and it prevents parallel catalog storms on Android.
let requestQueue = Promise.resolve()
const GAP_MS = 150

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function enqueue(task) {
  const run = requestQueue.then(task)
  requestQueue = run.then(() => sleep(GAP_MS), () => sleep(GAP_MS))
  return run
}

async function requestJson(url, signal, attempt = 0) {
  try {
    return await httpGetJson(url, { 'Accept': 'application/vnd.api+json' }, signal)
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) throw e
    const status = e?.httpStatus ?? (Number((e?.message || '').match(/HTTP (\d+)/)?.[1]) || 0)
    const retryable = status === 429 || status >= 500 || status === 0
    if (attempt < 1 && retryable) {
      await sleep(1200)
      return requestJson(url, signal, attempt + 1)
    }
    throw e
  }
}

export async function kitsuGet(path, params = {}, signal) {
  const qs = new URLSearchParams(params).toString()
  const url = `${KITSU_BASE}${path}${qs ? '?' + qs : ''}`
  const cached = getCached(url)
  if (cached) return cached

  try {
    const data = await enqueue(() => requestJson(url, signal))
    setCached(url, data)
    return data
  } catch (e) {
    console.warn(`[Anime] fetch failed: ${path}:`, e?.message || e)
    throw e
  }
}

// List anime with sort/filters. filters = { subtype, categories, season, seasonYear, text }
export async function kitsuAnime(params = {}, signal) {
  const query = {
    'page[limit]': Math.min(params.limit || 20, 20),
    'page[offset]': params.offset || 0,
    'sort': params.sort || 'popularityRank',
  }
  const f = params.filters || {}
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== '') query[`filter[${k}]`] = v
  }
  return kitsuGet('/anime', query, signal)
}

// Trending anime (Kitsu curated list)
export async function kitsuTrending(params = {}, signal) {
  return kitsuGet('/trending/anime', {
    'page[limit]': Math.min(params.limit || 20, 20),
    'page[offset]': params.offset || 0,
  }, signal)
}

// Single anime by Kitsu id, with categories included for genres
export async function kitsuAnimeById(id, signal) {
  return kitsuGet(`/anime/${id}`, { include: 'categories' }, signal)
}

// Resolve a legacy MAL id to the Kitsu anime resource
export async function kitsuByMalId(malId, signal) {
  const res = await kitsuGet('/mappings', {
    'filter[externalSite]': 'myanimelist/anime',
    'filter[externalId]': String(malId),
    'page[limit]': 1,
    'include': 'item',
  }, signal)
  const item = (res?.included || []).find(i => i.type === 'anime')
  if (item) return { data: item }
  return null
}

// Total aired episodes for an anime (meta.count on the episodes endpoint).
// Needed when attributes.episodeCount is null (ongoing series like One Piece).
export async function kitsuEpisodeCount(kitsuId, signal) {
  const res = await kitsuGet('/episodes', {
    'filter[mediaId]': String(kitsuId),
    'page[limit]': 1,
    'fields[episodes]': 'number',
  }, signal)
  return res?.meta?.count || 0
}

// Search by title text
export async function kitsuSearch(query, params = {}, signal) {
  return kitsuAnime({
    limit: params.limit || 20,
    offset: params.offset || 0,
    sort: params.sort || 'popularityRank',
    filters: { text: query, subtype: params.subtype },
  }, signal)
}

// Similar: top anime sharing the first category slug
export async function kitsuSimilar(categorySlug, excludeKitsuId, signal) {
  return kitsuAnime({
    limit: 7,
    sort: 'popularityRank',
    filters: { categories: categorySlug },
  }, signal).then(res => ({
    ...res,
    data: (res?.data || []).filter(a => a.id !== String(excludeKitsuId)).slice(0, 6),
  }))
}

// Kitsu categories/status come in English only — translate the common ones.
const CATEGORY_ES = {
  'action': 'Acción', 'adventure': 'Aventura', 'comedy': 'Comedia',
  'drama': 'Drama', 'fantasy': 'Fantasía', 'horror': 'Terror',
  'mystery': 'Misterio', 'romance': 'Romance', 'science-fiction': 'Ciencia Ficción',
  'sci-fi': 'Ciencia Ficción', 'slice-of-life': 'Recuentos de la vida',
  'supernatural': 'Sobrenatural', 'psychological': 'Psicológico',
  'thriller': 'Suspense', 'sports': 'Deportes', 'historical': 'Histórico',
  'mecha': 'Mecha', 'music': 'Música', 'school': 'Escolar',
  'isekai': 'Isekai', 'martial-arts': 'Artes Marciales', 'military': 'Militar',
  'samurai': 'Samurái', 'space': 'Espacial', 'super-power': 'Superpoderes',
  'vampire': 'Vampiros', 'demons': 'Demonios', 'magic': 'Magia',
}

const STATUS_ES = {
  current: 'En emisión', finished: 'Finalizado', tba: 'Por confirmar',
  upcoming: 'Próximamente', unreleased: 'Sin estrenar',
}

// Map a Kitsu anime resource to our internal item format.
// `included` optionally carries the categories array from ?include=categories.
export function mapKitsuAnime(resource, type = 'anime', included = []) {
  if (!resource) return null
  const a = resource.attributes || {}
  const titles = a.titles || {}
  // Romanized JP title first: it's how Spanish-speaking fans know anime
  // ("Shingeki no Kyojin", not "Attack on Titan").
  const name = titles.en_jp || a.canonicalTitle || titles.en || titles.ja_jp || ''
  const poster = a.posterImage?.large || a.posterImage?.medium || a.posterImage?.small || a.posterImage?.original || null

  // Resolve genres from the categories relationship + included array
  const catIds = new Set((resource.relationships?.categories?.data || []).map(c => c.id))
  const genres = included
    .filter(i => i.type === 'categories' && catIds.has(i.id))
    .map(c => CATEGORY_ES[c.attributes?.slug] || c.attributes?.title?.en || c.attributes?.slug)
    .filter(Boolean)

  const rating = a.averageRating ? Number(a.averageRating) / 10 : null
  return {
    id: `anilist-anime-k${resource.id}`,
    type: type === 'anime' ? 'anime' : 'series',
    name,
    originalName: titles.en_jp || titles.ja_jp || name,
    englishName: titles.en || name,
    poster,
    posterFallback: a.posterImage?.medium || a.posterImage?.original || null,
    backdrop: a.coverImage?.large || a.coverImage?.original || poster,
    description: (a.synopsis || a.description || '').replace(/\r?\n+/g, ' ').trim(),
    year: a.startDate ? Number(String(a.startDate).slice(0, 4)) : null,
    rating: rating && !Number.isNaN(rating) ? Number(rating.toFixed(1)) : null,
    genres,
    status: STATUS_ES[a.status] || a.status || '',
    episodeCount: a.episodeCount || null,
    duration: a.episodeLength ? `${a.episodeLength} min` : null,
    studio: [],
    kitsuId: Number(resource.id),
    malId: null,
    format: a.subtype || a.showType || '',
    isAdult: a.nsfw === true || a.ageRating === 'R18',
  }
}
