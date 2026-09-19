// SeriesYonkis channel - películas, series y animes en español
// API: /wp-api/v1/listing, /wp-api/v1/single, /wp-api/v1/player, /wp-api/v1/search

import { CONTENT_TYPES } from '../../../base.js'
import { httpGetJson } from '../../../../utils/httpClient.js'
import { normalizeServer } from '../scraper.js'

const HOST = 'https://seriesyonkis.cx/'
const API = `${HOST}wp-api/v1/`

const TYPE_MAP = {
  movies: CONTENT_TYPES.MOVIE,
  tvshows: CONTENT_TYPES.SERIES,
  animes: CONTENT_TYPES.ANIME,
}

export const seriesyonkissx = {
  id: 'seriesyonkissx',
  name: 'SeriesYonkis',
  types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME],
  host: HOST,

  catalogs: [
    { id: 'seriesyonkissx-movies', name: 'SeriesYonkis: Películas', type: CONTENT_TYPES.MOVIE },
    { id: 'seriesyonkissx-series', name: 'SeriesYonkis: Series', type: CONTENT_TYPES.SERIES },
    { id: 'seriesyonkissx-anime', name: 'SeriesYonkis: Anime', type: CONTENT_TYPES.ANIME },
  ],

  async getCatalog({ id, skip = 0, top = 50 }) {
    const postType = id === 'seriesyonkissx-movies' ? 'movies'
      : id === 'seriesyonkissx-anime' ? 'animes' : 'tvshows'
    const page = Math.floor(skip / top) + 1
    const url = `${API}listing/${postType}?postType=${postType}&range=day&orderBy=latest&order=desc&postsPerPage=${top}&page=${page}`
    let data
    try {
      data = await httpGetJson(url, { 'User-Agent': 'Mozilla/5.0' })
    } catch { return [] }
    if (!data || data.error || !data.data || !data.data.posts) return []

    return data.data.posts.map(p => ({
      id: `seriesyonkissx:${postType}:${p.slug}`,
      type: TYPE_MAP[postType],
      name: p.title || '',
      title: p.title || '',
      poster: p.images?.poster ? `${HOST}wp-content/uploads${p.images.poster}` : null,
      url: `${HOST}${postType === 'movies' ? 'peliculas' : postType === 'animes' ? 'animes' : 'series'}/${p.slug}/`,
      pluginId: 'plurtasko',
    }))
  },

  async getMeta({ id }) {
    // ID format: seriesyonkissx:{postType}:{slug}
    const parts = id.replace(/^seriesyonkissx:/, '').split(':')
    if (parts.length < 2) return null
    const postType = parts[0]
    const slug = parts.slice(1).join(':')
    const type = TYPE_MAP[postType]
    if (!type) return null

    const url = `${API}single/${postType}?slug=${encodeURIComponent(slug)}&postType=${postType}`
    let data
    try {
      data = await httpGetJson(url, { 'User-Agent': 'Mozilla/5.0' })
    } catch { return null }
    if (!data || data.error || !data.data) return null

    const d = data.data
    const meta = {
      id,
      type,
      name: d.title || '',
      title: d.title || '',
      poster: d.images?.poster ? `${HOST}wp-content/uploads${d.images.poster}` : null,
      backdrop: d.images?.backdrop ? `${HOST}wp-content/uploads${d.images.backdrop}` : null,
      description: d.overview || '',
      year: d.release_date ? parseInt(d.release_date.slice(0, 4), 10) : null,
      url: `${HOST}${postType === 'movies' ? 'peliculas' : postType === 'animes' ? 'animes' : 'series'}/${d.slug}/`,
      pluginId: 'plurtasko',
    }

    if (type !== CONTENT_TYPES.MOVIE && d._id) {
      meta.episodes = await this._getEpisodes(d._id)
    }
    return meta
  },

  async _getEpisodes(showId) {
    const episodes = []
    // Fetch season 1 first, then try other seasons
    for (let season = 1; season <= 1; season++) {
      const url = `${API}single/episodes/list?_id=${showId}&season=${season}&page=1&postsPerPage=100`
      let data
      try {
        data = await httpGetJson(url, { 'User-Agent': 'Mozilla/5.0' })
      } catch { break }
      if (!data || data.error || !data.data || !data.data.posts) break

      for (const ep of data.data.posts) {
        episodes.push({
          id: `seriesyonkissx:episodes:${ep._id}`,
          name: `S${ep.season_number}E${ep.episode_number}`,
          season: ep.season_number,
          episode: ep.episode_number,
          url: `${HOST}episodio/${ep.slug}/`,
          _postId: ep._id,
        })
      }
      // If no episodes in season 1, stop
      if (data.data.posts.length === 0) break
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
    return episodes
  },

  async getStreams({ id }) {
    // ID format: seriesyonkissx:{postType}:{slug} for movies
    // or seriesyonkissx:episodes:{postId} for episodes
    let postId
    if (id.startsWith('seriesyonkissx:episodes:')) {
      postId = id.replace('seriesyonkissx:episodes:', '')
    } else {
      // Movie: need to get _id from meta
      const meta = await this.getMeta({ id })
      if (!meta || !meta.url) return []
      // Extract _id from the meta URL
      const parts = id.replace(/^seriesyonkissx:/, '').split(':')
      const postType = parts[0]
      const slug = parts.slice(1).join(':')
      const url = `${API}single/${postType}?slug=${encodeURIComponent(slug)}&postType=${postType}`
      let data
      try {
        data = await httpGetJson(url, { 'User-Agent': 'Mozilla/5.0' })
      } catch { return [] }
      if (!data || data.error || !data.data) return []
      postId = data.data._id
    }

    if (!postId) return []

    // Get player data
    const playerUrl = `${API}player?postId=${postId}&demo=0`
    let playerData
    try {
      playerData = await httpGetJson(playerUrl, { 'User-Agent': 'Mozilla/5.0' })
    } catch { return [] }
    if (!playerData || playerData.error || !playerData.data || !playerData.data.embeds) return []

    const streams = []
    for (const embed of playerData.data.embeds) {
      const url = embed.url
      if (!url) continue
      const server = this._detectServer(url)
      if (!server) continue

      let lang = ''
      if (/castellano|esp/i.test(embed.lang || '')) lang = 'Esp'
      else if (/latino|lat/i.test(embed.lang || '')) lang = 'Lat'
      else if (/sub|vose/i.test(embed.lang || '')) lang = 'Vose'

      streams.push({
        name: `${server}${lang ? ` (${lang})` : ''}`,
        url,
        streamType: normalizeServer(server),
        quality: embed.quality || '',
        server,
        lang,
        pluginName: 'SeriesYonkis',
        pluginId: 'plurtasko',
      })
    }

    return streams
  },

  _detectServer(url) {
    const u = url.toLowerCase()
    if (/voe|voex|voe\.sx/.test(u)) return 'voe'
    if (/streamwish|streamsss|wish|sbspeed|sbplay|watchsb|lvturbo|hlswish/.test(u)) return 'streamwish'
    if (/filemoon|filelions|fmoon/.test(u)) return 'filemoon'
    if (/vidhide/.test(u)) return 'vidhide'
    if (/streamtape/.test(u)) return 'streamtape'
    if (/doodstream|dood\./.test(u)) return 'doodstream'
    if (/mixdrop/.test(u)) return 'mixdrop'
    if (/upstream/.test(u)) return 'upstream'
    if (/uqload/.test(u)) return 'uqload'
    if (/mp4upload/.test(u)) return 'mp4upload'
    if (/yourupload/.test(u)) return 'yourupload'
    if (/ok\.ru|odnoklassniki/.test(u)) return 'okru'
    if (/kwik/.test(u)) return 'kwik'
    if (/vidmoly/.test(u)) return 'vidmoly'
    if (/vidoza/.test(u)) return 'vidoza'
    if (/supervideo/.test(u)) return 'supervideo'
    if (/fastplay/.test(u)) return 'fastplay'
    if (/lulustream/.test(u)) return 'lulustream'
    if (/maxstream/.test(u)) return 'maxstream'
    if (/sendvid/.test(u)) return 'sendvid'
    if (/turbovid/.test(u)) return 'turbovid'
    if (/goodstream/.test(u)) return 'goodstream'
    if (/vimeos/.test(u)) return 'vimeos'
    if (/lamovie|la\.movie/.test(u)) return 'lamovie'
    if (/videoapp/.test(u)) return 'videoapp'
    if (/fastream/.test(u)) return 'fastream'
    if (/\.mp4|\.mkv|\.m3u8/.test(u)) return 'directo'
    return ''
  },

  async search({ query, type }) {
    // Search across all post types or specific one
    const postTypes = type === CONTENT_TYPES.MOVIE ? ['movies']
      : type === CONTENT_TYPES.ANIME ? ['animes']
      : type === CONTENT_TYPES.SERIES ? ['tvshows']
      : ['movies', 'tvshows', 'animes']

    const items = []
    for (const postType of postTypes) {
      const url = `${API}search?q=${encodeURIComponent(query)}&postType=${postType}&postsPerPage=50&page=1&orderBy=latest&order=desc`
      let data
      try {
        data = await httpGetJson(url, { 'User-Agent': 'Mozilla/5.0' })
      } catch { continue }
      if (!data || data.error || !data.data || !data.data.posts) continue

      for (const p of data.data.posts) {
        items.push({
          id: `seriesyonkissx:${postType}:${p.slug}`,
          type: TYPE_MAP[postType],
          name: p.title || '',
          title: p.title || '',
          poster: p.images?.poster ? `${HOST}wp-content/uploads${p.images.poster}` : null,
          url: `${HOST}${postType === 'movies' ? 'peliculas' : postType === 'animes' ? 'animes' : 'series'}/${p.slug}/`,
          pluginId: 'plurtasko',
        })
      }
    }
    return items
  },
}
