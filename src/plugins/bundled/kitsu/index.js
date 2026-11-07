// Anime plugin backed by Kitsu (https://kitsu.io — JSON:API, free, no key).
// Keeps the plugin id 'anilist' and the same catalog IDs so Home.jsx,
// PluginManager configs and stored IDs keep working.
//
// Item IDs: `anilist-anime-k<kitsuId>`. Legacy `anilist-anime-<malId>` IDs
// (favorites/history saved while Jikan/AniList were in use) are resolved
// through Kitsu's mappings endpoint in getMeta.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { searchSpanishInfo, findTmdbMatch, getTmdbMeta } from '../../builtIn/tmdb.js'
import {
  kitsuAnime, kitsuTrending, kitsuAnimeById, kitsuByMalId, kitsuSearch,
  kitsuSimilar, kitsuEpisodeCount, mapKitsuAnime,
} from './api.js'

// Kitsu category slugs for filter[categories]=
const GENRES = {
  action: 'action',
  comedy: 'comedy',
  drama: 'drama',
  fantasy: 'fantasy',
  horror: 'horror',
  mystery: 'mystery',
  romance: 'romance',
  scifi: 'science-fiction',
  sliceoflife: 'slice-of-life',
  supernatural: 'supernatural',
  psychological: 'psychological',
  thriller: 'thriller',
}

function currentSeason() {
  const m = new Date().getMonth()
  return ['winter', 'winter', 'winter', 'spring', 'spring', 'spring',
    'summer', 'summer', 'summer', 'fall', 'fall', 'fall'][m]
}

// Catalog definitions: same IDs as before so Home.jsx stays unchanged.
const CATALOG_CONFIGS = {
  'anime-popular': { sort: 'popularityRank', label: 'Anime Popular' },
  'anime-top-rated': { sort: 'ratingRank', label: 'Mejor Valorado' },
  'anime-trending': { trending: true, label: 'Tendencias' },
  'anime-favorites': { sort: '-favoritesCount', label: 'Favoritos' },
  'anime-newest': { sort: '-startDate', label: 'Más Recientes' },
  'anime-action': { genre: GENRES.action, label: 'Acción' },
  'anime-comedy': { genre: GENRES.comedy, label: 'Comedia' },
  'anime-drama': { genre: GENRES.drama, label: 'Drama' },
  'anime-fantasy': { genre: GENRES.fantasy, label: 'Fantasía' },
  'anime-romance': { genre: GENRES.romance, label: 'Romance' },
  'anime-scifi': { genre: GENRES.scifi, label: 'Ciencia Ficción' },
  'anime-horror': { genre: GENRES.horror, label: 'Terror' },
  'anime-slice-of-life': { genre: GENRES.sliceoflife, label: 'Recuentos de la vida' },
  'anime-mystery': { genre: GENRES.mystery, label: 'Misterio' },
  'anime-thriller': { genre: GENRES.thriller, label: 'Suspense' },
  'anime-supernatural': { genre: GENRES.supernatural, label: 'Sobrenatural' },
  'anime-psychological': { genre: GENRES.psychological, label: 'Psicológico' },
  'anime-movie': { subtype: 'movie', label: 'Películas Anime' },
  'anime-tv': { subtype: 'TV', label: 'Series Anime' },
  'anime-ona': { subtype: 'ONA', label: 'ONA (Net/Web)' },
  'anime-seasonal': { seasonal: true, label: 'Esta Temporada' },
}

export const kitsuFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'anilist', // Keep 'anilist' as plugin id so Home.jsx TAB_PLUGIN stays the same
    name: config.manifest?.name || 'Anime (Kitsu)',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'Catálogo de anime con sinopsis, géneros y episodios desde Kitsu.',
    types: [CONTENT_TYPES.ANIME, CONTENT_TYPES.SERIES],
    catalogs: Object.entries(CATALOG_CONFIGS).map(([id, cfg]) => ({
      id,
      name: cfg.label,
      type: CONTENT_TYPES.ANIME,
    })),
    icon: 'film',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 50, signal }) {
      const cfg = CATALOG_CONFIGS[id]
      if (!cfg) return []
      const limit = Math.min(top, 20) // Kitsu max page[limit] is 20
      try {
        let data
        if (cfg.trending) {
          data = await kitsuTrending({ limit, offset: skip }, signal)
        } else {
          const filters = {}
          if (cfg.subtype) filters.subtype = cfg.subtype
          if (cfg.genre) filters.categories = cfg.genre
          if (cfg.seasonal) {
            filters.season = currentSeason()
            filters.seasonYear = new Date().getFullYear()
          }
          data = await kitsuAnime({ limit, offset: skip, sort: cfg.sort || 'popularityRank', filters }, signal)
        }
        const media = data?.data || []
        console.warn(`[Anime] getCatalog ${id}: ${media.length} items`)
        return media.map(m => mapKitsuAnime(m, 'anime')).filter(Boolean)
      } catch (e) {
        console.warn(`[Anime] getCatalog failed for ${id}:`, e?.message)
        return []
      }
    },

    async getMeta({ id, signal }) {
      const kitsuMatch = id.match(/^anilist-anime-k(\d+)$/)
      const legacyMatch = id.match(/^(?:anilist|jikan)-anime-(\d+)$/)
      if (!kitsuMatch && !legacyMatch) return null
      try {
        // Legacy IDs carry a MAL id — resolve it through Kitsu mappings.
        const res = kitsuMatch
          ? await kitsuAnimeById(kitsuMatch[1], signal)
          : await kitsuByMalId(legacyMatch[1], signal)
        const anime = res?.data
        if (!anime || anime.type !== 'anime') return null
        const base = mapKitsuAnime(anime, 'anime', res?.included || [])
        if (!base) return null

        const name = base.name || base.originalName || 'Anime'
        const isMovieSubtype = anime.attributes?.subtype === 'movie'

        // La ficha se enriquece con la entrada TMDB del mismo título:
        // sinopsis en español, géneros, rating, trailer, reparto, similares
        // y origen JP — lo que la página de detalles muestra para el resto
        // del catálogo. Kitsu aporta episodios, estado y póster propios.
        const firstCat = (res?.included || []).find(i => i.type === 'categories')
        const simPromise = firstCat?.attributes?.slug
          ? kitsuSimilar(firstCat.attributes.slug, base.kitsuId, signal).catch(() => null)
          : Promise.resolve(null)

        const queries = [...new Set(
          [base.originalName, base.englishName, name].filter(q => q && q.length >= 3)
        )]
        let tmdbHit = null
        for (const q of queries) {
          tmdbHit = await findTmdbMatch(q, {
            prefer: isMovieSubtype ? 'movie' : 'series',
            year: base.year,
            signal,
          }).catch(() => null)
          if (tmdbHit) break
        }
        const tmdb = tmdbHit
          ? await getTmdbMeta(tmdbHit.kind, tmdbHit.tmdbId, signal).catch(() => null)
          : null

        if (tmdb) {
          base.tmdbKind = tmdbHit.kind
          base.tmdbId = tmdbHit.tmdbId
          if (tmdb.description) base.description = tmdb.description
          if (tmdb.genres?.length) base.genres = tmdb.genres
          if (tmdb.rating != null) base.rating = tmdb.rating
          if (tmdb.year) base.year = tmdb.year
          if (tmdb.runtime) base.runtime = tmdb.runtime
          if (tmdb.trailer) { base.trailer = tmdb.trailer; base.trailerKey = tmdb.trailerKey }
          if (tmdb.cast?.length) base.cast = tmdb.cast
          if (tmdb.originCountry) base.originCountry = tmdb.originCountry
          if (tmdb.originalLanguage) base.originalLanguage = tmdb.originalLanguage
          if (tmdb.imdbId) base.imdbId = tmdb.imdbId
          if (tmdb.englishName && !base.englishName) base.englishName = tmdb.englishName
          if (!base.poster && tmdb.poster) base.poster = tmdb.poster
          if (!base.posterFallback && tmdb.poster) base.posterFallback = tmdb.poster
          if (!base.backdrop && tmdb.backdrop) base.backdrop = tmdb.backdrop
          if (tmdb.similar?.length) base.similar = tmdb.similar
          if (tmdb.recommendations?.length) base.recommendations = tmdb.recommendations
        } else {
          // Sin ficha TMDB: solo sinopsis/géneros en español (comportamiento anterior)
          const es = await searchSpanishInfo(base.originalName || name, signal)
            .then(r => r || searchSpanishInfo(base.englishName || name, signal))
            .catch(() => null)
          if (es?.overview) base.description = es.overview
          if ((!base.genres || base.genres.length === 0) && es?.genres?.length) {
            base.genres = es.genres
          }
          if (es?.poster && !base.posterFallback) base.posterFallback = es.poster
          if (es?.backdrop && !base.backdrop) base.backdrop = es.backdrop
        }

        const simRes = await simPromise
        if ((!base.recommendations || base.recommendations.length === 0) && simRes?.data) {
          base.recommendations = simRes.data
            .map(a => mapKitsuAnime(a, 'anime'))
            .filter(Boolean)
        }

        // Generate episodes for the Details page. Kitsu's /episodes endpoint
        // is paginated and heavy; episode titles aren't needed because stream
        // plugins resolve by series name + episode number. Season and episode
        // cards reuse the series poster/backdrop (Kitsu has no per-episode art).
        const epPoster = base.backdrop || tmdb?.backdrop || base.poster
        const isMovie = isMovieSubtype
        if (!isMovie && tmdb?.seasonsList?.length > 0) {
          // Con ficha TMDB mandan sus temporadas (los cours reales con
          // nombre y recuento). No se genera meta.episodes plano: Details
          // crea placeholders por temporada y findProviderEpisode convierte
          // (temporada, episodio relativo del cour) a episodio absoluto,
          // que es como indexan los providers de anime.
          base.seasonsList = tmdb.seasonsList
        } else {
          let epCount = anime.attributes?.episodeCount || 0
          // Series en emisión devuelven episodeCount=null (p.ej. One Piece).
          // El endpoint /episodes expone el total real emitido en meta.count.
          if (!epCount && anime.attributes?.subtype !== 'movie') {
            try {
              epCount = await kitsuEpisodeCount(anime.id, signal)
            } catch { /* sin episodios */ }
          }
          // Kitsu no siempre sabe cuántos episodios hay (obras antiguas,
          // catálogo incompleto): la ficha TMDB trae episode_count por
          // temporada y el número de episodio del anime es continuo entre
          // cours, así que la suma equivale al conteo absoluto.
          if (!epCount && !isMovie && tmdb?.seasonsList?.length) {
            epCount = tmdb.seasonsList.reduce((n, s) => n + (s.episodeCount || 0), 0)
          }
          if (isMovie || epCount === 1) {
            base.seasonsList = [{ seasonNumber: 1, name, episodeCount: 1, poster: base.poster }]
            base.episodes = [{ id: `${base.id}-ep1`, season: 1, episode: 1, name, poster: epPoster }]
          } else if (epCount > 0) {
            base.seasonsList = [{ seasonNumber: 1, name, episodeCount: epCount, poster: base.poster }]
            base.episodes = Array.from({ length: epCount }, (_, i) => ({
              id: `${base.id}-ep${i + 1}`,
              season: 1,
              episode: i + 1,
              name: `Episodio ${i + 1}`,
              poster: epPoster,
            }))
          }
        }

        return base
      } catch (e) {
        console.warn(`[Anime] getMeta failed for ${id}:`, e?.message)
        return null
      }
    },

    async getStreams() {
      // Metadata-only plugin; streams come from other plugins (Plurtasko…).
      return []
    },

    async search({ query, signal }) {
      try {
        const data = await kitsuSearch(query, { limit: 20 }, signal)
        const media = data?.data || []
        return media.map(m => mapKitsuAnime(m, 'anime')).filter(Boolean)
      } catch (e) {
        console.warn('[Anime] search failed:', e?.message)
        return []
      }
    },
  })
}
