// Plan de carga en background: tras el arranque precalienta las cachés de
// contenido en orden de prioridad — TMDB → anime → deportes — para que cada
// sección abra al instante al navegar. Las fases van en ese orden, las
// peticiones de cada fase corren en paralelo y todo el proceso es "fire and
// forget": nunca bloquea la UI ni compite con el primer pintado (que ya es
// TMDB — las mismas peticiones se deduplican en el inflight del plugin).
//
// En deportes la prioridad interna es: primero los directos de DLive (sus
// canales emiten 24/7 — siempre hay algo que ver aunque FCTV aún no haya
// publicado el partido), luego el catálogo FCTV + índice de sitemaps, y al
// final el calendario Sofascore.
//
// Las cachés que se calientan (TTL entre paréntesis):
//   tmdb.js      — LRU de respuestas API (10 min)
//   kitsu/api.js — LRU de respuestas (10 min)
//   dlive        — scheduleCache compartido por todos sus catálogos (5 min)
//   fctv         — resolveConfig (30 min), listCache (1 min), sitemapIdx (6 h)
//   sofascore.js — leagueEventsCache (1 h)

import { pluginManager } from '../plugins/manager.js'
import { waitForWarp } from './warpStatus.js'
import { logWarn } from './logger.js'

// Filas iniciales de cada pestaña TMDB de Inicio (las mismas que pinta Home
// al abrir cada tab — con la caché caliente el cambio de pestaña es instantáneo).
const TMDB_WARM = [
  { id: 'movie-popular', type: 'movie' }, { id: 'movie-top-rated', type: 'movie' },
  { id: 'movie-action', type: 'movie' }, { id: 'movie-comedy', type: 'movie' },
  { id: 'tv-popular', type: 'series' }, { id: 'tv-top-rated', type: 'series' },
  { id: 'tv-on-air', type: 'series' }, { id: 'tv-airing-today', type: 'series' },
  { id: 'tv-dorama-kr', type: 'series' }, { id: 'tv-dorama-jp', type: 'series' },
  { id: 'tv-dorama-cn', type: 'series' },
]

const ANIME_WARM = [
  'anime-popular', 'anime-trending', 'anime-top-rated', 'anime-seasonal',
]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// true cuando la app está oculta: en segundo plano el túnel WARP se apaga a
// los 30s y las peticiones morirían contra el proxy muerto — mejor parar.
const hidden = () => typeof document !== 'undefined' && document.hidden

async function warmTmdb() {
  await Promise.allSettled(TMDB_WARM.map(c =>
    pluginManager.getCatalogContent('tmdb', c.id, c.type, 0, 20)))
}

async function warmAnime() {
  // Kitsu serializa sus peticiones con una pausa de 150 ms (cortesía con su
  // API); el Promise.allSettled solo las encola — no es una ráfaga real.
  await Promise.allSettled(ANIME_WARM.map(id =>
    pluginManager.getCatalogContent('anilist', id, 'anime', 0, 20)))
}

async function warmSports() {
  // DLive primero y solo: fetchAllEvents llena el scheduleCache compartido,
  // así que una llamada calienta TODOS los catálogos dlive-* a la vez.
  await pluginManager.getCatalogContent('dlive', 'dlive-live', 'channel', 0, 500)
    .catch(() => {})
  if (hidden()) return
  const [{ fctvWarmupSitemap }, { fetchLeagueEvents }, { CAL_LEAGUES, MARCA_TO_SOFA }] =
    await Promise.all([
      import('../plugins/bundled/fctv/index.js'),
      import('./sofascore.js'),
      import('../data/sportsLeagues.js'),
    ])
  await Promise.allSettled([
    // Catálogo FCTV: calienta resolveConfig aunque /api/match/live vaya tras
    // el challenge de Cloudflare (devuelve vacío pero la config queda).
    pluginManager.getCatalogContent('fctv', 'fctv-football', 'channel', 0, 500),
    fctvWarmupSitemap(),
    // Calendario Sofascore: el mismo troceado de 4 que usa Sports.jsx.
    (async () => {
      for (let i = 0; i < CAL_LEAGUES.length && !hidden(); i += 4) {
        await Promise.allSettled(CAL_LEAGUES.slice(i, i + 4).map(lg =>
          fetchLeagueEvents(MARCA_TO_SOFA[lg.name] || lg.name, 'football', undefined, lg.utId || null)))
      }
    })(),
  ])
}

// Orden del plan: TMDB → anime → deportes.
const PHASES = [warmTmdb, warmAnime, warmSports]

const REWARM_MS = 10 * 60 * 1000 // re-calentar como mucho cada 10 min
let lastRunAt = 0
let running = null

export function startLoadPlan() {
  if (running) return running
  if (Date.now() - lastRunAt < REWARM_MS) return Promise.resolve(false)
  lastRunAt = Date.now()
  running = (async () => {
    try {
      await pluginManager.ensureReady()
      // Misma barrera anti-fuga que las páginas: no lanzar tráfico mientras
      // WARP aún negocia el túnel.
      await waitForWarp()
      for (const phase of PHASES) {
        if (hidden()) break
        try { await phase() } catch (e) {
          logWarn('[LoadPlan] fase falló:', String(e?.message || e))
        }
        await sleep(400) // respiro entre fases: la UI siempre tiene prioridad
      }
      return true
    } catch {
      return false
    } finally {
      running = null
    }
  })()
  return running
}
