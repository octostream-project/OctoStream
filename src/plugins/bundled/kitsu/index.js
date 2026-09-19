// Anime plugin backed by Kitsu (https://kitsu.io — JSON:API, free, no key).
// Keeps the plugin id 'anilist' and the same catalog IDs so Home.jsx,
// PluginManager configs and stored IDs keep working.
//
// Item IDs: `anilist-anime-k<kitsuId>`. Legacy `anilist-anime-<malId>` IDs
// (favorites/history saved while Jikan/AniList were in use) are resolved
// through Kitsu's mappings endpoint in getMeta.

import { createPlugin, PluginManifest, CONTENT_TYPES } from '../../base.js'
import { searchSpanishInfo } from '../../builtIn/tmdb.js'
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

        // En paralelo: sinopsis/géneros en español desde TMDB (Kitsu solo
        // tiene inglés) y similares por primera categoría.
        const firstCat = (res?.included || []).find(i => i.type === 'categories')
        const [esInfo, simRes] = await Promise.allSettled([
          searchSpanishInfo(base.originalName || name, signal)
            .then(r => r || searchSpanishInfo(base.englishName || name, signal)),
          firstCat?.attributes?.slug
            ? kitsuSimilar(firstCat.attributes.slug, base.kitsuId, signal)
            : Promise.resolve(null),
        ])

        const es = esInfo.status === 'fulfilled' ? esInfo.value : null
        if (es?.overview) base.description = es.overview
        if ((!base.genres || base.genres.length === 0) && es?.genres?.length) {
          base.genres = es.genres
        }
        // Fallbacks de imagen desde TMDB por si media.kitsu.app falla con el proxy
        if (es?.poster && !base.posterFallback) base.posterFallback = es.poster
        if (es?.backdrop && !base.backdrop) base.backdrop = es.backdrop

        if (simRes.status === 'fulfilled' && simRes.value?.data) {
          base.recommendations = simRes.value.data
            .map(a => mapKitsuAnime(a, 'anime'))
            .filter(Boolean)
        }

        // Generate episodes for the Details page. Kitsu's /episodes endpoint
        // is paginated and heavy; episode titles aren't needed because stream
        // plugins resolve by series name + episode number. Season and episode
        // cards reuse the series poster/backdrop (Kitsu has no per-episode art).
        const epPoster = base.backdrop || es?.backdrop || base.poster
        let epCount = anime.attributes?.episodeCount || 0
        // Series en emisión devuelven episodeCount=null (p.ej. One Piece).
        // El endpoint /episodes expone el total real emitido en meta.count.
        if (!epCount && anime.attributes?.subtype !== 'movie') {
          try {
            epCount = await kitsuEpisodeCount(anime.id, signal)
          } catch { /* sin episodios */ }
        }
        const isMovie = anime.attributes?.subtype === 'movie'
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
