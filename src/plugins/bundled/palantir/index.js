// Palantir 3 — catálogo moria (SQLite local, ~29k películas + ~8.8k series).
// Los enlaces son 1fichier cifrados (AES-OFB, descifrado nativo) y requieren
// debrid (AllDebrid/RealDebrid) que se resuelve al pulsar play (streamType
// 'debrid' → Details.handlePlay).
import { PluginManifest, createPlugin, CONTENT_TYPES } from '../../base.js'
import { isAvailable, ensureInstalled, maybeUpdate, getStatus, query, decryptLinks } from './db.js'

const TMDB_IMG = 'https://image.tmdb.org/t/p/'

// catalog id -> { table, where, type }
const CATALOGS = {
  'palantir-peliculas':   { table: 'pelis',  type: CONTENT_TYPES.MOVIE,  where: "categoria = 'Película'" },
  'palantir-pelis-anime': { table: 'pelis',  type: CONTENT_TYPES.ANIME,  where: "categoria IN ('Anime','Dibujo')" },
  'palantir-docs':        { table: 'pelis',  type: CONTENT_TYPES.MOVIE,  where: "categoria LIKE 'D%cumental'" },
  'palantir-musica':      { table: 'pelis',  type: CONTENT_TYPES.MOVIE,  where: "categoria = 'Música'" },
  'palantir-series':      { table: 'series', type: CONTENT_TYPES.SERIES, where: "categoria IN ('General','Novela','Reality')" },
  'palantir-retro':       { table: 'series', type: CONTENT_TYPES.SERIES, where: "categoria = 'Retro'" },
  'palantir-anime':       { table: 'series', type: CONTENT_TYPES.ANIME,  where: "categoria IN ('Anime','Dibujo')" },
  'palantir-docuseries':  { table: 'series', type: CONTENT_TYPES.SERIES, where: "categoria = 'Documental'" },
}

const LINKS_TABLE = { pelis: 'enlaces_pelis', series: 'enlaces_series' }

const img = (path, size) =>
  typeof path === 'string' && path.startsWith('/') ? `${TMDB_IMG}${size}${path}` : null

const parseId = (id) => {
  const m = String(id || '').match(/^palantir:(movie|series):(\d+)$/)
  return m ? { table: m[1] === 'movie' ? 'pelis' : 'series', tmdb: Number(m[2]) } : null
}

const itemId = (table, tmdb) => `palantir:${table === 'pelis' ? 'movie' : 'series'}:${tmdb}`

function rowToItem(row, table, type) {
  return {
    id: itemId(table, row.tmdb),
    type,
    name: row.titulo,
    title: row.titulo,
    year: (row.fecha || '').slice(0, 4),
    poster: img(row.poster, 'w342'),
    rating: row.rating ? Number(String(row.rating).split('/')[0]) || null : null,
    pluginId: 'palantir',
  }
}

// Solo comprueba que la DB existe — nunca instala. getMeta/getStreams/search se
// invocan para ids de otros plugins, así que no pueden disparar la descarga.
async function readyOrEmpty() {
  if (!isAvailable()) return false
  const st = await getStatus()
  if (st.installed) { maybeUpdate(); return true }
  return false
}

// Solo el catálogo (acción explícita del usuario) instala la DB si falta.
async function readyOrInstall() {
  if (!isAvailable()) return false
  const ok = await ensureInstalled()
  if (ok) maybeUpdate()
  return ok
}

export const palantirFactory = (config) => {
  const manifest = new PluginManifest({
    id: 'palantir',
    name: config.manifest?.name || 'Palantir 3',
    version: config.manifest?.version || '1.0.0',
    description: config.manifest?.description || 'Catálogo Palantir 3 (moria): películas, series, anime y documentales vía debrid.',
    types: [CONTENT_TYPES.MOVIE, CONTENT_TYPES.SERIES, CONTENT_TYPES.ANIME],
    catalogs: [
      { id: 'palantir-peliculas',   name: 'Palantir Películas',       type: CONTENT_TYPES.MOVIE },
      { id: 'palantir-series',      name: 'Palantir Series',          type: CONTENT_TYPES.SERIES },
      { id: 'palantir-anime',       name: 'Palantir Anime Series',    type: CONTENT_TYPES.ANIME },
      { id: 'palantir-pelis-anime', name: 'Palantir Anime Películas', type: CONTENT_TYPES.ANIME },
      { id: 'palantir-docs',        name: 'Palantir Documentales',    type: CONTENT_TYPES.MOVIE },
      { id: 'palantir-docuseries',  name: 'Palantir Docuseries',      type: CONTENT_TYPES.SERIES },
      { id: 'palantir-musica',      name: 'Palantir Música',          type: CONTENT_TYPES.MOVIE },
      { id: 'palantir-retro',       name: 'Palantir Retro',           type: CONTENT_TYPES.SERIES },
    ],
    icon: 'film',
  })

  return createPlugin(manifest, {
    isExternal: true,
    isBundled: true,
    originalManifest: config.manifest,

    async getCatalog({ id, skip = 0, top = 50, signal }) {
      if (signal?.aborted || !(await readyOrInstall())) return []
      const cat = CATALOGS[id]
      if (!cat) return []
      const links = LINKS_TABLE[cat.table]
      const rows = await query(
        `SELECT p.tmdb, p.titulo, p.fecha, p.poster, p.rating FROM ${cat.table} p` +
        ` WHERE ${cat.where.replace(/(^|\s)categoria/g, '$1p.categoria')}` +
        ` AND EXISTS (SELECT 1 FROM ${links} e WHERE e.tmdb = p.tmdb)` +
        ` ORDER BY p.updated DESC LIMIT ? OFFSET ?`,
        [top, skip]
      )
      return rows.map(r => rowToItem(r, cat.table, cat.type))
    },

    async getMeta({ id, signal }) {
      const ref = parseId(id)
      if (!ref || signal?.aborted || !(await readyOrEmpty())) return null
      const rows = await query(`SELECT * FROM ${ref.table} WHERE tmdb = ?`, [ref.tmdb])
      const r = rows[0]
      if (!r) return null
      const meta = {
        id,
        type: ref.table === 'pelis' ? CONTENT_TYPES.MOVIE : CONTENT_TYPES.SERIES,
        name: r.titulo,
        title: r.titulo,
        description: r.plot || '',
        poster: img(r.poster, 'w342'),
        backdrop: img(r.fondo, 'w1280'),
        background: img(r.fondo, 'w1280'),
        logo: img(r.clearlogo, 'w500'),
        year: (r.fecha || '').slice(0, 4),
        releaseInfo: r.fecha || '',
        genres: (r.genero || '').split('#').filter(Boolean),
        rating: r.rating ? Number(String(r.rating).split('/')[0]) || null : null,
        runtime: r.duration ? Math.round(Number(r.duration) / 60) : null,
        trailer: r.trailer ? `https://www.youtube.com/watch?v=${r.trailer}` : null,
        collection: r.coleccion || '',
        mpaa: r.mpaa || '',
        pluginId: 'palantir',
      }
      if (ref.table === 'series') {
        const eps = await query(
          'SELECT temporada, episodio FROM enlaces_series WHERE tmdb = ?' +
          ' GROUP BY temporada, episodio ORDER BY temporada, episodio',
          [ref.tmdb]
        )
        meta.episodes = eps.map(e => ({
          id: `${id}:s${e.temporada}e${e.episodio}`,
          season: e.temporada,
          episode: e.episodio,
          name: `Episodio ${e.episodio}`,
        }))
        const counts = new Map()
        for (const e of eps) {
          if (e.temporada > 0) counts.set(e.temporada, (counts.get(e.temporada) || 0) + 1)
        }
        meta.seasonsList = [...counts.entries()].map(([n, c]) => ({
          seasonNumber: n,
          name: `Temporada ${n}`,
          episodeCount: c,
          poster: meta.poster,
        }))
      }
      return meta
    },

    async getStreams({ id, season, episode, signal }) {
      const ref = parseId(id)
      if (!ref || signal?.aborted || !(await readyOrEmpty())) return []
      const rows = ref.table === 'pelis'
        ? await query('SELECT link, calidad, audio, info FROM enlaces_pelis WHERE tmdb = ?', [ref.tmdb])
        : await query(
            'SELECT link, calidad, audio, info FROM enlaces_series WHERE tmdb = ? AND temporada = ? AND episodio = ?',
            [ref.tmdb, season ?? 1, episode ?? 1]
          )
      if (!rows.length) return []
      const urls = await decryptLinks(rows.map(r => r.link))
      return rows.map((r, i) => {
        const url = urls[i]
        if (!url || !/^https?:\/\//.test(url)) return null
        const audio = (r.audio || '').toUpperCase()
        const info = r.info ? ` · ${r.info}` : ''
        return {
          name: 'Palantir',
          title: `1fichier ${r.calidad || ''} ${audio}${info}`.replace(/\s+/g, ' ').trim(),
          server: '1fichier',
          pluginName: 'Palantir',
          url,
          // Marcado para resolución lazy vía AllDebrid/RealDebrid en handlePlay.
          streamType: 'debrid',
          quality: r.calidad || '',
          lang: audio,
        }
      }).filter(Boolean)
    },

    async search({ query: q, signal }) {
      if (signal?.aborted || !q || !(await readyOrEmpty())) return []
      const pattern = `%${String(q).replace(/[%_]/g, '')}%`
      const [pelis, series] = await Promise.all([
        query(
          `SELECT tmdb, titulo, fecha, poster, rating FROM pelis` +
          ` WHERE titulo LIKE ? AND EXISTS (SELECT 1 FROM enlaces_pelis e WHERE e.tmdb = pelis.tmdb)` +
          ` ORDER BY updated DESC LIMIT 40`,
          [pattern]
        ),
        query(
          `SELECT tmdb, titulo, fecha, poster, rating FROM series` +
          ` WHERE titulo LIKE ? AND EXISTS (SELECT 1 FROM enlaces_series e WHERE e.tmdb = series.tmdb)` +
          ` ORDER BY updated DESC LIMIT 40`,
          [pattern]
        ),
      ])
      return [
        ...pelis.map(r => rowToItem(r, 'pelis', CONTENT_TYPES.MOVIE)),
        ...series.map(r => rowToItem(r, 'series', CONTENT_TYPES.SERIES)),
      ]
    },
  })
}
