import { createPlugin, PluginManifest, CONTENT_TYPES } from './base.js'

const CINEMETA_BASE = 'https://cinemeta-catalogs.strem.io/top'

function mapItem(item) {
  if (!item) return null
  const type = item.type === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
  const genres = Array.isArray(item.genres) ? item.genres : (item.genre ? (Array.isArray(item.genre) ? item.genre : item.genre.split(',').map(g => g.trim())) : [])
  return {
    id: `${type === CONTENT_TYPES.SERIES ? 'series' : 'movie'}:${item.imdb_id || item.id}`,
    imdbId: item.imdb_id || item.id,
    type,
    name: item.name,
    poster: item.poster,
    backdrop: item.background || item.poster,
    description: item.description,
    year: item.year ? parseInt(item.year) : null,
    rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
    genres,
    releaseDate: item.released,
    logo: item.logo,
  }
}

function mapMeta(data) {
  if (!data) return null
  const type = data.type === 'series' ? CONTENT_TYPES.SERIES : CONTENT_TYPES.MOVIE
  const genres = Array.isArray(data.genres) ? data.genres : (data.genre ? (Array.isArray(data.genre) ? data.genre : data.genre.split(',').map(g => g.trim())) : [])
  const meta = {
    id: `${type === CONTENT_TYPES.SERIES ? 'series' : 'movie'}:${data.imdb_id || data.id}`,
    imdbId: data.imdb_id || data.id,
    type,
    name: data.name,
    poster: data.poster,
    backdrop: data.background || data.poster,
    description: data.description,
    year: data.year ? parseInt(data.year) : null,
    rating: data.imdbRating ? parseFloat(data.imdbRating) : null,
    genres,
    releaseDate: data.released,
    runtime: data.runtime,
    logo: data.logo,
    cast: [],
    trailer: null,
    similar: [],
    recommendations: [],
  }

  if (data.trailers && data.trailers.length > 0) {
    const yt = data.trailers.find(t => t.source === 'YouTube') || data.trailers[0]
    if (yt && (yt.videoId || yt.source)) {
      const videoId = yt.videoId || yt.source
      meta.trailer = `https://www.youtube.com/embed/${videoId}`
    }
  }

  if (data.trailerStreams && data.trailerStreams.length > 0 && !meta.trailer) {
    const ts = data.trailerStreams[0]
    if (ts.ytId) {
      meta.trailer = `https://www.youtube.com/embed/${ts.ytId}`
    }
  }

  if (data.cast) {
    const castArr = Array.isArray(data.cast) ? data.cast : data.cast.split(',').map(c => c.trim())
    meta.cast = castArr.slice(0, 10).map((name, i) => ({
      id: i,
      name: typeof name === 'string' ? name : name.name,
      character: typeof name === 'object' ? name.character : null,
      photo: typeof name === 'object' && name.profile_path ? `https://image.tmdb.org/t/p/w185${name.profile_path}` : null,
    }))
  }

  if (data.credits_cast && data.credits_cast.length > 0) {
    meta.cast = data.credits_cast.slice(0, 10).map((c, i) => ({
      id: c.id || i,
      name: c.name,
      character: c.character,
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    }))
  }

  if (data.director) {
    meta.director = Array.isArray(data.director) ? data.director.join(', ') : data.director
  }

  if (data.type === 'series' && data.videos) {
    const seasonsMap = {}
    data.videos.forEach(ep => {
      if (!seasonsMap[ep.season]) {
        seasonsMap[ep.season] = {
          id: `s${ep.season}`,
          name: `Temporada ${ep.season}`,
          seasonNumber: ep.season,
          episodeCount: 0,
          episodes: [],
        }
      }
      seasonsMap[ep.season].episodeCount++
      seasonsMap[ep.season].episodes.push({
        id: ep.id,
        name: ep.name || `T${ep.season}E${ep.episode}`,
        season: ep.season,
        episode: ep.episode,
        description: ep.overview,
        thumbnail: ep.thumbnail,
      })
    })
    meta.seasonsList = Object.values(seasonsMap).sort((a, b) => a.seasonNumber - b.seasonNumber)
    meta.episodes = data.videos.map(ep => ({
      id: ep.id,
      name: ep.name || `T${ep.season}E${ep.episode}`,
      season: ep.season,
      episode: ep.episode,
      description: ep.overview,
      thumbnail: ep.thumbnail,
    })).sort((a, b) => a.season - b.season || a.episode - b.episode)
  }

  return meta
}

async function cinemetaFetch(path) {
  const url = `${CINEMETA_BASE}${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Cinemeta error: ${res.status}`)
  return res.json()
}

const CATALOG_MAP = {
  'movie-top': { type: 'movie', id: 'top', name: 'Top Películas' },
  'movie-featured': { type: 'movie', id: 'imdbRating', name: 'Destacadas' },
  'movie-action': { type: 'movie', id: 'top', genre: 'Action', name: 'Acción' },
  'movie-comedy': { type: 'movie', id: 'top', genre: 'Comedy', name: 'Comedia' },
  'movie-horror': { type: 'movie', id: 'top', genre: 'Horror', name: 'Terror' },
  'movie-scifi': { type: 'movie', id: 'top', genre: 'Sci-Fi', name: 'Ciencia Ficción' },
  'movie-drama': { type: 'movie', id: 'top', genre: 'Drama', name: 'Drama' },
  'movie-animation': { type: 'movie', id: 'top', genre: 'Animation', name: 'Animación' },
  'movie-thriller': { type: 'movie', id: 'top', genre: 'Thriller', name: 'Thriller' },
  'movie-2025': { type: 'movie', id: 'top', year: 2025, name: 'Estrenos 2025' },
  'movie-2024': { type: 'movie', id: 'top', year: 2024, name: 'Estrenos 2024' },
  'series-top': { type: 'series', id: 'top', name: 'Top Series' },
  'series-featured': { type: 'series', id: 'imdbRating', name: 'Series Destacadas' },
  'series-action': { type: 'series', id: 'top', genre: 'Action', name: 'Series de Acción' },
  'series-comedy': { type: 'series', id: 'top', genre: 'Comedy', name: 'Series de Comedia' },
  'series-drama': { type: 'series', id: 'top', genre: 'Drama', name: 'Series de Drama' },
  'series-2025': { type: 'series', id: 'top', year: 2025, name: 'Series 2025' },
  'series-2024': { type: 'series', id: 'top', year: 2024, name: 'Series 2024' },
}

export const cinemetaPlugin = createPlugin(
  new PluginManifest({
    id: 'cinemeta',
    name: 'Cinemeta - Películas y Series (Sin API Key)',
    version: '1.0.0',
    description: 'Catálogo de películas y series con datos reales usando la API pública de Stremio Cinemeta. Sin necesidad de configurar API key.',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES],
    catalogs: [
      { id: 'movie-top', name: 'Top Películas', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-featured', name: 'Destacadas', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-action', name: 'Acción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-comedy', name: 'Comedia', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-horror', name: 'Terror', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-scifi', name: 'Ciencia Ficción', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-drama', name: 'Drama', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-animation', name: 'Animación', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-thriller', name: 'Thriller', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2025', name: 'Estrenos 2025', type: CONTENT_TYPES.MOVIE },
      { id: 'movie-2024', name: 'Estrenos 2024', type: CONTENT_TYPES.MOVIE },
      { id: 'series-top', name: 'Top Series', type: CONTENT_TYPES.SERIES },
      { id: 'series-featured', name: 'Series Destacadas', type: CONTENT_TYPES.SERIES },
      { id: 'series-action', name: 'Series de Acción', type: CONTENT_TYPES.SERIES },
      { id: 'series-comedy', name: 'Series de Comedia', type: CONTENT_TYPES.SERIES },
      { id: 'series-drama', name: 'Series de Drama', type: CONTENT_TYPES.SERIES },
      { id: 'series-2025', name: 'Series 2025', type: CONTENT_TYPES.SERIES },
      { id: 'series-2024', name: 'Series 2024', type: CONTENT_TYPES.SERIES },
    ],
    icon: 'film',
  }),
  {
    getCatalog: async ({ id, skip = 0, top = 50 }) => {
      const cat = CATALOG_MAP[id]
      if (!cat) return []
      const needsFilter = cat.genre || cat.year
      let allItems = []
      if (needsFilter) {
        const pagesToFetch = Math.ceil((skip + top) / 100) + 1
        for (let p = 0; p < pagesToFetch; p++) {
          const pageSkip = p * 100
          const url = `/catalog/${cat.type}/${cat.id}.json?skip=${pageSkip}`
          try {
            const data = await cinemetaFetch(url)
            const metas = data.metas || []
            if (metas.length === 0) break
            allItems.push(...metas)
          } catch { break }
        }
      } else {
        const url = `/catalog/${cat.type}/${cat.id}.json${skip > 0 ? `?skip=${skip}` : ''}`
        const data = await cinemetaFetch(url)
        allItems = data.metas || []
      }
      let items = allItems.map(mapItem).filter(Boolean)
      if (cat.genre) {
        items = items.filter(item => item.genres && item.genres.some(g => g === cat.genre))
      }
      if (cat.year) {
        items = items.filter(item => item.year === cat.year)
      }
      return items.slice(skip, skip + top)
    },

    getMeta: async ({ type, id }) => {
      const parts = id.split(':')
      const kind = parts[0] === 'series' ? 'series' : 'movie'
      const imdbId = parts[1] || id
      const data = await cinemetaFetch(`/meta/${kind}/${imdbId}.json`)
      return mapMeta(data.meta)
    },

    getStreams: async ({ type, id, name }) => {
      const parts = id.split(':')
      const imdbId = parts[1] || id
      const kind = parts[0] === 'series' ? 'tv' : 'movie'
      const titleName = name || ''

      const streams = []

      streams.push({
        name: 'YouTube - Película Completa',
        url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' pelicula completa en español')}`,
        streamType: 'embed',
        quality: 'Gratis',
      })

      streams.push({
        name: 'YouTube - Película (English)',
        url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' full movie')}`,
        streamType: 'embed',
        quality: 'Free',
      })

      streams.push({
        name: 'YouTube - Tráiler',
        url: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titleName + ' trailer oficial español')}`,
        streamType: 'embed',
        quality: 'Tráiler',
      })

      streams.push({
        name: 'Archive.org - Dominio Público',
        url: `https://archive.org/embed/?q=${encodeURIComponent(titleName)}`,
        streamType: 'embed',
        quality: 'Gratis',
      })

      streams.push({
        name: 'Plex - Gratis con anuncios',
        url: `https://www.plex.tv/watch-free-to-watch-movies-online/?query=${encodeURIComponent(titleName)}`,
        streamType: 'embed',
        quality: 'Gratis',
      })

      streams.push({
        name: 'Tubi (EEUU)',
        url: `https://tubitv.com/search/${encodeURIComponent(titleName)}`,
        streamType: 'embed',
        quality: 'Gratis',
      })

      streams.push({
        name: 'Pluto TV',
        url: `https://pluto.tv/en/on-demand/search/details?query=${encodeURIComponent(titleName)}`,
        streamType: 'embed',
        quality: 'Gratis',
      })

      return streams
    },

    search: async ({ query }) => {
      const results = []
      try {
        const movies = await cinemetaFetch(`/catalog/movie/search=${encodeURIComponent(query)}.json`)
        results.push(...(movies.metas || []).map(mapItem).filter(Boolean))
      } catch {}
      try {
        const series = await cinemetaFetch(`/catalog/series/search=${encodeURIComponent(query)}.json`)
        results.push(...(series.metas || []).map(mapItem).filter(Boolean))
      } catch {}
      return results
    },
  }
)
