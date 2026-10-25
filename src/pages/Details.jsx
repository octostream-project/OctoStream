import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useParams, useNavigate } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import { tmdbPlugin, getCast, getPersonDetails } from '../plugins/builtIn/tmdb.js'
import { useStore } from '../store/useStore.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import LazyImage from '../components/LazyImage.jsx'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'
import { inferStreamType } from '../utils/streamType.js'
import { parseStreamLang, parseStreamQuality, sortByLangPriority } from '../utils/streamMeta.js'
import StreamList from '../components/StreamList.jsx'
import Modal from '../components/ui/Modal.jsx'
import { toast } from '../components/ui/Toast.jsx'
import { resolveEmbed } from '../plugins/bundled/plurtasko/resolver.js'
import { isAlldebridEnabled, hasAnyDebrid, unlockLink as adUnlockLink, uploadMagnet as adUploadMagnet } from '../plugins/bundled/alldebrid.js'
import { getDebridJob, trackMagnet, adoptDebridMagnets, btihOf, resolveDebridJob } from '../utils/debridJobs.js'
import { resolveYouTubeStream } from '../utils/youtube.js'
import { waitForWarp } from '../utils/warpStatus.js'
import { httpGetText } from '../utils/httpClient.js'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { switchChannel, stopPlayback } from '../utils/exoPlayer.js'
import { getTorrentEngine } from '../utils/torrentEngine.js'
import { formatDuration } from '../utils/format.js'
import { useWindowedList } from '../hooks/useWindowedList.js'
import { Play, Heart, Star, ArrowLeft, Clock, Users, Film as FilmIcon, RotateCcw, AlertCircle, Check, Download, Bookmark, X } from 'lucide-react'
import OctoLoader from '../components/OctoLoader.jsx'
import LogoLoader from '../components/LogoLoader.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'

const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

// Unlock a file-host link (1fichier, etc.) through the configured debrid
// service. Returns a direct URL or null.
async function unlockDebrid(url) {
  if (!isAlldebridEnabled()) return { link: null, error: 'Configura AllDebrid en Ajustes → Debrid.' }
  try {
    const result = await adUnlockLink(url)
    return result?.link
      ? { link: result.link }
      : { link: null, error: result?.error || 'AllDebrid no pudo desbloquear el enlace.' }
  } catch (e) {
    console.warn('[Details] AllDebrid unlock failed:', e?.message)
    return { link: null, error: e?.message || 'AllDebrid unlock failed' }
  }
}

// Mensaje legible según el error del debrid.
function debridErrorMessage(err) {
  const e = String(err || '')
  if (/software caused connection abort|ECONNABORTED|connection reset|socket hang up/i.test(e)) {
    return 'Se cortó la conexión con el servicio debrid y no se recibió confirmación. Comprueba la red y reintenta en unos segundos.'
  }
  if (/error scanning this link|offline or inaccessible|try a different link/i.test(e)) {
    return 'AllDebrid no puede acceder a este enlace original: puede estar caído, requerir sesión o no ser compatible. Prueba otro servidor.'
  }
  if (/unavailable|hoster_unavailable|LINK_DOWN|LINK_TEMPORARY/i.test(e)) return 'Enlace caído en el servidor de descarga. Prueba otro.'
  if (/token|apikey|auth|premium|MUST_BE_PREMIUM/i.test(e)) return 'Revisa la API key y tu suscripción de AllDebrid en Ajustes → Debrid.'
  // Diagnóstico: el mensaje genérico ocultaba el error real de la API
  // (p. ej. bloqueo por IP del túnel). Se muestra el motivo crudo.
  return `No se pudo desbloquear el enlace (debrid): ${e || 'error desconocido'}`
}

export default function Details() {
  const { type, id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // Selectores individuales: useStore() sin selector suscribe a TODA la store
  // y re-renderiza la página entera en cada update (watchHistory cambia cada
  // ~10s durante la reproducción).
  // Subscribe to favorites array directly so toggleFavorite triggers re-render.
  // Selecting the isFavorite function does NOT re-render when favorites change
  // (the function reference is stable), so the heart color never updates.
  const favorites = useStore(s => s.favorites)
  const watchlist = useStore(s => s.watchlist)
  const toggleFavorite = useStore(s => s.toggleFavorite)
  const toggleWatchlist = useStore(s => s.toggleWatchlist)
  const addToHistory = useStore(s => s.addToHistory)
  const updateProgress = useStore(s => s.updateProgress)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  // Suscripción granular al historial: updateProgress reescribe el item cada
  // ~5s durante la reproducción; devolver una clave estable evita re-renderizar
  // toda la ficha salvo que cambie algo realmente visible (episodio, % entero
  // de progreso o bloques de 30s).
  const historyKey = useStore(s => {
    const h = s.watchHistory.find(x => x.id === id && x.type === type)
    return h
      ? [h.season, h.episode, h.episodeName, h.server, h.duration,
         Math.round((h.progress || 0) * 100), Math.floor((h.currentTime || 0) / 30)].join('|')
      : ''
  })
  const historyItem = useMemo(
    () => useStore.getState().watchHistory.find(h => h.id === id && h.type === type) || null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyKey, id, type])
  const [meta, setMeta] = useState(null)
  const [streams, setStreams] = useState([])
  const [loading, setLoading] = useState(true)
  const [cast, setCast] = useState([])
  const [castLoading, setCastLoading] = useState(false)
  const [selectedStream, setSelectedStream] = useState(null)
  // Timer para el autoplay diferido (60s): permite al usuario elegir stream manualmente
  const autoplayTimerRef = useRef(null)
  // Marca el autoplay de navegación ("Seguir viendo") como consumido para no
  // re-dispararlo en re-renders posteriores.
  const autoplayConsumedRef = useRef(false)
  // Guard: evita que onPlayNext (popup) y handleEnded disparen el siguiente
  // episodio dos veces. Se resetea al seleccionar un episodio manualmente.
  const nextEpisodeTriggeredRef = useRef(false)
  const [selectedEpisode, setSelectedEpisode] = useState(null)
  // Lista de canales para zapping nativo cuando se reproduce un canal en directo
  const [liveChannels, setLiveChannels] = useState([])
  const liveChannelsRef = useRef([])
  liveChannelsRef.current = liveChannels
  // Canal actual para guardar al cerrar el player (igual que LiveTV.jsx)
  const currentChannelRef = useRef(null)
  const [resumeTime, setResumeTime] = useState(0)
  const [showResumeDialog, setShowResumeDialog] = useState(false)
  const [selectedSeason, setSelectedSeason] = useState(null)
  const [seasonEpisodes, setSeasonEpisodes] = useState([])
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  // Montaje progresivo de la lista de episodios (series/anime con 500+ episodios)
  const episodesWindow = useWindowedList(seasonEpisodes, 60, 60)
  const [episodeError, setEpisodeError] = useState(null)
  const [view, setView] = useState('series') // 'series' | 'season' | 'episode'
  const [episodeStreams, setEpisodeStreams] = useState([])
  // Picker de archivo dentro del torrent (packs multi-archivo):
  // {stream, files, skipResume, candidatesPool} mientras el diálogo está abierto.
  const [torrentPick, setTorrentPick] = useState(null)
  // Confirmación antes de mandar un magnet a AllDebrid — un toque
  // accidental en la ficha no debe quemar la cuota/cooldown del debrid.
  const [debridConfirm, setDebridConfirm] = useState(null)
  // Chip de progreso de descarga offline (torrent → carpeta Descargas).
  const [dlStatus, setDlStatus] = useState(null)
  const dlListenerRef = useRef(null)

  // Descarga offline de un torrent (o un archivo concreto del pack).
  // Progreso por eventos 'torrentProgress'; el motor tiene slot único —
  // iniciar otra descarga o reproducción sustituye a la anterior.
  const ensureDlListener = async (engine) => {
    if (!dlListenerRef.current) {
      dlListenerRef.current = await engine.addListener('torrentProgress', ev => {
        setDlStatus(prev => {
          if (!prev || prev.done) return prev
          const progress = ev?.progress || 0
          const done = progress >= 1 || ev?.state === 'finished'
          return { ...prev, name: ev?.fileName || prev.name, progress, done }
        })
      })
    }
  }

  const downloadTorrent = async (stream, fileIndex = null) => {
    try {
      const engine = await getTorrentEngine()
      if (!engine?.download) {
        toast.error('Descargas no disponibles en esta plataforma')
        return
      }
      setDlStatus({ name: stream.name || stream.server || 'torrent', progress: 0, done: false })
      await ensureDlListener(engine)
      const res = await engine.download({
        url: stream.url,
        season: meta?.season ?? undefined,
        episode: meta?.episode ?? undefined,
        fileIndex: fileIndex ?? undefined,
      })
      if (res?.complete) {
        setDlStatus({ name: res.name, progress: 1, done: true })
        toast.success(`Descarga completada: ${res.name}`)
      }
    } catch (e) {
      console.warn('[Details] download failed:', e?.message)
      setDlStatus(null)
      toast.error(`Error al descargar: ${e?.message || 'fallo desconocido'}`)
    }
  }

  // Descarga directa http(s): el enlace debrid se desbloquea primero y el
  // archivo resultante baja a la misma carpeta de Descargas que los torrents.
  const downloadDirect = async (stream) => {
    try {
      const engine = await getTorrentEngine()
      if (!engine?.downloadHttp) {
        toast.error('Descargas no disponibles en esta plataforma')
        return
      }
      let url = stream.url
      if (stream.streamType === 'debrid') {
        if (!isAlldebridEnabled()) {
          toast.error('Requiere AllDebrid (Ajustes → Debrid)')
          return
        }
        setDlStatus({ name: 'Desbloqueando enlace debrid…', progress: 0, done: false })
        const r = await unlockDebrid(stream.url)
        if (!r?.link) {
          setDlStatus(null)
          toast.error(debridErrorMessage(r?.error))
          return
        }
        url = r.link
      }
      const displayName = [meta?.name, parseStreamQuality(stream)].filter(Boolean).join(' ')
        || stream.name || stream.server || 'video'
      setDlStatus({ name: displayName, progress: 0, done: false })
      await ensureDlListener(engine)
      const res = await engine.downloadHttp({ url, name: displayName, headers: stream.headers })
      if (res?.complete) {
        setDlStatus({ name: res.name, progress: 1, done: true })
        toast.success(`Descarga completada: ${res.name}`)
      }
    } catch (e) {
      console.warn('[Details] downloadHttp failed:', e?.message)
      setDlStatus(null)
      toast.error(`Error al descargar: ${e?.message || 'fallo desconocido'}`)
    }
  }

  // Icono ⬇ de la fila: torrent → picker/descarga; directo/debrid → downloadHttp.
  const handleDownloadClick = (stream) => {
    if (stream.streamType === 'torrent') return handleTorrentDownload(stream)
    return downloadDirect(stream)
  }

  // Icono ⬇ de la fila: 1 archivo → descarga directa; pack → picker con ⬇ por archivo.
  const handleTorrentDownload = async (stream) => {
    try {
      const engine = await getTorrentEngine()
      const list = engine?.listFiles ? await engine.listFiles({ url: stream.url }) : null
      const files = list?.files || []
      if (files.length > 1) {
        setTorrentPick({ stream, files, skipResume: true, candidatesPool: null })
        return
      }
      await downloadTorrent(stream, files[0]?.index ?? null)
    } catch (e) {
      console.warn('[Details] listFiles p/ descarga falló:', e?.message)
      await downloadTorrent(stream, null)
    }
  }

  // El chip de "Descargado" se autocierra a los pocos segundos.
  useEffect(() => {
    if (!dlStatus?.done) return
    const t = setTimeout(() => setDlStatus(null), 5000)
    return () => clearTimeout(t)
  }, [dlStatus?.done])
  // Loading state for episode stream search — separate from page-level loading
  // so the episode view can show its own spinner without hiding the page.
  const [episodeLoading, setEpisodeLoading] = useState(false)
  const [selectedPerson, setSelectedPerson] = useState(null)
  const [personLoading, setPersonLoading] = useState(false)
  const personCloseRef = useRef(null)
  const castSectionRef = useRef(null)
  const lastFocusedActorRef = useRef(null)
  const firstEpisodeRef = useRef(null)
  const [trailerLoading, setTrailerLoading] = useState(false)

  // Cache de episodios por temporada (evita re-fetch al navegar entre temporadas)
  const episodesCacheRef = useRef({})
  // AbortController para cancelar peticiones de temporada anteriores
  const seasonAbortRef = useRef(null)
  // AbortController para cancelar petición de cast anterior
  const castAbortRef = useRef(null)
  const streamAbortRef = useRef(null)
  const episodeStreamAbortRef = useRef(null)
  // Apunta al refetchProcessing del efecto activo (película o episodio) —
  // handlePlay lo usa tras mandar una fuente "descargando" al debrid.
  const processingRefetchRef = useRef(null)
  // Token para descartar resultados de carga de episodios anteriores
  const episodeLoadIdRef = useRef(0)
  const [trailerStream, setTrailerStream] = useState(null)

  // Find saved progress for this item (historyItem viene del selector)
  const savedProgress = historyItem?.progress || 0
  const savedTime = historyItem?.currentTime || 0
  const savedDuration = historyItem?.duration || 0

  // Mueve el foco al botón Cerrar del modal del actor al abrirse
  useEffect(() => {
    if (selectedPerson && personCloseRef.current) {
      personCloseRef.current.focus()
    }
    // Al abrir la info del actor, hacer scroll a la sección de reparto
    if (selectedPerson && castSectionRef.current) {
      castSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    // Al cerrar el modal, devolver el foco a la tarjeta del actor que se abrió
    if (!selectedPerson && lastFocusedActorRef.current && lastFocusedActorRef.current.isConnected) {
      lastFocusedActorRef.current.focus()
      lastFocusedActorRef.current = null
    }
  }, [selectedPerson])

  // Al entrar en una temporada, el foco empieza en el primer capítulo.
  useEffect(() => {
    if (view !== 'season' || seasonEpisodes.length === 0 || !firstEpisodeRef.current) return
    const timer = setTimeout(() => {
      const first = firstEpisodeRef.current
      if (!first?.isConnected) return
      first.focus()
      first.scrollIntoView({ behavior: 'auto', block: 'center' })
    }, 0)
    return () => clearTimeout(timer)
  }, [view, seasonEpisodes])

  // Bloquea el scroll de la pantalla de fondo mientras la info del actor está abierta.
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main || !selectedPerson) return undefined
    const previousOverflow = main.style.overflow
    main.style.overflow = 'hidden'
    return () => {
      main.style.overflow = previousOverflow
    }
  }, [selectedPerson])

  // Back del mando/Android: cerrar primero el nivel interno actual.
  // Así Actor -> ficha, Episodio -> temporada y Temporada -> serie.
  useEffect(() => {
    const onBack = event => {
      if (event.key !== 'Back' && event.key !== 'Escape') return
      if (selectedPerson) {
        event.preventDefault()
        setSelectedPerson(null)
        setPersonLoading(false)
        document.body.dataset.backConsumed = 'true'
      } else if (view === 'episode' && selectedEpisode) {
        event.preventDefault()
        setSelectedEpisode(null)
        setView('season')
        document.body.dataset.backConsumed = 'true'
      } else if (view === 'season' && selectedSeason) {
        event.preventDefault()
        setSelectedSeason(null)
        setSeasonEpisodes([])
        setView('series')
        document.body.dataset.backConsumed = 'true'
      }
    }
    document.addEventListener('keydown', onBack)
    return () => document.removeEventListener('keydown', onBack)
  }, [selectedPerson, view, selectedEpisode, selectedSeason])

  useEffect(() => {
    let cancelled = false
    autoplayConsumedRef.current = false
    const load = async () => {
      setLoading(true)
      setMeta(null)
      setStreams([])
      setCast([])
      setCastLoading(false)
      setSelectedStream(null)
      setSelectedEpisode(null)
      setShowResumeDialog(false)
      setSelectedSeason(null)
      setSeasonEpisodes([])
      setEpisodeError(null)
      setView('series')
      setEpisodeStreams([])
      setEpisodeLoading(false)
      // Limpiar caché de temporadas al cambiar de contenido
      episodesCacheRef.current = {}
      // Cancelar peticiones pendientes
      if (seasonAbortRef.current) seasonAbortRef.current.abort()
      if (castAbortRef.current) castAbortRef.current.abort()
      if (streamAbortRef.current) streamAbortRef.current.abort()
      if (episodeStreamAbortRef.current) episodeStreamAbortRef.current.abort()

      // Wait for WARP before loading meta/streams (prevents IP leak)
      await waitForWarp()

      const m = await pluginManager.getMeta(type, id)
      if (cancelled) return
      setMeta(m)

      console.log('[Details] meta loaded:', m?.name, 'type:', m?.type, 'seasonsList:', m?.seasonsList?.length || 0, 'episodes:', m?.episodes?.length || 0)

      // Cargar cast de forma diferida (no bloquea la página)
      if (m && !cancelled) {
        // If cast is already in meta (from append_to_response), use it directly
        if (m.cast && m.cast.length > 0) {
          console.log('[Details] cast from meta:', m.cast.length, 'members')
          setCast(m.cast)
        } else {
          // Fallback: fetch cast separately (with 10s timeout)
          setCastLoading(true)
          const ctrl = new AbortController()
          castAbortRef.current = ctrl
          getCast(id, ctrl.signal).then(castData => {
            if (cancelled || ctrl.signal.aborted) {
              console.log('[Details] cast cancelled/aborted')
              return
            }
            console.log('[Details] cast loaded:', castData?.length || 0, 'members')
            setCast(castData || [])
            setCastLoading(false)
          }).catch((e) => {
            console.error('[Details] cast error:', e?.message)
            if (cancelled || ctrl.signal.aborted) return
            setCastLoading(false)
          })
        }
      }

      // Canales en directo: sin página de detalles — resolver el stream y
      // reproducir directamente. Al cerrar el player se vuelve atrás.
      // Se hace aunque getMeta falle: el stream es lo que importa.
      if (type === 'live' || type === 'channel' || m?.type === 'live' || m?.type === 'channel') {
        try {
          // Cargar la lista de canales en background para el zapping nativo
          // (OK abre la lista, ↑/↓ cambian de canal dentro del player).
          ;(async () => {
            try {
              const allCatalogs = await pluginManager.getAllCatalogs()
              const cats = allCatalogs.filter(c => (c.type === 'live' || c.type === 'channel') && !c.id?.startsWith('u7d-'))
              const results = await Promise.all(cats.map(cat =>
                pluginManager.getCatalogContent(cat.pluginId, cat.id, cat.type, 0, 500)
                  .then(items => items.map(i => ({ ...i, pluginId: cat.pluginId })))
                  .catch(() => [])))
              // Dedup por nombre normalizado (TDT Spain tiene prioridad: va
              // primero en DEFAULT_INSTALLED, por eso su catálogo se carga
              // primero y gana).
              const list = []
              const seen = new Set()
              for (const ch of results.flat()) {
                const n = String(ch.name || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s+(hd|fhd|4k|full hd)$/i, '')
                if (seen.has(n)) continue
                seen.add(n)
                list.push(ch)
              }
              if (!cancelled && list.length) setLiveChannels(list)
            } catch { /* sin lista → player sin zapping */ }
          })()
          const streams = await pluginManager.getStreams(type, id, m?.name || '')
          if (cancelled) return
          const stream = streams?.[0]
          if (stream) {
            // Meta mínimo si getMeta falló — VideoPlayer usa meta.name/type/id.
            if (!m) setMeta({ id, type, name: 'Canal en directo', poster: '' })
            setResumeTime(0)
            setSelectedStream(stream)
            // Guardar el canal inicial para que onClose lo añada al historial.
            currentChannelRef.current = m || { id, type, name: 'Canal en directo' }
            if (!cancelled) setLoading(false)
          } else if (!cancelled) {
            setLoading(false)
            navigate(-1)
          }
        } catch (e) {
          if (!cancelled) { setLoading(false); navigate(-1) }
        }
        return
      }

      if (m) {
        // For series with seasons, DON'T search for streams at the series
        // level — each episode has its own streams and they're only searched
        // when the user picks an episode (handlePlayEpisode). Searching at
        // the series level wastes bandwidth and CPU for results that are
        // never used. Just show the seasons immediately.
        const hasSeasons = m.seasonsList && m.seasonsList.length > 0
        if (hasSeasons) {
          setLoading(false)
          return
        }

        // Movies and standalone content resolve providers when their details
        // page opens. Episodic content waits until the user selects an episode.
        // Pass genres so Plurtasko can detect anime/dorama and search only appropriate channels
        const s = await new Promise((resolve) => {
          let finalStreams = []
          let resolved = false
          const ctrl = new AbortController()
          streamAbortRef.current = ctrl
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true
              ctrl.abort()
              resolve(finalStreams)
            }
          }, 10000)
          pluginManager.getStreamsProgressive(
            type, id, m.name, ctrl.signal,
            (batch) => {
              // onBatch callback - update UI as streams arrive
              finalStreams = batch
              if (!cancelled) {
                setStreams(batch)
                setLoading(false)
              }
            },
            m.genres, null, null, m.originalName, m.originCountry, m.originalLanguage, m.seasonsList, m.englishName, m.year
          ).then((allStreams) => {
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              resolve(allStreams)
            }
          }).catch(() => {
            if (!resolved) { resolved = true; clearTimeout(timeout); resolve(finalStreams) }
          })
        })
        console.log(`[Details] getStreams returned ${s?.length || 0} streams`, s?.slice(0, 5).map(st => `${st.server||st.name} (${st.streamType})`))
        if (cancelled) return
        setStreams(s)
        setLoading(false)
        // Fuentes "procesándose" (debrid bajando el magnet): re-petición
        // silenciosa cada ~45s hasta que aparezcan cacheadas (máx 3).
        let procAttempts = 0
        const refetchProcessing = () => {
          if (cancelled || ++procAttempts > 3) return
          setTimeout(async () => {
            if (cancelled) return
            const ctrl2 = new AbortController()
            streamAbortRef.current = ctrl2
            try {
              const all = await pluginManager.getStreamsProgressive(
                type, id, m.name, ctrl2.signal,
                (batch) => { if (!cancelled) setStreams(batch) },
                m.genres, null, null, m.originalName, m.originCountry, m.originalLanguage, m.seasonsList, m.englishName, m.year)
              if (cancelled || !all?.length) return
              setStreams(all)
              if (all.some(st => st.processing)) { adoptDebridMagnets(all); refetchProcessing() }
            } catch { /* reintento silencioso */ }
          }, 45000)
        }
        processingRefetchRef.current = refetchProcessing
        if (hasAnyDebrid() && s?.some(st => st.processing)) {
          adoptDebridMagnets(s)
          refetchProcessing()
        }
        // El marcador "processing" no es reproducible — el autoplay elige
        // solo entre las fuentes reales.
        const playable = (s || []).filter(st => !st.processing)
        if (location.state?.autoplay && playable.length > 0) {
          const autoplayEnabled = localStorage.getItem('octostream_autoplay') !== 'false'
          // If there's saved progress (not completed) and autoplay is enabled,
          // play directly from the saved position without showing the resume dialog
          if (autoplayEnabled && savedProgress > 0.05 && savedProgress < 0.95 && savedTime > 0) {
            const savedServer = historyItem?.server || ''
            const savedStream = savedServer ? playable.find(st => (st.server || st.pluginName) === savedServer) : null
            const chosen = savedStream || sortByLangPriority(playable)[0]
            scheduleAutoplay(() => {
              if (cancelled) return
              setResumeTime(savedTime)
              setSelectedStream(chosen)
              addToHistory({ id: m.id, type: m.type, name: m.name, poster: m.poster, server: chosen.server || chosen.pluginName || '', ...(m.seasonsList ? { seasonsList: m.seasonsList } : {}) })
            })
          } else if (!autoplayEnabled && savedProgress > 0.05 && savedProgress < 0.95 && savedTime > 0) {
            // Autoplay disabled: show resume dialog so user can choose
            setResumeTime(savedTime)
            setShowResumeDialog(true)
          } else if (autoplayEnabled) {
            // No saved progress: play from start
            const savedServer = historyItem?.server || ''
            const savedStream = savedServer ? playable.find(st => (st.server || st.pluginName) === savedServer) : null
            const chosen = savedStream || sortByLangPriority(playable)[0]
            scheduleAutoplay(() => {
              if (cancelled) return
              setResumeTime(0)
              setSelectedStream(chosen)
              addToHistory({ id: m.id, type: m.type, name: m.name, poster: m.poster, server: chosen.server || chosen.pluginName || '', ...(m.seasonsList ? { seasonsList: m.seasonsList } : {}) })
            })
          }
          // autoplay desactivado y sin progreso → no reproducir; el usuario elige
        }
      }
    }
    load().catch(e => {
      console.error('[Details] load failed:', e?.message)
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      cancelAutoplay()
      streamAbortRef.current?.abort()
      castAbortRef.current?.abort()
      seasonAbortRef.current?.abort()
      episodeStreamAbortRef.current?.abort()
      zapAbortRef.current?.abort()
    }
  }, [type, id, location.state?.autoplay])

  // El listener de 'torrentProgress' vive en el plugin nativo/IPC: sin
  // remove() al desmontar se acumulan listeners que retienen setState de un
  // componente ya muerto.
  useEffect(() => () => {
    try { dlListenerRef.current?.remove?.() } catch { /* noop */ }
    dlListenerRef.current = null
  }, [])

  const [resolvingStream, setResolvingStream] = useState(false)
  const [resolvingText, setResolvingText] = useState('')

  // Programa el autoplay con 60s de retraso. Si el usuario elige un stream
  // manualmente (handlePlay), el timer se cancela.
  const AUTOPLAY_DELAY_MS = 60000
  const scheduleAutoplay = (fn, delayMs = AUTOPLAY_DELAY_MS) => {
    if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current)
    autoplayTimerRef.current = setTimeout(() => {
      autoplayTimerRef.current = null
      fn()
    }, delayMs)
  }
  const cancelAutoplay = () => {
    if (autoplayTimerRef.current) {
      clearTimeout(autoplayTimerRef.current)
      autoplayTimerRef.current = null
    }
  }

  // candidatesPool: lista de streams del episodio/contenido actual pasada por
  // el caller. Importante en autoplay/cambio de episodio: el estado
  // `episodeStreams` aún lleva los enlaces del episodio ANTERIOR cuando
  // handlePlay corre dentro de handlePlayEpisode — usarlo haría que el
  // fallback debrid reprodujera el capítulo viejo.
  // Lanza la descarga real del magnet en el debrid (tras confirmación):
  // upload a AllDebrid con seguimiento de progreso, o la URL de la
  // instancia AIOStreams (pedirla es lo que dispara el procesamiento).
  const startDebridDownload = async (stream) => {
    try {
      if (stream._magnet && isAlldebridEnabled()) {
        toast('Enviando el magnet a AllDebrid…')
        const id = await adUploadMagnet(stream._magnet)
        if (id) {
          trackMagnet(id, btihOf(stream._magnet) || stream._infoHash, stream.releaseTitle || stream.name)
          toast('Añadido a AllDebrid — verás el progreso aquí y aparecerá al estar listo')
        } else {
          toast.error('AllDebrid no aceptó el magnet (cooldown o límite de la cuenta)')
        }
      } else if (stream._triggerUrl) {
        toast('Solicitando la descarga a AIOStreams…')
        httpGetText(stream._triggerUrl).catch(() => {})
        toast('Descarga solicitada — la ficha se actualiza sola')
      } else {
        toast('Esta fuente ya está en cola del debrid — aparecerá al estar lista')
      }
    } catch (e) {
      toast.error(`No se pudo iniciar la descarga: ${e?.message || e}`)
    }
    // Re-pedir la lista pronto para reflejar el estado de la cola.
    processingRefetchRef.current?.()
  }

  // Overlay de resolución con texto de estado: un magnet sin peers tarda
  // hasta ~90s en dar metadatos — sin pista parece colgado ("resolviendo
  // video y nada más").
  const beginResolving = (text = '') => { setResolvingText(text); setResolvingStream(true) }
  const endResolving = () => { setResolvingStream(false); setResolvingText('') }

  const handlePlay = async (stream, skipResume = false, candidatesPool = null) => {
    // El usuario eligió manualmente: cancelar autoplay diferido
    cancelAutoplay()
    // Fuente "descargando" (debrid aún procesa el magnet): pulsarla la pone
    // a bajar — subimos el magnet a AllDebrid, o pedimos la URL de la
    // instancia AIOStreams, que es lo que dispara el procesamiento allí.
    // No reproduce nada; la ficha re-pide y aparece lista cuando termine.
    if (stream?.processing) {
      // Sin debrid ni AIOStreams configurado las entradas procesándose
      // ni se muestran (StreamList las filtra) — si aun así llega una
      // (config quitada a mitad de sesión), no hay acción posible.
      if (!hasAnyDebrid()) {
        toast.error('Esta fuente necesita debrid — configura AllDebrid o AIOStreams en Ajustes → Debrid')
        return
      }
      // Magnet ya listo en AllDebrid (job tracked) → resolver el enlace
      // restringido a URL directa y reproducir sin esperar al re-poll.
      const job = stream._infoHash ? getDebridJob(stream._infoHash) : null
      if (job?.status === 'ready') {
        try {
          beginResolving('Desbloqueando enlace debrid…')
          const directUrl = await resolveDebridJob(job, { season: stream.season, episode: stream.episode })
          endResolving()
          if (directUrl) {
            stream = { ...stream, processing: undefined, url: directUrl, streamType: 'mp4', server: `${stream.server || 'AIOStreams'} (Debrid)`, viaDebrid: 'AllDebrid' }
          } else {
            toast.error('El magnet está listo pero no se pudo desbloquear el enlace')
            return
          }
        } catch (e) {
          endResolving()
          toast.error(`No se pudo desbloquear: ${e?.message || e}`)
          return
        }
      } else {
        // Aún descargando o sin job: confirmación antes de (re)lanzar la
        // descarga — consume cuota del debrid y un toque accidental en la
        // ficha no debe dispararla.
        setDebridConfirm(stream)
        return
      }
    }
    // Torrent multi-archivo (pack de temporada): listar los vídeos y dejar
    // elegir antes de reproducir. listFiles solo trae metadatos — el plugin
    // cachea el TorrentInfo y start() lo reutiliza, así que no cuesta el
    // fetch del magnet dos veces. Si falla o hay un solo archivo se sigue
    // directo con el auto-pick de siempre.
    if (stream.streamType === 'torrent' && stream.torrentFileIndex == null && stream.url) {
      try {
        beginResolving('Buscando metadatos del torrent…')
        console.log('[Details] torrent: obteniendo motor…')
        // El motor también va con timeout: getTorrentEngine hace un
        // import() dinámico del chunk del plugin — si esa carga cuelga
        // (asset loader del WebView) el overlay se quedaba girando
        // para siempre sin llegar ni siquiera al listFiles.
        const engine = await Promise.race([
          getTorrentEngine(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('motor torrent no responde')), 15000)),
        ])
        console.log('[Details] torrent: motor', engine ? 'ok' : 'null', '— listFiles…')
        // Timeout propio: un magnet sin peers puede quedarse largo en el
        // fetch de metadata (90s nativo) y el overlay genérico parecía
        // colgado. Al expirar se sigue con el auto-pick — start() enseña
        // su propio progreso dentro del player.
        const list = engine?.listFiles
          ? await Promise.race([
              engine.listFiles({ url: stream.url }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('listFiles timeout')), 45000)),
            ])
          : null
        endResolving()
        const files = list?.files || []
        if (files.length > 1) {
          setTorrentPick({ stream, files, skipResume, candidatesPool })
          return
        }
        if (files.length === 1) stream = { ...stream, torrentFileIndex: files[0].index }
      } catch (e) {
        endResolving()
        console.warn('[Details] listFiles falló, reproduciendo con auto-pick:', e?.message)
      }
    }
    // Debrid streams (Palantir 1fichier, etc.): unlock lazily at play time so
    // browsing never burns debrid API calls.
    if (stream.streamType === 'debrid') {
      if (!isAlldebridEnabled()) {
        setEpisodeError('Este enlace requiere AllDebrid. Configúralo en Ajustes → Debrid.')
        return
      }
      setEpisodeError(null)
      beginResolving('Desbloqueando con debrid…')
      // Muchos enlaces 1fichier están bloqueados (DMCA) o caídos: se prueban
      // varios candidatos EN PARALELO y gana el primero que desbloquee. En
      // serie, un enlace remoto puede tardar y
      // caché) podía bloquear hasta 2 min aunque otro resolviera al instante.
      const pool = (candidatesPool && candidatesPool.length ? candidatesPool
        : (episodeStreams && episodeStreams.length ? episodeStreams : streams)) || []
      const seen = new Set([stream.url])
      const others = pool
        .filter(s => s.streamType === 'debrid' && s.url && !seen.has(s.url) && seen.add(s.url))
      const candidates = [stream, ...others].slice(0, 8)
      const errors = []
      const attempts = candidates.map(cand =>
        unlockDebrid(cand.url).then(r => {
          if (r?.link) return { cand, direct: r.link }
          errors.push(r?.error || 'unlock failed')
          throw new Error(r?.error || 'unlock failed')
        }).catch(e => {
          errors.push(e?.message)
          console.warn('[Details] Debrid unlock error:', e?.message)
          throw e
        })
      )
      let resolved = null
      try {
        // Tope global: si los 8 candidatos están procesando, la espera puede
        // llegar a ~2 min en "Resolviendo…"
        // y parecía que el enlace no abría. A los 90s se informa y se puede
        // reintentar.
        // Tope al esperar debrid: un archivo no cacheado puede tardar.
        // grande sigue descargándose en su CDN y el job persiste — cortar
        // antes dejaba "resolviendo" muerto aunque el progreso avanzara.
        resolved = await Promise.race([
          Promise.any(attempts),
          new Promise((_, r) => setTimeout(() => r(new Error('debrid resolve timeout')), 190000)),
        ])
      } catch { /* todos fallaron o timeout */ }
      const lastError = errors[errors.length - 1]
      endResolving()
      if (!resolved) {
        console.warn(`[Details] Debrid unlock failed for ${urlHost(stream.url || '')}`)
        setEpisodeError(debridErrorMessage(lastError)
          + (candidates.length > 1 ? ` (${candidates.length} enlaces probados)` : ''))
        return
      }
      stream = {
        ...resolved.cand,
        url: resolved.direct,
        // El enlace 1fichier original — si la URL firmada caduca en mitad de
        // la reproducción, VideoPlayer re-desbloquea desde aquí.
        originalDebridUrl: resolved.cand.url,
        viaDebrid: true,
        streamType: inferStreamType(resolved.direct, 'mp4'),
      }
    }
    // If the stream has an originalUrl (embed page), always resolve fresh
    // because tokens from CDNs like fastream expire quickly
    // (.avi y los CDN de debrid también son URLs directas: sin ellos un
    // .avi desbloqueado disparaba un resolveEmbed sobre la URL .torrent).
    const isDirectUrl = /\.(m3u8|mp4|mkv|avi|ts|mov|m4v|webm|wmv)(\?|$)/i.test(stream.url)
      || /videoplayback/.test(stream.url)
      || /download\.alldebrid\.com|alldebrid\.com\/d\/|\.debrid\.(it|al|com|cx|ee|is)\//i.test(stream.url)
    // Re-resolve if: has originalUrl, is not an embed, and either:
    // - URL is not direct (still an embed page), OR
    // - URL is direct but from a CDN with expiring tokens (fastream, streamwish, etc.)
    // Also re-resolve embed-type servers that have a dedicated JS resolver (waaw, etc.)
    // Streams debrid/torrent se re-resuelven por _refreshUrl (magnet) u
    // originalDebridUrl (unlock) — nunca por el resolver de embeds.
    const needsFreshResolve = stream.originalUrl && !stream.viaDebrid && !stream._refreshUrl && !stream.originalDebridUrl && (
      stream.streamType !== 'embed' ||
      /waaw|wolfstream/i.test(stream.server || '') ||
      /waaw\.(tv|to)/i.test(stream.originalUrl)
    ) && (
      !isDirectUrl ||
      /fastream|streamwish|filemoon|vidhide|streamtape|doodstream|waaw/i.test(stream.server || '') ||
      /fastream|streamwish|filemoon|vidhide|waaw/i.test(stream.originalUrl)
    )
    if (needsFreshResolve) {
      beginResolving('Re-resolviendo enlace…')
      try {
        const freshUrl = await Promise.race([
          resolveEmbed(stream.originalUrl),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))
        ])
        if (freshUrl && freshUrl !== stream.originalUrl) {
          const freshType = inferStreamType(freshUrl, stream.streamType)
          // Fastream (and similar token-locked CDNs) need the exact headers that
          // Alfa/Balandro/ResolveURL append: Referer = origin/ and Origin = origin.
          // Voe CDN links work with UA only; adding a cross-domain Referer can 403.
          const embedHost = (() => { try { return new URL(stream.originalUrl).origin } catch { return '' } })()
          const isFastream = /fastream/i.test(stream.server || '') || /fastream/i.test(stream.originalUrl)
          const isVoe = /voe\.?sx|voe-unblock|voeunblock/i.test(stream.server || '') || /\bvoe\b/i.test(stream.originalUrl)
          const baseHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
          const headers = { ...baseHeaders }
          if (embedHost) {
            if (isFastream) {
              headers.Referer = stream.originalUrl
              headers.Origin = embedHost
              headers.Accept = 'application/vnd.apple.mpegurl, */*;q=0.9'
              headers['Accept-Language'] = 'es-ES,es;q=0.9,en-US;q=0.5,en;q=0.3'
            } else if (!isVoe) {
              headers.Referer = stream.originalUrl
            }
          }
          stream = { ...stream, url: freshUrl, streamType: freshType, headers }
        }
      } catch (e) {
        console.warn('[Details] Failed to resolve fresh stream, using cached URL:', e?.message)
      }
      endResolving()
    } else {
      console.log(`[Details] Using already-resolved direct URL: ${urlHost(stream.url || '')}`)
    }

    // If there's saved progress, show resume dialog (unless skipped for autoplay)
    if (!skipResume && savedProgress > 0.05 && savedProgress < 0.95 && savedTime > 0) {
      setResumeTime(savedTime)
      setShowResumeDialog(true)
    } else {
      // Reset resume time to 0 unless skipResume=true with a pre-set resumeTime
      // (handleResume sets resumeTime before calling handlePlay with skipResume=true)
      if (!skipResume) setResumeTime(0)
      setSelectedStream(stream)
      if (meta) {
        addToHistory({
          id: meta.id, type: meta.type, name: meta.name, poster: meta.poster,
          server: stream.channelName || stream.server || stream.pluginName || '',
          // Para series: guardar seasonsList para saber si toda la serie está vista
          ...(meta.seasonsList ? { seasonsList: meta.seasonsList } : {}),
          // Para series: guardar info del episodio para poder reanudar el capítulo correcto
          ...(selectedEpisode ? {
            season: selectedEpisode.season,
            episode: selectedEpisode.episode,
            episodeName: selectedEpisode.name || '',
          } : {}),
        })
      }
    }
  }

  const handleResume = () => {
    setShowResumeDialog(false)
    if (streams.length > 0) {
      // Try to use the same server that was used before
      const savedServer = historyItem?.server || ''
      const savedStream = savedServer ? streams.find(s => (s.server || s.pluginName) === savedServer) : null
      // skipResume=true to avoid re-showing the resume dialog
      handlePlay(savedStream || sortByLangPriority(streams)[0], true)
      // Restore the resume time since handlePlay with skipResume won't set it
      setResumeTime(savedTime)
    }
  }

  // Reanuda el episodio guardado del historial ("Seguir viendo" de Home y
  // banner "Continuar viendo" de la ficha). forcePlay porque reanudar es una
  // acción explícita del usuario — no depende del ajuste de autoplay ni
  // espera los 60s del autoplay diferido.
  const resumeSavedEpisode = async () => {
    const season = meta?.seasonsList?.find(s => s.seasonNumber === historyItem.season)
    if (!season) return
    const cacheKey = `${meta.id}-s${historyItem.season}`
    let eps = episodesCacheRef.current[cacheKey]
    if (!eps) {
      try {
        eps = await tmdbPlugin.getSeasonEpisodes({ id: meta.id, seasonNumber: historyItem.season })
      } catch { eps = null }
      if (eps && eps.length > 0) episodesCacheRef.current[cacheKey] = eps
    }
    const ep = eps?.find(e => e.season === historyItem.season && e.episode === historyItem.episode)
    if (!ep) return
    setSelectedSeason(season)
    setSeasonEpisodes(eps || [])
    handlePlayEpisode(ep, { resumeAt: savedTime, forcePlay: true })
  }

  // "Seguir viendo" navega a la ficha con autoplay:true. En series el load()
  // sale temprano al detectar seasonsList, así que el resume va en un efecto
  // aparte que espera a que meta esté cargada (usarla en load() leería el
  // meta del closure — null en el primer render → crash en meta.name).
  useEffect(() => {
    if (autoplayConsumedRef.current) return
    if (!location.state?.autoplay || !meta?.seasonsList?.length) return
    if (historyItem?.season == null || historyItem?.episode == null) return
    if (!(savedProgress > 0.05 && savedProgress < 0.95) || !(savedTime > 0)) return
    autoplayConsumedRef.current = true
    resumeSavedEpisode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, location.state?.autoplay, historyItem, savedProgress, savedTime])

  // Carga pura de episodios de una temporada (caché → provider → TMDB →
  // placeholders por episodeCount). Devuelve el array sin tocar la ficha —
  // la usan handleSelectSeason y el cambio de temporada desde el player.
  const fetchSeasonEpisodes = async (seasonNumber) => {
    const cacheKey = `${meta.id}-s${seasonNumber}`
    if (episodesCacheRef.current[cacheKey]) return episodesCacheRef.current[cacheKey]
    const providerEpisodes = (Array.isArray(meta.episodes) ? meta.episodes : [])
      .filter(ep => Number(ep.season || 1) === Number(seasonNumber))
    if (providerEpisodes.length > 0) {
      episodesCacheRef.current[cacheKey] = providerEpisodes
      return providerEpisodes
    }
    let episodes = null
    try {
      episodes = await tmdbPlugin.getSeasonEpisodes({ id: meta.id, seasonNumber })
    } catch (e) {
      console.warn('[Details] Failed to load season episodes:', e?.message)
    }
    if (!episodes || episodes.length === 0) {
      const count = meta.seasonsList?.find(s => s.seasonNumber === seasonNumber)?.episodeCount || 0
      episodes = []
      for (let i = 1; i <= count; i++) {
        episodes.push({
          id: `${meta.id}-s${seasonNumber}e${i}`,
          name: `Episodio ${i}`,
          season: seasonNumber,
          episode: i,
          description: '',
          poster: null,
        })
      }
    }
    episodesCacheRef.current[cacheKey] = episodes
    return episodes
  }

  // Chips de temporada del reproductor nativo ('seasonSelected'): carga los
  // episodios de esa temporada sin tocar la ficha y los devuelve con su
  // marca de "visto" — VideoPlayer los empuja al panel con setEpisodes().
  const handleLoadSeasonForPlayer = async (seasonNumber) => {
    const eps = await fetchSeasonEpisodes(seasonNumber)
    return eps?.map(ep => ({ ...ep, watched: isEpWatched(ep.season, ep.episode) }))
  }

  // Load episodes for a season from TMDB (con caché y cancelación)
  const handleSelectSeason = async (season) => {
    setSelectedSeason(season)
    setEpisodeError(null)
    setView('season')

    // Si ya tenemos los episodios en caché, mostrarlos inmediatamente
    const cacheKey = `${meta.id}-s${season.seasonNumber}`
    if (episodesCacheRef.current[cacheKey]) {
      setSeasonEpisodes(episodesCacheRef.current[cacheKey])
      setLoadingEpisodes(false)
      return
    }

    const providerEpisodes = (Array.isArray(meta.episodes) ? meta.episodes : []).filter(ep => Number(ep.season || 1) === Number(season.seasonNumber))
    if (providerEpisodes.length > 0) {
      setSeasonEpisodes(providerEpisodes)
      episodesCacheRef.current[cacheKey] = providerEpisodes
      setLoadingEpisodes(false)
      return
    }

    // Cancelar petición anterior si hay una en curso
    if (seasonAbortRef.current) seasonAbortRef.current.abort()
    const ctrl = new AbortController()
    seasonAbortRef.current = ctrl

    setSeasonEpisodes([])
    setLoadingEpisodes(true)

    try {
      const episodes = await tmdbPlugin.getSeasonEpisodes({
        id: meta.id,
        seasonNumber: season.seasonNumber,
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      if (episodes && episodes.length > 0) {
        setSeasonEpisodes(episodes)
        episodesCacheRef.current[cacheKey] = episodes
      } else {
        // Fallback: if no TMDB episodes, create placeholder episodes from count
        const placeholderEps = []
        for (let i = 1; i <= season.episodeCount; i++) {
          placeholderEps.push({
            id: `${meta.id}-s${season.seasonNumber}e${i}`,
            name: `Episodio ${i}`,
            season: season.seasonNumber,
            episode: i,
            description: '',
            poster: null,
          })
        }
        setSeasonEpisodes(placeholderEps)
        episodesCacheRef.current[cacheKey] = placeholderEps
      }
    } catch (e) {
      if (ctrl.signal.aborted) return
      console.warn('[Details] Failed to load season episodes:', e?.message)
    }

    if (!ctrl.signal.aborted) setLoadingEpisodes(false)
  }

  // Play a specific episode: search streams for that episode
  // fromAutoplay=true is used by the popup/end event and must not reset the
  // duplicate-transition guard while the previous player is still closing.
  const handlePlayEpisode = async (ep, { fromAutoplay = false, resumeAt = null, forcePlay = false } = {}) => {
    console.log(`[Details] handlePlayEpisode: ${meta.name} S${ep.season}E${ep.episode}${fromAutoplay ? ' (autoplay)' : ''}`)
    // Cancela autoplay diferido de un episodio anterior
    cancelAutoplay()
    // Solo una selección manual inicia una nueva cadena de autoplay. Si la
    // transición viene del popup o de ended, el guard debe seguir activo.
    if (!fromAutoplay) nextEpisodeTriggeredRef.current = false
    // Invalida cualquier carga de episodio anterior en curso para que sus
    // batches no pisen los del nuevo episodio.
    episodeStreamAbortRef.current?.abort()
    const ctrl = new AbortController()
    episodeStreamAbortRef.current = ctrl
    const loadId = ++episodeLoadIdRef.current
    // stale() solo comprueba si se seleccionó OTRO episodio. NO comprueba
    // ctrl.signal.aborted porque el timeout aborta el controlador al
    // dispararse, y eso haría que el resultado final se descartara aunque
    // los streams ya llegaran (el timeout resuelve con finalStreams).
    const stale = () => episodeLoadIdRef.current !== loadId
    setSelectedEpisode(ep)
    // Episodio elegido desde el panel del player en OTRA temporada: la ficha
    // debe seguir la temporada del episodio que suena o episodeList/
    // nextEpisode/apuntan a la temporada anterior y el autoplay se rompe.
    // fetchSeasonEpisodes ya tiene la lista en caché (el panel la cargó).
    if (ep.season != null && Number(selectedEpisode?.season) !== Number(ep.season)) {
      fetchSeasonEpisodes(ep.season).then(eps => {
        setSeasonEpisodes(eps || [])
        const sMeta = meta.seasonsList?.find(s => s.seasonNumber === ep.season)
        if (sMeta) setSelectedSeason(sMeta)
      })
    }
    setEpisodeLoading(true)
    setEpisodeError(null)
    setEpisodeStreams([])
    setView('episode')  // Switch to episode view immediately so we don't flash back to season view

    try {
      // Search streams using the series name (not the episode name)
      // Pass season/episode so Plurtasko channels can resolve the specific episode
      // Use progressive loading to show streams as they arrive in the UI, but
      // wait for all channels (or 15s timeout) before triggering autoplay so
      // Spanish streams (which arrive later) are included in the language sort.
      const epStreams = await new Promise((resolve) => {
        let finalStreams = []
        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            ctrl.abort()
            resolve(finalStreams)
          }
        }, 15000)
        pluginManager.getStreamsProgressive(
          type, id, meta.name, ctrl.signal,
          (batch) => {
            finalStreams = batch
            if (stale()) return
            setEpisodeStreams(batch)
            setEpisodeLoading(false)
          },
          meta.genres, ep.season, ep.episode, meta.originalName, meta.originCountry, meta.originalLanguage, meta.seasonsList, meta.englishName, meta.year
        ).then((allStreams) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            resolve(allStreams)
          }
        }).catch(() => {
          if (!resolved) { resolved = true; clearTimeout(timeout); resolve(finalStreams) }
        })
      })
      if (stale()) return
      // Mismo auto-refresh que en películas: fuentes procesándose en
      // debrid → re-petición silenciosa hasta que estén cacheadas.
      let procAttempts = 0
      const refetchProcessing = () => {
        if (stale() || ++procAttempts > 3) return
        setTimeout(async () => {
          if (stale()) return
          const ctrl2 = new AbortController()
          streamAbortRef.current = ctrl2
          try {
            const all = await pluginManager.getStreamsProgressive(
              type, id, meta.name, ctrl2.signal,
              (batch) => { if (!stale()) setEpisodeStreams(batch) },
              meta.genres, ep.season, ep.episode, meta.originalName, meta.originCountry, meta.originalLanguage, meta.seasonsList, meta.englishName, meta.year)
            if (stale() || !all?.length) return
            setEpisodeStreams(all)
            if (all.some(st => st.processing)) { adoptDebridMagnets(all); refetchProcessing() }
          } catch { /* reintento silencioso */ }
        }, 45000)
      }
      processingRefetchRef.current = refetchProcessing
      // El marcador "processing" no es reproducible — solo cuenta para el
      // aviso y el auto-refresh; el autoplay usa las fuentes reales.
      const playableEp = (epStreams || []).filter(st => !st.processing)
      if (hasAnyDebrid() && epStreams?.some(st => st.processing)) {
        setEpisodeStreams(epStreams)
        setEpisodeLoading(false)
        adoptDebridMagnets(epStreams)
        refetchProcessing()
      }
      if (playableEp.length > 0) {
        setEpisodeStreams(epStreams)
        setEpisodeLoading(false)
        // Autoplay: if enabled, auto-select best stream by language and play after 60s delay.
        // forcePlay = selección explícita desde el panel de episodios del
        // player nativo: el usuario ya eligió — reproducir al instante aunque
        // el autoplay esté desactivado.
        const autoplayEnabled = localStorage.getItem('octostream_autoplay') !== 'false'
        if (autoplayEnabled || forcePlay) {
          // Try to use the same server that was used before
          const savedServer = historyItem?.server || ''
          const savedStream = savedServer ? playableEp.find(s => (s.server || s.pluginName) === savedServer) : null
          const bestStream = savedStream || sortByLangPriority(playableEp)[0]
          console.log(`[Details] Autoplay (60s): will play "${bestStream?.server || bestStream?.pluginName}" (${parseStreamLang(bestStream) || 'no lang'}) for "${meta.name} S${ep.season}E${ep.episode}"`)
          if (fromAutoplay || forcePlay) {
            // El usuario ya ha pulsado "Continuar" en el popup nativo/web:
            // reproducir inmediatamente, sin volver a esperar 60 segundos.
            if (stale()) return
            setResumeTime(resumeAt != null ? resumeAt : 0)
            // El guard anti-doble-disparo se libera cuando la transición
            // termina (handlePlay resuelve). Si quedara en true, ningún
            // ended/popup posterior volvería a avanzar de episodio.
            Promise.resolve(handlePlay(bestStream, true, epStreams))
              .then(() => { if (!stale()) nextEpisodeTriggeredRef.current = false })
          } else {
            // Autoplay inicial diferido: permite elegir otro stream durante 60s.
            scheduleAutoplay(() => {
              if (stale()) return
              setResumeTime(resumeAt != null ? resumeAt : 0)
              Promise.resolve(handlePlay(bestStream, true, epStreams))
                .then(() => { if (!stale()) nextEpisodeTriggeredRef.current = false })
            })
          }
        } else {
          // Autoplay disabled - show episode view with links (view already set to 'episode' at start)
          console.log(`[Details] Autoplay disabled, showing ${epStreams.length} streams for user selection`)
        }
      } else if (epStreams?.some(st => st.processing)) {
        // Solo marcadores "procesándose": el aviso ya está visible y el
        // refetch en marcha — no es un error, no mostrar "sin enlaces".
      } else {
        // No streams found for this episode
        console.warn(`[Details] No streams found for ${meta.name} S${ep.season}E${ep.episode}`)
        setEpisodeLoading(false)
        setEpisodeError(`No se encontraron enlaces para "${meta.name} S${ep.season}E${ep.episode}". Prueba con otra fuente.`)
        nextEpisodeTriggeredRef.current = false
      }
    } catch (e) {
      console.warn('[Details] Failed to load episode streams:', e?.message)
      setEpisodeLoading(false)
      setEpisodeError(`Error al buscar enlaces: ${e?.message || 'desconocido'}`)
      nextEpisodeTriggeredRef.current = false
    }
  }

  // Handle autoplay: when an episode ends, play the next one
  // Zapping nativo (mismo patrón que LiveTV): el player emite 'channelZap' con
  // el índice destino; aquí se resuelve el stream y se hace switchChannel.
  // Lock para evitar race conditions al zappear rápido (audio se puede perder).
  // Zapping "último gana" (mismo patrón que LiveTV): si llega un zap mientras
  // se resuelve otro, no se descarta — queda en pendingZap y el bucle lo aplica
  // al terminar. El lock evita solapar switchChannel (el audio se pierde).
  const zappingLockRef = useRef(false)
  const pendingZapRef = useRef(null)
  const zapAbortRef = useRef(null) // cancela resoluciones lentas al zappear
  const zapAbortNew = () => {
    if (zapAbortRef.current) zapAbortRef.current.abort()
    zapAbortRef.current = new AbortController()
    return zapAbortRef.current.signal
  }
  const handleZapChannel = async (event) => {
    const ch = liveChannelsRef.current[event.index]
    if (!ch) return
    pendingZapRef.current = { ch, index: event.index }
    if (zappingLockRef.current) return
    zappingLockRef.current = true
    try {
      while (pendingZapRef.current) {
        const { ch: target, index } = pendingZapRef.current
        pendingZapRef.current = null
        // Guardar el canal actual para que onClose lo añada al historial
        // (solo el último canal, no cada canal por el que se pasa)
        currentChannelRef.current = target
        try {
          const signal = zapAbortNew()
          const streams = await pluginManager.getStreams(target.type || 'live', target.id, target.name, signal)
          if (signal.aborted) continue
          const stream = streams?.[0]
          if (stream?.url) {
            await switchChannel({
              url: stream.url,
              streamType: stream.streamType || 'hls',
              direct: stream.direct === true,
              bypassVpn: stream.bypassVpn === true,
              headers: stream.headers || {},
              title: target.name,
              channelIndex: index,
              epgNow: target.nowPlaying || '',
              epgNext: target.nextPlaying || '',
              epgStart: target.nowPlayingStart || 0,
              epgEnd: target.nowPlayingEnd || 0,
            })
            // No guardar al historial en cada zap — solo se guarda el último
            // canal al cerrar el player (onClose abajo), igual que en LiveTV.
          } else {
            console.warn('[Details] Zap: sin stream para', target.name)
          }
        } catch (e) {
          // El overlay nativo queda en "Cargando…" y se puede reintentar
          console.warn('[Details] Zap failed:', e?.message || e)
        }
      }
    } finally {
      zappingLockRef.current = false
    }
  }

  const handleEnded = () => {
    // Check if autoplay is enabled
    const autoplayEnabled = localStorage.getItem('octostream_autoplay') !== 'false'
    if (!autoplayEnabled) {
      stopPlayback().catch(() => {})
      setSelectedStream(null)
      return
    }

    // Respect the "auto next episode" setting: if disabled, stop after each episode.
    if (localStorage.getItem('octostream_auto_next_ep') === 'false') {
      console.log('[Details] Auto next episode disabled, stopping after current episode')
      stopPlayback().catch(() => {})
      setSelectedStream(null)
      return
    }

    // Guard: si el popup (web o nativo) ya disparó el siguiente episodio, no hacer nada
    if (nextEpisodeTriggeredRef.current) {
      console.log('[Details] handleEnded: next episode already triggered by popup, skipping')
      return
    }

    // Guard: if already loading next episode, don't trigger again
    if (loading) {
      console.log('[Details] Autoplay: already loading, skipping')
      return
    }

    // Determine the episode list to search for the next episode
    const epList = seasonEpisodes.length > 0 ? seasonEpisodes : (Array.isArray(meta.episodes) ? meta.episodes : [])
    if (!epList || epList.length === 0 || !selectedEpisode) {
      stopPlayback().catch(() => {})
      setSelectedStream(null)
      return
    }

    // Find current episode index
    const currentIdx = epList.findIndex(ep =>
      ep.season === selectedEpisode.season && ep.episode === selectedEpisode.episode
    )
    if (currentIdx === -1 || currentIdx >= epList.length - 1) {
      // Last episode of the season
      console.log('[Details] Last episode of season, autoplay stops')
      stopPlayback().catch(() => {})
      setSelectedStream(null)
      return
    }

    // Play next episode
    const nextEp = epList[currentIdx + 1]
    console.log(`[Details] Autoplay next episode: S${nextEp.season}E${nextEp.episode}`)
    nextEpisodeTriggeredRef.current = true
    handlePlayEpisode(nextEp, { fromAutoplay: true })
  }

  const handleStartOver = () => {
    setShowResumeDialog(false)
    setResumeTime(0)
    if (meta) {
      updateProgress(meta.id, meta.type, 0, savedDuration)
    }
    if (streams.length > 0) {
      const savedServer = historyItem?.server || ''
      const savedStream = savedServer ? streams.find(s => (s.server || s.pluginName) === savedServer) : null
      // skipResume=true to avoid re-showing the resume dialog with stale savedProgress
      handlePlay(savedStream || sortByLangPriority(streams)[0], true)
    }
  }

  // Play trailer using NewPipeExtractor (Android) or iframe fallback (web)
  const handlePlayTrailer = async () => {
    if (!meta.trailer) return
    const url = sanitizeUrl(meta.trailer)
    if (!url) return

    // Android: NewPipeExtractor → URL directa en ExoPlayer. Electron: la
    // misma superficie vía yt-dlp (window.octostream.youtube) → player web.
    if (isAndroidNative() || isElectron()) {
      setTrailerLoading(true)
      try {
        const stream = await resolveYouTubeStream(url)
        if (stream) {
          console.log(`[Details] Trailer resolved via NewPipeExtractor: ${urlHost(stream.url)}`)
          setTrailerStream({
            ...stream,
            fastStart: true,
            _refreshUrl: async () => {
              const fresh = await resolveYouTubeStream(url, { force: true })
              return fresh?.url || null
            },
          })
        } else {
          console.warn('[Details] NewPipeExtractor failed, falling back to iframe')
          // Fallback: open iframe
          setTrailerStream({ url: url, streamType: 'embed', fallback: true })
        }
      } catch (e) {
        console.warn('[Details] Trailer resolution failed:', e?.message)
        setTrailerStream({ url: url, streamType: 'embed', fallback: true })
      }
      setTrailerLoading(false)
    } else {
      // Web: use iframe
      setTrailerStream({ url: url, streamType: 'embed', fallback: true })
    }
  }

  // Load person details from TMDB when an actor is selected
  const handleSelectPerson = async (member) => {
    // Guardar el elemento enfocado para restaurarlo al cerrar el modal
    lastFocusedActorRef.current = document.activeElement
    // Quita el foco de la tarjeta del actor para que no se quede iluminada
    // detrás del modal al abrir la info del actor.
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur()
    }
    setSelectedPerson({ ...member, biography: '', loading: true })
    setPersonLoading(true)
    try {
      const details = await getPersonDetails(member.id)
      if (details) {
        setSelectedPerson({ ...member, ...details, loading: false })
      } else {
        setSelectedPerson({ ...member, loading: false })
      }
    } catch {
      setSelectedPerson({ ...member, loading: false })
    }
    setPersonLoading(false)
  }

  // Lista de episodios de la temporada actual (para autoplay y para el panel
  // de episodios del player nativo). Va antes de los early-returns: los hooks
  // de abajo deben ejecutarse en todos los renders.
  const episodeList = (() => {
    if (!selectedEpisode) return null
    const epList = seasonEpisodes.length > 0 ? seasonEpisodes : (Array.isArray(meta?.episodes) ? meta.episodes : [])
    if (!epList || epList.length === 0) return null
    return epList
  })()

  // Compute next episode for the autoplay popup (Netflix-style)
  const nextEpisode = (() => {
    if (!episodeList || !selectedEpisode) return null
    const currentIdx = episodeList.findIndex(ep =>
      ep.season === selectedEpisode.season && ep.episode === selectedEpisode.episode
    )
    if (currentIdx === -1 || currentIdx >= episodeList.length - 1) return null
    return episodeList[currentIdx + 1]
  })()

  // Props memoizadas para VideoPlayer: antes se creaban inline en el JSX
  // (meta/episodes/onPlayNext nuevos en CADA render de Details). Como Details
  // se re-renderiza con cada updateProgress del store, esas identidades
  // inestables re-ejecutaban efectos del player en bucle — uno de ellos
  // (progreso → updateProgress) cerraba un ciclo render→set→render
  // infinito (React #185) durante la reproducción.
  const playerMeta = useMemo(() => {
    const base = selectedEpisode && meta
      ? { ...meta, season: selectedEpisode.season, episode: selectedEpisode.episode, episodeName: selectedEpisode.name }
      : meta
    // Canales en directo: la entrada del historial no guarda EPG/logo — se
    // completa desde la lista de zapping cuando termina de cargar.
    if (base && (base.type === 'live' || base.type === 'channel') && liveChannels?.length) {
      const ch = liveChannels.find(c => c.id === base.id)
        || liveChannels.find(c => (c.name || '').toLowerCase() === (base.name || '').toLowerCase())
      if (ch) {
        return {
          ...base,
          poster: base.poster || ch.logo || ch.poster || '',
          epgNow: ch.nowPlaying || '',
          epgNext: ch.nextPlaying || '',
          epgStart: ch.nowPlayingStart || 0,
          epgEnd: ch.nowPlayingEnd || 0,
        }
      }
    }
    return base
  }, [meta, selectedEpisode, liveChannels])

  const playerEpisodes = useMemo(() => episodeList?.map(ep => ({
    ...ep,
    watched: !!(meta && watchedEpisodes[`${meta.id}:S${ep.season ?? selectedEpisode?.season ?? 1}:E${ep.episode}`]?.progress >= 0.97),
  })), [episodeList, watchedEpisodes, meta, selectedEpisode])

  const handlePlayEpisodeRef = useRef(null)
  handlePlayEpisodeRef.current = handlePlayEpisode
  const nextEpisodeRef = useRef(null)
  nextEpisodeRef.current = nextEpisode
  const onPlayNext = useCallback(() => {
    const ep = nextEpisodeRef.current
    if (!ep) return
    // Guard: el popup (web o nativo) y handleEnded pueden dispararse ambos.
    // Solo el primero cuenta.
    if (nextEpisodeTriggeredRef.current) {
      console.log('[Details] onPlayNext: already triggered, skipping')
      return
    }
    nextEpisodeTriggeredRef.current = true
    handlePlayEpisodeRef.current(ep, { fromAutoplay: true })
  }, [])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <LogoLoader size={80} />
        <p className="text-dark-400 text-sm">Cargando enlaces...</p>
      </div>
    )
  }

  if (!meta) {
    return (
      <EmptyState minH="min-h-[60vh]" action="Volver al inicio" onAction={() => navigate('/')}>
        <p className="text-lg">Contenido no encontrado</p>
      </EmptyState>
    )
  }

  const fav = favorites.some(f => f.id === meta.id && f.type === meta.type)
  const listed = watchlist.some(w => w.id === meta.id && w.type === meta.type)

  // Check if an episode has been watched (>= 97% progress)
  const isEpWatched = (season, episode) => {
    const key = `${meta.id}:S${season}:E${episode}`
    return !!(watchedEpisodes[key] && watchedEpisodes[key].progress >= 0.97)
  }

  // Check if all episodes of a season are watched
  const isSeasonComplete = (seasonNumber, episodeCount) => {
    if (!episodeCount || episodeCount === 0) return false
    for (let ep = 1; ep <= episodeCount; ep++) {
      if (!isEpWatched(seasonNumber, ep)) return false
    }
    return true
  }

  // Reparto + Similar + Recomendaciones: compartido entre la vista de serie y
  // la de temporada (antes estaba duplicado entero en cada una).
  const relatedSections = (
    <>
      {/* Cast - justo encima de Similar */}
      {(cast.length > 0 || castLoading) && (
        <div className="mt-8" ref={castSectionRef}>
          <h2 className="flex items-center gap-2 text-xl font-bold text-white mb-4">
            <Users size={18} className="text-primary-500" />
            Reparto
          </h2>
          {castLoading ? (
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex-shrink-0 w-20 text-center">
                  <div className="w-16 h-16 rounded-full bg-dark-700 mx-auto mb-2 animate-pulse" />
                  <div className="h-3 bg-dark-700 rounded mb-1 animate-pulse" />
                  <div className="h-3 bg-dark-700 rounded w-12 mx-auto animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
            <div data-tv-row className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {cast.map(member => (
                <div key={member.id} data-tv-card tabIndex={0} role="button" className="flex-shrink-0 w-20 text-center cursor-pointer"
                  onClick={() => handleSelectPerson(member)}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handleSelectPerson(member))}
                >
                  {member.photo ? (
                    <LazyImage
                      src={member.photo}
                      alt={member.name}
                      className="w-16 h-16 rounded-full object-cover mx-auto mb-2 border-2 border-dark-700"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-full bg-dark-700 mx-auto mb-2 flex items-center justify-center">
                      <Users size={20} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white font-medium truncate">{member.name}</p>
                  <p className="text-xs text-dark-500 truncate">{member.character}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {meta.similar && meta.similar.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xl font-bold text-white mb-4">Similar</h2>
          <div data-tv-row className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
            {meta.similar.map(item => {
              const goToItem = () => navigate(`/details/${item.type}/${item.id}`)
              return (
                <div
                  key={`${item.type}-${item.id}`}
                  data-tv-card
                  tabIndex={0}
                  role="button"
                  className="flex-shrink-0 w-32 sm:w-36 cursor-pointer"
                  onClick={goToItem}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), goToItem())}
                >
                  {item.poster ? (
                    <LazyImage src={item.poster} alt={item.name} className="w-full aspect-[2/3] object-cover rounded-lg" />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-dark-700 rounded-lg flex items-center justify-center">
                      <FilmIcon size={24} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white mt-2 truncate">{item.name}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {meta.recommendations && meta.recommendations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xl font-bold text-white mb-4">Recomendaciones</h2>
          <div data-tv-row className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
            {meta.recommendations.map(item => {
              const goToItem = () => navigate(`/details/${item.type}/${item.id}`)
              return (
                <div
                  key={`${item.type}-${item.id}`}
                  data-tv-card
                  tabIndex={0}
                  role="button"
                  className="flex-shrink-0 w-32 sm:w-36 cursor-pointer"
                  onClick={goToItem}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), goToItem())}
                >
                  {item.poster ? (
                    <LazyImage src={item.poster} alt={item.name} className="w-full aspect-[2/3] object-cover rounded-lg" />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-dark-700 rounded-lg flex items-center justify-center">
                      <FilmIcon size={24} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white mt-2 truncate">{item.name}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="min-h-screen pb-8">
      {selectedStream && (
        <VideoPlayer
          // Canales: modo live (sin progreso/duración, con zapping y overlay
          // EPG) — antes iba siempre 'vod' y "Seguir viendo" abría la TV
          // como si fuera una película.
          mode={playerMeta?.type === 'live' || playerMeta?.type === 'channel' ? 'live' : 'vod'}
          stream={selectedStream}
          title={selectedEpisode ? `${meta.name} - ${selectedEpisode.name}` : meta.name}
          meta={playerMeta}
          startTime={resumeTime}
          channels={liveChannels}
          channelIndex={liveChannels.findIndex(c => c.id === id)}
          onZapChannel={handleZapChannel}
          nextEpisode={nextEpisode}
          episodes={playerEpisodes}
          // Chips T1/T2… del panel nativo: cambio de temporada sin salir del
          // player — carga los episodios y los empuja con setEpisodes().
          onLoadSeason={handleLoadSeasonForPlayer}
          onPlayEpisode={(ep) => handlePlayEpisode(ep, { forcePlay: true })}
          onPlayNext={onPlayNext}
          onClose={() => {
            cancelAutoplay()
            nextEpisodeTriggeredRef.current = false
            setSelectedStream(null)
            // Guardar el último canal visto al cerrar el player (igual que LiveTV).
            // Solo se guarda uno: el último canal al que se zappeó o el inicial.
            const ch = currentChannelRef.current
            if (ch && (meta?.type === 'live' || meta?.type === 'channel')) {
              addToHistory({
                id: ch.id,
                type: ch.type || 'live',
                name: ch.name,
                poster: ch.poster || ch.logo || '',
                server: ch.group || ch.pluginName || '',
              })
            }
            // Canales: sin página de detalles — al cerrar se vuelve atrás.
            if (meta?.type === 'live' || meta?.type === 'channel') navigate(-1)
          }}
          onEnded={handleEnded}
        />
      )}

      {/* Error de resolución debrid/etc: overlay fijo — el banner inline
          solo existía dentro de la vista de episodio y en películas el
          error se tragaba sin mostrarse. */}
      {episodeError && (
        <div className="fixed bottom-6 left-4 right-4 z-[75] flex items-center gap-2 text-red-400 text-sm bg-red-500/15 border border-red-500/40 rounded-lg p-3 backdrop-blur">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span className="flex-1">{episodeError}</span>
          <button
            onClick={() => setEpisodeError(null)}
            className="text-dark-400 hover:text-white"
            aria-label="Cerrar aviso"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Pantalla de carga mientras se resuelve un servidor/enlace */}
      {resolvingStream && (
        <div className="fixed inset-0 z-[70] bg-black/95 flex flex-col items-center justify-center gap-5">
          <LogoLoader size={80} />
          <p className="text-white text-base">
            {resolvingText || 'Resolviendo vídeo…'}
          </p>
        </div>
      )}

      {/* Resume dialog — data-tv-modal confina la navegación D-pad al
          diálogo y autoFocus lleva el foco a "Continuar" al abrirse */}
      {showResumeDialog && (
        <Modal onClose={() => setShowResumeDialog(false)} labelledBy="resume-title" closeOnBackdrop={false}>
            <div className="flex items-center gap-3 mb-4">
              <Clock className="text-primary-400" size={28} />
              <h2 id="resume-title" className="text-xl font-bold text-white">Continuar reproducción</h2>
            </div>
            <p className="text-dark-300 mb-2">
              Tienes una reproducción a medias.
            </p>
            <p className="text-primary-400 font-medium mb-6">
              Visto: {formatDuration(savedTime)} / {formatDuration(savedDuration)} ({Math.round(savedProgress * 100)}%)
            </p>
            <div data-tv-row className="flex gap-3">
              <button
                data-tv-card
                data-tv-initial
                autoFocus
                onClick={handleResume}
                className="btn-primary flex-1 py-3 flex items-center justify-center gap-2"
              >
                <Play size={18} /> Continuar
              </button>
              <button
                data-tv-card
                onClick={handleStartOver}
                className="btn-secondary flex-1 py-3 flex items-center justify-center gap-2"
              >
                <RotateCcw size={18} /> Empezar
              </button>
            </div>
            <button
              data-tv-card
              onClick={() => setShowResumeDialog(false)}
              className="w-full mt-3 text-dark-400 text-sm hover:text-white transition-colors"
            >
              Cancelar
            </button>
        </Modal>
      )}

      {/* Picker de archivo dentro del torrent — packs con varios vídeos */}
      {torrentPick && (
        <Modal onClose={() => setTorrentPick(null)} labelledBy="torrent-pick-title" className="max-h-[80vh] flex flex-col">
            <h2 id="torrent-pick-title" className="text-xl font-bold text-white mb-1">Elegir archivo</h2>
            <p className="text-dark-400 text-sm mb-4">
              Este torrent contiene {torrentPick.files.length} vídeos
            </p>
            <div data-tv-row className="flex flex-col gap-2 overflow-y-auto min-h-0">
              {torrentPick.files.map((f, i) => (
                <div key={f.index} className="flex items-stretch gap-2">
                  <button
                    data-tv-card
                    {...(i === 0 ? { 'data-tv-initial': true, autoFocus: true } : {})}
                    onClick={() => {
                      const pick = torrentPick
                      setTorrentPick(null)
                      handlePlay({ ...pick.stream, torrentFileIndex: f.index }, pick.skipResume, pick.candidatesPool)
                    }}
                    className="flex-1 text-left bg-dark-700 hover:bg-dark-600 rounded-lg px-4 py-3 transition-colors"
                  >
                    <p className="text-white text-sm break-all">{f.name}</p>
                    <p className="text-dark-400 text-xs mt-1">
                      {f.size >= 1e9 ? `${(f.size / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(f.size / 1e6))} MB`}
                    </p>
                  </button>
                  <button
                    data-tv-card
                    title="Descargar este archivo"
                    onClick={() => {
                      const pick = torrentPick
                      setTorrentPick(null)
                      downloadTorrent(pick.stream, f.index)
                    }}
                    className="px-3 bg-dark-700 hover:bg-dark-600 text-dark-300 hover:text-primary-400 rounded-lg transition-colors"
                  >
                    <Download size={18} />
                  </button>
                </div>
              ))}
            </div>
            <button
              data-tv-card
              onClick={() => setTorrentPick(null)}
              className="w-full mt-4 text-dark-400 text-sm hover:text-white transition-colors"
            >
              Cancelar
            </button>
        </Modal>
      )}

      {/* Confirmación antes de lanzar la descarga en debrid */}
      {debridConfirm && (
        <Modal onClose={() => setDebridConfirm(null)} labelledBy="debrid-confirm-title">
          <h2 id="debrid-confirm-title" className="text-xl font-bold text-white mb-1">Descargar en debrid</h2>
          {/* Layout estilo Torrentio: [AD ⏳] addon · calidad, filename,
              y la línea de stats 💾 size 👤 seeds ⚙️ indexer 🌎 idioma */}
          <p className="text-sm mb-2">
            <span className="text-amber-400 font-bold">[AD ⏳]</span>{' '}
            <span className="text-dark-200 font-medium">
              {debridConfirm.server || 'AIOStreams'}{debridConfirm.quality ? ` ${debridConfirm.quality}` : ''}
            </span>
          </p>
          <p className="text-dark-300 text-sm mb-2 break-all">{debridConfirm.releaseTitle || debridConfirm.name}</p>
          <div className="text-sm text-dark-300 space-y-1.5 mb-2">
            <p>
              {debridConfirm.size && <span>💾{debridConfirm.size} </span>}
              {debridConfirm.seeds > 0 && <span className="text-emerald-400">👤{debridConfirm.seeds} </span>}
              {debridConfirm._magnet && (
                <span>📡{(debridConfirm._magnet.match(/&tr=/g) || []).length} trackers </span>
              )}
              {debridConfirm.server && <span>⚙️{debridConfirm.server}</span>}
            </p>
            {debridConfirm.lang && <p>🌎 {debridConfirm.lang}</p>}
          </div>
          <p className="text-dark-400 text-sm mb-4">
            Esta fuente aún no está cacheada. Se enviará a AllDebrid para descargarla — aparecerá reproducible al terminar.
          </p>
          <div className="flex gap-3">
            <button
              data-tv-card
              data-tv-initial
              autoFocus
              onClick={() => {
                const s = debridConfirm
                setDebridConfirm(null)
                startDebridDownload(s)
              }}
              className="flex-1 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-3 font-medium transition-colors"
            >
              Descargar
            </button>
            <button
              data-tv-card
              onClick={() => setDebridConfirm(null)}
              className="flex-1 bg-dark-700 hover:bg-dark-600 text-dark-300 rounded-lg px-4 py-3 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </Modal>
      )}

      {/* Chip de progreso de la descarga offline (torrent → Descargas) */}
      {dlStatus && (
        <div className="fixed bottom-20 right-4 z-50 bg-dark-800 border border-dark-700 rounded-xl px-4 py-3 shadow-2xl flex items-center gap-3 max-w-sm">
          {dlStatus.done
            ? <Check size={18} className="text-emerald-400 flex-shrink-0" />
            : <Download size={18} className="text-primary-400 flex-shrink-0 animate-pulse" />}
          <div className="min-w-0">
            <p className="text-white text-sm truncate">
              {dlStatus.done ? 'Descargado' : 'Descargando'} · {dlStatus.name}
            </p>
            {!dlStatus.done && (
              <div className="w-48 h-1.5 bg-dark-600 rounded-full mt-1.5 overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full transition-all"
                  style={{ width: `${Math.round((dlStatus.progress || 0) * 100)}%` }}
                />
              </div>
            )}
            {!dlStatus.done && (
              <p className="text-dark-400 text-xs mt-1">{Math.round((dlStatus.progress || 0) * 100)}%</p>
            )}
          </div>
        </div>
      )}

      {/* Botón atrás fijo — siempre visible encima del hero y del contenido */}
      <button
        data-tv-card
        onClick={() => navigate(-1)}
        className="fixed top-4 left-4 z-50 btn-ghost bg-black/60 backdrop-blur p-2 rounded-full focus:bg-primary-600 focus:text-white focus:ring-2 focus:ring-primary-400"
      >
        <ArrowLeft size={24} />
      </button>

      <div className="relative h-[40vh] sm:h-[50vh] overflow-hidden">
        {meta.backdrop || meta.poster ? (
          <img
            src={meta.backdrop || meta.poster}
            alt={meta.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-dark-800" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-dark-950 via-dark-950/50 to-transparent" />
      </div>

      <div className="px-4 lg:px-6 -mt-32 relative z-10">
        {view === 'series' && (
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="flex-shrink-0 w-32 sm:w-48 mx-auto sm:mx-0">
            {meta.poster && (
              <img
                src={meta.poster}
                alt={meta.name}
                className="w-full rounded-xl shadow-2xl border border-dark-700"
              />
            )}
          </div>

          <div className="flex-1 space-y-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{meta.name}</h1>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              {meta.year && <span className="text-dark-300">{meta.year}</span>}
              {meta.rating && (
                <span className="flex items-center gap-1 text-yellow-400">
                  <Star size={14} className="fill-yellow-400" />
                  {meta.rating.toFixed(1)}
                </span>
              )}
              {meta.runtime && (
                <span className="flex items-center gap-1 text-dark-300">
                  <Clock size={14} />
                  {meta.runtime}
                </span>
              )}
              {meta.seasons && (
                <span className="text-dark-300">{meta.seasons} temporada{meta.seasons !== 1 ? 's' : ''}</span>
              )}
            </div>

            {meta.genres && meta.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {meta.genres.map(g => (
                  <span key={g} className="text-xs bg-dark-800 text-dark-300 px-3 py-1 rounded-full">
                    {g}
                  </span>
                ))}
              </div>
            )}

            {meta.nowPlaying && (
              <div className="flex items-center gap-2 text-sm bg-primary-900/30 border border-primary-800/50 rounded-lg px-3 py-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-primary-300 font-medium">En directo:</span>
                <span className="text-white truncate">{meta.nowPlaying}</span>
              </div>
            )}

            {meta.description && (
              <p className="text-dark-300 text-sm sm:text-base leading-relaxed max-w-2xl">
                {meta.description}
              </p>
            )}

            {/* Cast moved down next to Similar */}

            <div data-tv-row className="flex items-center gap-3 pt-2">
              {/* Main play button - uses saved server or best stream */}
              {streams.length > 0 && !meta.seasonsList && (
                <button
                  data-tv-card
                  tabIndex={0}
                  onClick={() => {
                    const autoplayEnabled = localStorage.getItem('octostream_autoplay') !== 'false'
                    const savedServer = historyItem?.server || ''
                    const savedStream = savedServer ? streams.find(s => (s.server || s.pluginName) === savedServer) : null
                    const chosen = savedStream || sortByLangPriority(streams)[0]
                    // If there's saved progress, play directly from saved position
                    if (savedProgress > 0.05 && savedProgress < 0.95 && savedTime > 0) {
                      setResumeTime(savedTime)
                      addToHistory({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, server: chosen.server || chosen.pluginName || '', ...(meta.seasonsList ? { seasonsList: meta.seasonsList } : {}) })
                      handlePlay(chosen, true)
                    } else {
                      handlePlay(chosen)
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.currentTarget.click()
                    }
                  }}
                  disabled={resolvingStream}
                  className="btn-primary px-6 py-3 flex items-center gap-2 font-medium"
                >
                  <Play size={22} className="fill-white" />
                  {savedProgress > 0.05 && savedProgress < 0.95 ? 'Continuar' : 'Reproducir'}
                </button>
              )}
              <button
                data-tv-card
                onClick={() => toggleWatchlist(meta)}
                title={listed ? 'Quitar de Pendientes' : 'Añadir a Pendientes'}
                className={`btn-secondary p-3 ${listed ? 'text-primary-400' : ''}`}
              >
                <Bookmark size={22} className={listed ? 'fill-primary-400' : ''} />
              </button>
              <button
                data-tv-card
                onClick={() => toggleFavorite(meta)}
                className={`btn-secondary p-3 ${fav ? 'text-red-400' : ''}`}
              >
                <Heart size={22} className={fav ? 'fill-red-400' : ''} />
              </button>
              {meta.trailer && sanitizeUrl(meta.trailer) && (
                <button
                  data-tv-card
                  onClick={handlePlayTrailer}
                  disabled={trailerLoading}
                  className="btn-secondary p-3"
                  aria-label="Reproducir tráiler"
                >
                  {trailerLoading ? (
                    <OctoLoader size={22} />
                  ) : (
                    <FilmIcon size={22} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
        )}

        {/* === VISTA SERIE (o película) === */}
        {view === 'series' && (
          <>
        {/* Continuar viendo el último episodio - solo para series con progreso guardado */}
        {meta.seasonsList && historyItem?.season != null && historyItem?.episode != null &&
         savedProgress > 0.05 && savedProgress < 0.95 && (
          <div
            data-tv-card
            tabIndex={0}
            role="button"
            onClick={resumeSavedEpisode}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.currentTarget.click()
              }
            }}
            className="mt-6 p-4 rounded-xl bg-primary-600/20 border border-primary-500/30 flex items-center gap-4 cursor-pointer hover:bg-primary-600/30 transition-colors"
          >
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-primary-600 flex items-center justify-center">
              <Play size={24} className="fill-white text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-primary-300 font-medium">Continuar viendo</p>
              <p className="text-white font-medium truncate">
                T{historyItem.season} · E{historyItem.episode}
                {historyItem.episodeName ? `: ${historyItem.episodeName}` : ''}
              </p>
              <p className="text-xs text-dark-400">
                {formatDuration(savedTime)} / {formatDuration(savedDuration)} ({Math.round(savedProgress * 100)}%)
              </p>
            </div>
            <div className="flex-shrink-0 flex items-center gap-2 btn-primary px-4 py-2 rounded-lg">
              <Play size={18} className="fill-white" />
              <span>Reanudar</span>
            </div>
          </div>
        )}

        {/* Temporadas - solo para series */}
        {meta.seasonsList && meta.seasonsList.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Temporadas</h2>
            <div data-tv-grid className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {meta.seasonsList.map(season => {
                const seasonDone = isSeasonComplete(season.seasonNumber, season.episodeCount)
                return (
                  <div
                    key={season.id}
                    tabIndex={0}
                    data-tv-card
                    role="button"
                    className="card cursor-pointer relative"
                    onClick={() => handleSelectSeason(season)}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handleSelectSeason(season))}
                  >
                    {(season.poster || meta.poster) ? (
                      <LazyImage src={season.poster || meta.poster} alt={season.name} className="w-full aspect-[2/3] object-cover" />
                    ) : (
                      <div className="w-full aspect-[2/3] bg-dark-700 flex items-center justify-center">
                        <FilmIcon size={32} className="text-dark-500" />
                      </div>
                    )}
                    {seasonDone && (
                      <div className="absolute top-2 right-2 bg-green-500 rounded-full p-1 shadow-lg">
                        <Check size={14} className="text-white" />
                      </div>
                    )}
                    <div className="p-2">
                      <p className="text-sm text-white font-medium truncate">{season.name}</p>
                      <p className="text-xs text-dark-400">{season.episodeCount} episodios</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Episodios de canales propios (Plurtasko) - solo si no hay seasonsList */}
        {Array.isArray(meta.episodes) && meta.episodes.length > 0 && !meta.seasonsList && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Episodios</h2>
            <div data-tv-list className="space-y-2">
              {meta.episodes.map(ep => {
                const playEpisode = () => {
                  setSelectedEpisode(ep)
                  if (streams.length > 0) {
                    const savedServer = historyItem?.server || ''
                    const savedStream = savedServer ? streams.find(s => (s.server || s.pluginName) === savedServer) : null
                    handlePlay(savedStream || sortByLangPriority(streams)[0])
                  }
                }
                return (
                  <div
                    key={ep.id}
                    tabIndex={0}
                    data-tv-item
                    role="button"
                    className="flex items-center gap-4 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer"
                    onClick={playEpisode}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), playEpisode())}
                  >
                    <div className="flex-shrink-0 w-12 h-12 bg-primary-600 rounded-lg flex items-center justify-center font-bold">
                      {ep.episode}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{ep.name}</p>
                      <p className="text-xs text-dark-400">
                        T{ep.season} · E{ep.episode}
                      </p>
                      {ep.description && (
                        <p className="text-xs text-dark-500 truncate mt-1">{ep.description}</p>
                      )}
                    </div>
                    <Play size={20} className="text-dark-400 flex-shrink-0" />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Fuentes - solo para películas o contenido sin temporadas */}
        {!meta.seasonsList && streams.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">
              Fuentes disponibles
            </h2>
            {resolvingStream && (
              <div className="flex items-center gap-2 text-primary-400 mb-4">
                <OctoLoader size={20} />
                <span className="text-sm">
                  {'Resolviendo enlace fresco...'}
                </span>
              </div>
            )}
            <StreamList
              streams={sortByLangPriority(streams)}
              onPlay={handlePlay}
              onDownload={handleDownloadClick}
              disabled={!!resolvingStream}
            />
          </div>
        )}

        {streams.length === 0 && !Array.isArray(meta.episodes) && !meta.seasonsList && (
          <div className="mt-8 text-center py-8">
            <p className="text-dark-400">No hay fuentes disponibles para este contenido</p>
          </div>
        )}

        {relatedSections}
          </>
        )}

        {/* === VISTA TEMPORADA === */}
        {view === 'season' && selectedSeason && (
          <>
        <div data-tv-row className="mt-4">
        <button
          onClick={() => setView('series')}
          data-tv-card
          className="flex items-center gap-2 text-dark-300 hover:text-white transition-colors focus:text-white focus:ring-2 focus:ring-primary-400 rounded-lg px-2 py-1"
        >
          <ArrowLeft size={20} />
          <span>Volver a temporadas</span>
        </button>
        </div>

        <div className="mt-4 flex gap-4">
          {selectedSeason.poster && (
            <img
              src={selectedSeason.poster}
              alt={selectedSeason.name}
              className="flex-shrink-0 w-24 sm:w-32 rounded-lg shadow-xl border border-dark-700"
            />
          )}
          <div className="flex-1 space-y-2">
            <h2 className="text-xl sm:text-2xl font-bold text-white">{selectedSeason.name}</h2>
            <p className="text-dark-300 text-sm">{selectedSeason.episodeCount} episodios</p>
            {selectedSeason.airDate && (
              <p className="text-dark-400 text-xs">Estreno: {selectedSeason.airDate}</p>
            )}
            {selectedSeason.description && (
              <p className="text-dark-300 text-sm leading-relaxed">{selectedSeason.description}</p>
            )}
          </div>
        </div>

        <div className="mt-6">
          <h3 className="text-lg font-bold text-white mb-4">Episodios</h3>
          {loadingEpisodes ? (
            <div className="flex items-center gap-2 text-primary-400">
              <OctoLoader size={20} />
              <span className="text-sm">Cargando episodios...</span>
            </div>
          ) : seasonEpisodes.length > 0 ? (
            <div data-tv-list className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" onFocus={episodesWindow.onFocusNearEnd}>
              {episodesWindow.visible.map((ep, wIdx) => {
                const epWatched = isEpWatched(ep.season, ep.episode)
                return (
                <div
                  key={ep.id}
                  ref={wIdx === 0 ? firstEpisodeRef : null}
                  tabIndex={0}
                  data-tv-item
                  data-windex={wIdx}
                  role="button"
                  className="flex gap-3 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer relative"
                  onClick={() => handlePlayEpisode(ep)}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handlePlayEpisode(ep))}
                >
                  {ep.poster ? (
                    <LazyImage
                      src={ep.poster}
                      alt={ep.name}
                      className="flex-shrink-0 w-24 h-14 rounded object-cover"
                    />
                  ) : (
                    <div className="flex-shrink-0 w-24 h-14 bg-primary-600 rounded flex items-center justify-center font-bold text-white">
                      E{ep.episode}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className={`font-medium truncate ${epWatched ? 'text-green-400' : 'text-white'}`}>{ep.name}</p>
                    <p className="text-xs text-dark-400">
                      T{ep.season} · E{ep.episode}
                      {ep.airDate && ` · ${ep.airDate}`}
                    </p>
                    {ep.description && (
                      <p className="text-xs text-dark-500 truncate mt-1">{ep.description}</p>
                    )}
                  </div>
                  {epWatched ? (
                    <div className="flex-shrink-0 self-center">
                      <div className="bg-green-500 rounded-full p-1">
                        <Check size={14} className="text-white" />
                      </div>
                    </div>
                  ) : (
                    <Play size={18} className="text-dark-400 flex-shrink-0 self-center" />
                  )}
                </div>
                )
              })}
              {episodesWindow.hasMore && <div ref={episodesWindow.sentinelRef} className="h-1" />}
            </div>
          ) : (
            <p className="text-dark-400 text-sm">No hay episodios disponibles</p>
          )}
        </div>

        {relatedSections}
          </>
        )}

        {/* === VISTA EPISODIO (enlaces) === */}
        {view === 'episode' && selectedEpisode && (
          <>
        <div data-tv-row className="mt-4">
        <button
          onClick={() => setView('season')}
          data-tv-card
          className="flex items-center gap-2 text-dark-300 hover:text-white transition-colors focus:text-white focus:ring-2 focus:ring-primary-400 rounded-lg px-2 py-1"
        >
          <ArrowLeft size={20} />
          <span>Volver a episodios</span>
        </button>
        </div>

        <div className="mt-4 flex gap-4">
          {selectedEpisode.poster && (
            <img
              src={selectedEpisode.poster}
              alt={selectedEpisode.name}
              className="flex-shrink-0 w-24 sm:w-32 rounded-lg shadow-xl border border-dark-700"
            />
          )}
          <div className="flex-1 space-y-2">
            <h2 className="text-xl sm:text-2xl font-bold text-white">{selectedEpisode.name}</h2>
            <p className="text-dark-300 text-sm">
              {meta.name} · T{selectedEpisode.season} · E{selectedEpisode.episode}
            </p>
            {selectedEpisode.airDate && (
              <p className="text-dark-400 text-xs">Estreno: {selectedEpisode.airDate}</p>
            )}
            {selectedEpisode.description && (
              <p className="text-dark-300 text-sm leading-relaxed">{selectedEpisode.description}</p>
            )}
          </div>
        </div>

        {episodeLoading ? (
          <div className="mt-8 flex items-center gap-2 text-primary-400">
            <OctoLoader size={20} />
            <span className="text-sm">Buscando enlaces...</span>
          </div>
        ) : episodeStreams.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-lg font-bold text-white mb-4">Fuentes disponibles</h3>
            <StreamList
              streams={sortByLangPriority(episodeStreams)}
              onPlay={handlePlay}
              onDownload={handleDownloadClick}
              disabled={!!resolvingStream}
            />
          </div>
        ) : (
          <div className="mt-8 text-center py-8">
            <p className="text-dark-400">No se encontraron enlaces para este episodio</p>
          </div>
        )}

        {episodeError && (
          <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span className="flex-1">{episodeError}</span>
            <button
              onClick={() => setEpisodeError(null)}
              className="text-dark-400 hover:text-white"
              aria-label="Cerrar aviso"
            >
              <X size={14} />
            </button>
          </div>
        )}
          </>
        )}

        <div className="h-8" />
      </div>

      {/* Trailer player (NewPipeExtractor on Android, iframe fallback on web) */}
      {trailerStream && !trailerStream.fallback && (
        <VideoPlayer
          stream={trailerStream}
          title={`Tráiler: ${meta.name}`}
          onClose={() => setTrailerStream(null)}
        />
      )}
      {trailerStream && trailerStream.fallback && (
        <div
          className="fixed inset-0 z-50 bg-black flex items-center justify-center"
          onClick={() => setTrailerStream(null)}
        >
          <button
            onClick={() => setTrailerStream(null)}
            className="absolute top-4 right-4 z-10 btn-secondary p-2"
            aria-label="Cerrar tráiler"
          >
            <X size={18} />
          </button>
          <div className="aspect-video w-full max-w-4xl">
            <iframe
              src={trailerStream.url}
              className="w-full h-full"
              allowFullScreen
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          </div>
        </div>
      )}

      {/* Person details popup rendered outside the scrollable TV content */}
      {selectedPerson && createPortal((
        <Modal onClose={() => setSelectedPerson(null)} labelledBy="person-title" className="max-h-[80vh] overflow-y-auto">
            <div className="flex gap-4 mb-4">
              {selectedPerson.photo ? (
                <img
                  src={selectedPerson.photo}
                  alt={selectedPerson.name}
                  className="w-24 h-24 rounded-full object-cover border-2 border-dark-700 flex-shrink-0"
                />
              ) : (
                <div className="w-24 h-24 rounded-full bg-dark-700 flex items-center justify-center flex-shrink-0">
                  <Users size={32} className="text-dark-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 id="person-title" className="text-lg font-bold text-white truncate">{selectedPerson.name}</h3>
                {selectedPerson.character && (
                  <p className="text-sm text-primary-400 truncate">como {selectedPerson.character}</p>
                )}
                {selectedPerson.knownFor && (
                  <p className="text-xs text-dark-400 mt-1">Conocido por: {selectedPerson.knownFor}</p>
                )}
                {selectedPerson.birthday && (
                  <p className="text-xs text-dark-400">
                    Nacimiento: {selectedPerson.birthday}
                    {selectedPerson.placeOfBirth && ` · ${selectedPerson.placeOfBirth}`}
                  </p>
                )}
              </div>
            </div>
            {personLoading || selectedPerson.loading ? (
              <div className="flex items-center gap-2 text-primary-400 py-4">
                <OctoLoader size={18} />
                <span className="text-sm">Cargando información...</span>
              </div>
            ) : selectedPerson.biography ? (
              <p className="text-sm text-dark-300 leading-relaxed">{selectedPerson.biography}</p>
            ) : (
              <p className="text-sm text-dark-400">No hay biografía disponible.</p>
            )}
            <button
              ref={personCloseRef}
              data-tv-card
              tabIndex={0}
              onClick={() => setSelectedPerson(null)}
              className="w-full mt-4 btn-secondary py-2 text-sm"
            >
              Cerrar
            </button>
        </Modal>
      ), document.body)}
    </div>
  )
}
