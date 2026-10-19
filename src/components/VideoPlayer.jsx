import { useEffect, useRef, useState, useCallback } from 'react'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'
import { inferStreamType } from '../utils/streamType.js'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { setPlayerOpen, markPlayerClosed } from '../utils/tvNavigation.js'
import {
  playStream, stopPlayback, pausePlayback, resumePlayback, seekTo,
  isExoPlayerAvailable, isDesktopPlayerAvailable, playEmbed, playRelay,
  resolveEmbed, setChannels, setEpisodes, setNextEpisode,
  setCastRequestListener, setLoadingText, setPlaybackStateListener,
  isMpvEmbedded, mpvOscState, mpvOscMenu, mpvMouse, mpvKey, mpvPip, mpvClick,
} from '../utils/exoPlayer.js'
import { getTorrentEngine } from '../utils/torrentEngine.js'
import { resolveEmbed as resolveEmbedJs } from '../plugins/bundled/plurtasko/resolver.js'
import { unlockLink as adUnlockLink } from '../plugins/bundled/alldebrid.js'
import { pluginManager } from '../plugins/manager.js'
import { ExoPlayer } from '@octostream/exo-player'
import { useStore } from '../store/useStore.js'
import { X, ExternalLink, Captions } from 'lucide-react'
import CastIcon from './CastIcon.jsx'
import CastMenu from './CastMenu.jsx'
import { sendStop } from '../utils/remotePlay.js'
import LogoLoader from './LogoLoader.jsx'

// Log solo host — las URLs de stream llevan tokens firmados.
const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

const fmtBytes = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`
const fmtRate = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${Math.round(b / 1e3)} KB/s`

// Texto de progreso del motor P2P — compartido entre el overlay de carga y
// el overlay nativo (vía setLoadingText).
function torrentStatusText(ev) {
  if (!ev || ev.state === 'metadata' || ev.state === 'connecting') {
    return `Conectando a peers…${ev?.peers ? ` (${ev.peers})` : ''}`
  }
  const pct = Math.round((ev.progress || 0) * 100)
  const parts = [`${fmtRate(ev.downloadRate || 0)} ↓`, `${ev.peers || 0} peers`]
  if (ev.totalSize > 0) parts.push(`${fmtBytes(ev.totalDone || 0)} / ${fmtBytes(ev.totalSize)}`)
  if (ev.fileName) parts.push(ev.fileName)
  return `Descargando torrent… ${pct}%\n${parts.join(' · ')}`
}

function VideoPlayerInner({ mode = 'vod', stream, title, onClose, onEnded, meta, startTime = 0, channels = null, channelIndex = -1, onZapChannel = null, nextEpisode = null, onPlayNext = null, episodes = null, onPlayEpisode = null, onLoadSeason = null }) {
  const updateProgress = useStore(s => s.updateProgress)
  const [loading, setLoading] = useState(true)
  const [resolvingEmbed, setResolvingEmbed] = useState(false)
  const [torrentProgress, setTorrentProgress] = useState(null)
  const [error, setError] = useState(null)
  // 'exo' | 'mpv' | null — qué reproductor nativo está sirviendo el stream.
  const [nativeKind, setNativeKind] = useState(null)
  // mpv embebido con --wid: monta el forwarder de input para el OSC.
  const [mpvEmb, setMpvEmb] = useState(false)
  // Resultados OpenSubtitles servidos al menú del OSC (subpick por índice).
  const oscSubsRef = useRef(null)
  const pipRef = useRef(false) // PiP de escritorio (ventana mini siempre-encima)
  // Ocultar el cursor tras idle cuando mpv está embebido (como un player).
  const [cursorHidden, setCursorHidden] = useState(false)
  const cursorTimerRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  // Embeds en web (sin app): el iframe del proveedor es la única vía.
  const [webEmbed, setWebEmbed] = useState(false)
  const lastStreamRef = useRef(null)
  // Guard: onClose solo una vez — el nativo emite 'closed' al pulsar atrás y
  // el cleanup vuelve a emitirlo al llamar stopPlayback().
  const closedRef = useRef(false)
  const endedRef = useRef(false)
  // El nativo a veces emite un "closed" espurio ~150ms después de abrir
  // (race del Dialog anterior cerrándose) — se ignoran los closed del primer
  // segundo tras abrir un stream.
  const openedAtRef = useRef(0)
  // Reintento único de re-resolución cuando la URL firmada caduca en mitad
  // de la reproducción (CDN devuelve 4xx al refrescar el manifest HLS).
  const reResolveRef = useRef(false)
  const [showCastMenu, setShowCastMenu] = useState(false)
  // Selector OpenSubtitles (addon Stremio, sin API key) para mpv de escritorio.
  // En Android el menú nativo de ExoPlayer ya trae la misma búsqueda.
  const [showSubMenu, setShowSubMenu] = useState(false)
  const [subResults, setSubResults] = useState(null) // null | [] | [...]
  const [subMsg, setSubMsg] = useState('')
  const [casting, setCasting] = useState(false)
  const [castDevice, setCastDevice] = useState(null)
  const [remoteDevice, setRemoteDevice] = useState(null) // OctoStream LAN
  const [copiedUrl, setCopiedUrl] = useState(false)
  const castSessionRef = useRef(null)
  // Overrides del botón Cast nativo (URL/título que envía el nativo) — en
  // estado porque los consume el render (CastMenu), no en refs.
  const [castStream, setCastStream] = useState(null)
  const [castTitle, setCastTitle] = useState(null)
  // Refs frescos para el listener nativo 'episodeSelected': el callback se
  // registra una vez al llamar a playStream y debe leer la lista actual.
  const episodesRef = useRef(episodes)
  const onPlayEpisodeRef = useRef(onPlayEpisode)
  const onLoadSeasonRef = useRef(onLoadSeason)
  // Lista que está mostrando el panel nativo AHORA MISMO — cambia cuando el
  // usuario elige otra temporada en los chips (seasonSelected → setEpisodes).
  const panelEpsRef = useRef({ season: meta?.season ?? 0, eps: episodes || [] })
  useEffect(() => {
    episodesRef.current = episodes
    onPlayEpisodeRef.current = onPlayEpisode
    onLoadSeasonRef.current = onLoadSeason
    // Si la prop episodes sigue correspondiendo a la temporada en pantalla,
    // sincroniza la vista del panel (watched marks, lista reordenada…).
    if (panelEpsRef.current.season === (meta?.season ?? 0)) {
      panelEpsRef.current = { season: meta?.season ?? 0, eps: episodes || [] }
    }
  })
  // Refs de posición — los handlers registrados una vez en init() deben leer
  // el valor actual (progreso al cerrar, tick verde de "visto", seek por
  // teclado). Sin estado: los eventos 'position' no re-renderizan.
  const durationRef = useRef(0)
  const currentTimeRef = useRef(0)
  const playerOpenTimerRef = useRef(null)
  const cleanupRef = useRef(null)
  // Cleanup del path nativo devuelto desde dentro de init() (async): el return
  // de init() se pierde — el cleanup real del useEffect llama a este ref.
  const exoCleanupRef = useRef(null)
  const torrentListenerRef = useRef(null)
  const torrentActiveRef = useRef(false)
  // Watchdog de torrents muertos: primer evento con 0 peers sostenidos.
  const noPeersSinceRef = useRef(0)
  // true mientras el player nativo espera datos (carga inicial o stall de
  // buffering) — el watchdog de 0-peers solo actúa con playback necesitado.
  const playerStalledRef = useRef(true)
  const nativeKindRef = useRef(null)
  // meta bloqueado al stream que suena (onPlayNext cambia meta antes de que
  // termine el episodio — sin esto el progreso/tick se guarda al siguiente).
  const currentMetaRef = useRef(null)
  const lastStreamForMetaRef = useRef(null)
  // Throttle de mousemove → IPC mpv (~50fps máx — el OSC solo necesita
  // posición para hover/auto-hide, no precision de tracking).
  const mouseTsRef = useRef(0)

  // Save final progress (100%) when an episode ends, so the green tick appears.
  // Uses currentMetaRef (not meta) to avoid marking the NEXT episode as watched
  // when onPlayNext changes meta before STATE_ENDED arrives.
  // Uses durationRef.current (not duration state) because this function is
  // captured by event-handler closures registered once during init(); the
  // state variable would be frozen at its initial value (0) in that closure.
  const saveFinalProgress = () => {
    const m = currentMetaRef.current || meta
    if (!m || m.type === 'live' || m.type === 'channel') return
    const dur = durationRef.current > 0 ? durationRef.current : 0
    // When the episode actually ended, force progress to 100% so the green
    // tick is set even if the last position update was below 97% or the
    // duration was never resolved (dur=0 → pass 1/1 → progress=1).
    updateProgress(m.id, m.type, dur > 0 ? dur : 1, dur > 0 ? dur : 1, m.season != null ? {
      season: m.season, episode: m.episode, name: m.episodeName || '',
    } : null)
  }

  // Para el motor P2P y borra los archivos del torrent (DELETE_FILES). Se
  // llama al cerrar el player, al terminar el episodio y en el cleanup del
  // componente — no se espera al desmontaje para no seguir descargando.
  const stopTorrentEngine = useCallback(() => {
    if (!torrentActiveRef.current && !torrentListenerRef.current) return
    torrentActiveRef.current = false
    noPeersSinceRef.current = 0
    try { torrentListenerRef.current?.remove?.() } catch { /* noop */ }
    torrentListenerRef.current = null
    setTorrentProgress(null)
    // Si el mini-player PiP sigue reproduciendo la URL loopback del torrent,
    // parar el motor cortaría su stream — solo se para si no hay PiP activo.
    const doStop = () => getTorrentEngine().then(te => te?.stop()).catch(() => {})
    import('@octostream/exo-player').then(m => m.ExoPlayer.isPipActive?.()).then(r => {
      if (r?.active) return
      doStop()
    }).catch(doStop)
  }, [])

  // Acciones del OSC embebido de mpv (botones estilo controles Android).
  // Las acciones internas (pause/seek/volume) las ejecuta el propio OSC;
  // aquí llegan solo las que necesitan la app.
  const handleOscAction = async (action, arg, playArgs) => {
    const idx = Number(arg)
    switch (action) {
      case 'close':
      case 'stop':
        // Restaurar la ventana si estaba en PiP antes de cerrar.
        if (pipRef.current) { mpvPip(false)?.catch?.(() => {}); pipRef.current = false }
        // stopPlayback → session.close → evento 'closed' → path normal de
        // cierre (progreso final, onClose) sin duplicar lógica.
        stopPlayback().catch(() => {})
        break
      case 'pip': {
        // Mini reproductor de escritorio: ventana pequeña siempre-encima con
        // mpv embebido dentro (equivalente al PiP de Android).
        const on = !pipRef.current
        try { pipRef.current = !!(await mpvPip(on)) } catch { /* noop */ }
        break
      }
      case 'subs': {
        if (!playArgs?.imdbId) break
        mpvOscMenu({ title: 'Subtítulos — OpenSubtitles', action: 'subpick', items: ['Buscando…'] })
        try {
          const r = await window.octostream?.player?.searchSubs?.({
            imdbId: playArgs.imdbId,
            season: playArgs.season || 0,
            episode: playArgs.episode || 0,
          })
          const list = r?.subs || []
          oscSubsRef.current = list
          if (!list.length) {
            mpvOscMenu({ title: 'Subtítulos — OpenSubtitles', action: 'subpick', items: ['Sin resultados'] })
            break
          }
          mpvOscMenu({
            title: 'Subtítulos — OpenSubtitles',
            action: 'subpick',
            items: list.map(s => `[${(s.lang || '?').toUpperCase()}] ${s.name}`),
          })
        } catch {
          mpvOscMenu({ title: 'Subtítulos — OpenSubtitles', action: 'subpick', items: ['Error de red'] })
        }
        break
      }
      case 'subpick': {
        const s = oscSubsRef.current?.[idx]
        if (!s) break
        const r = await window.octostream?.player?.addSubtitle?.({ url: s.url, label: s.name, lang: s.lang })
        window.octostream?.player?.showText?.(r?.ok
          ? `Subtítulos: ${(s.lang || '').toUpperCase()} ${s.name}`.slice(0, 80)
          : 'No se pudo aplicar el subtítulo')
        break
      }
      case 'channels': {
        const chs = playArgs?.channels?.length ? playArgs.channels : channels
        if (!chs?.length) break
        mpvOscMenu({
          title: 'Canales', action: 'zapto',
          items: chs.map(c => c.name || c.title || ''),
        })
        break
      }
      case 'zapto': {
        const chs = playArgs?.channels?.length ? playArgs.channels : channels
        const ch = chs?.[idx]
        if (ch && onZapChannel) onZapChannel({ index: idx, name: ch.name || ch.title || '' })
        break
      }
      case 'episodes': {
        if (!episodes?.length) break
        mpvOscMenu({
          title: 'Episodios', action: 'eppick',
          items: episodes.map(e => e.name || `Episodio ${e.episode}`),
        })
        break
      }
      case 'eppick': {
        const ep = episodes?.[idx]
        if (ep && onPlayEpisode) onPlayEpisode(ep)
        break
      }
      case 'next-ep':
        onPlayNext?.()
        break
      case 'cast':
        // El menú Cast es DOM — mpv cubre la ventana: se cierra la sesión
        // pero se traga el 'closed' para quedarse en la ficha con el menú.
        closedRef.current = true
        setMpvEmb(false)
        stopPlayback().catch(() => {})
        setShowCastMenu(true)
        break
      case 'fullscreen': {
        try {
          const on = !(await window.octostream?.isFullscreen?.())
          window.octostream?.setFullscreen?.(on)
        } catch { /* noop */ }
        break
      }
    }
  }

  useEffect(() => {
    if (!stream) return
    console.log('[Player] main effect running, stream=', urlHost(stream?.url || ''), 'streamChanged=', lastStreamRef.current !== stream, 'closedRef=', closedRef.current)

    // Cancel any pending setPlayerOpen(false) from a previous cleanup so it
    // can't fire after this run marks the player as open again.
    if (playerOpenTimerRef.current) {
      clearTimeout(playerOpenTimerRef.current)
      playerOpenTimerRef.current = null
    }

    const streamChanged = lastStreamRef.current !== stream
    if (streamChanged) {
      lastStreamRef.current = stream
      reResolveRef.current = false
      setLoading(true)
      setError(null)
      setWebEmbed(false)
      closedRef.current = false
      endedRef.current = false
      openedAtRef.current = Date.now()
      // currentMetaRef solo se actualiza con stream nuevo (no cuando
      // onPlayNext adelanta meta del siguiente episodio).
      lastStreamForMetaRef.current = stream
      currentMetaRef.current = meta
    }
    setPlayerOpen(true)

    const isEmbedStream = stream.streamType === 'embed' || stream.streamType === 'iframe'

    if (isEmbedStream) {
      // On Android: first try the invisible headless resolver (runs the JS
      // challenge, auto-plays, intercepts the media URL). If it resolves we
      // play the direct URL in ExoPlayer without ever showing a WebView.
      // Only if it fails do we open the visible interactive WebView.
      if (isExoPlayerAvailable()) {
        // setState diferido a microtask: el linter prohíbe setState directo
        // en el cuerpo del efecto y el WebView nativo pinta su propio loading.
        queueMicrotask(() => {
          setLoading(false)
          setResolvingEmbed(false)
          setNativeKind('exo')
        })
        nativeKindRef.current = 'exo'
        let embedCancelled = false
        let webPlaybackTried = false
        let relayTried = false
        let relayCtx = null
        let lastPlayAt = 0
        const embedReferer = stream.referer || stream.headers?.Referer || ''
        // Embeds de deportes con cuenta atrás pre-emisión (FCTV): el nativo
        // mantiene el embed abierto esperando el vídeo hasta kickoff+90min.
        const kickoff = stream._fctvItem?._matchDate || 0
        const embedWaitUntil = kickoff > Date.now() ? kickoff + 90 * 60 * 1000 : 0

        // Reproducir el embed DENTRO del WebView nativo: CDNs como el de
        // DLive/tiestep solo sirven el m3u8 a documentos del propio proveedor
        // (Referer+TLS del iframe), así que la URL extraída da 403 fuera.
        const openWebViewPlayback = () => {
          webPlaybackTried = true
          setResolvingEmbed(true)
          lastPlayAt = Date.now()
          setPlaybackStateListener(onEmbedState) // stopPlayback() lo limpia
          return playEmbed(stream.url, title || '', embedReferer, true, embedWaitUntil).then(result => {
            if (embedCancelled) return
            setResolvingEmbed(false)
            if (result?.status === 'closed') {
              if (!closedRef.current) { closedRef.current = true; markPlayerClosed(); onClose?.() }
              return
            }
            const msg = result?.status === 'timeout' ? 'Tiempo de espera agotado'
              : 'El vídeo no se pudo cargar'
            setError(msg)
            if (!closedRef.current) { closedRef.current = true; onClose?.() }
          }).catch(e => {
            if (embedCancelled) return
            setResolvingEmbed(false)
            setError(e?.message || 'No se pudo abrir el reproductor web')
          })
        }

        // Reproducir el embed por ExoPlayer a través del relay local: un
        // WebView oculto cargado en el origen del embed hace los fetch() del
        // playlist/segmentos (el CDN solo los sirve a ese origen con stack
        // Chromium) y un servidor loopback se los pasa a ExoPlayer.
        const openRelayPlayback = (ctx) => {
          relayTried = true
          setResolvingEmbed(true)
          lastPlayAt = Date.now()
          setPlaybackStateListener(onEmbedState)
          return playRelay(ctx.url, ctx.referer || '', title || '', mode === 'live' ? 'live' : 'vod')
            .then(r => {
              if (embedCancelled) return
              if (r?.status !== 'playing') openWebViewPlayback()
            })
            .catch(() => {
              if (!embedCancelled) openWebViewPlayback()
            })
        }

        // Estados nativos durante el flujo de embed: el play() posterior a la
        // resolución y el openPlayer interno del resolver emiten aquí.
        const onEmbedState = (state) => {
          if (embedCancelled || !state) return
          if (state.state === 'ready' || state.state === 'embed_webview_playing') {
            setResolvingEmbed(false)
            setPlayerOpen(true)
            return
          }
          if (state.state === 'error') {
            // URL resuelta que el CDN rechaza fuera del WebView (403/404) →
            // primero relay local a ExoPlayer; si el relay tampoco puede,
            // reproducir dentro del propio WebView del embed.
            if (!webPlaybackTried) {
              stopPlayback().catch(() => {})
              if (!relayTried && relayCtx?.referer) {
                console.log('[Player] Embed-resolved URL failed (code ' + (state.errorCode ?? '?') + ') — relay to ExoPlayer')
                openRelayPlayback(relayCtx)
              } else {
                console.log('[Player] Embed-resolved URL failed (code ' + (state.errorCode ?? '?') + ') — playing inside WebView')
                openWebViewPlayback()
              }
            } else {
              setResolvingEmbed(false)
            }
            return
          }
          if (state.state === 'closed') {
            // Tras el fallback a WebView el 'closed' de ExoPlayer es espurio —
            // el diálogo del embed se gestiona con su propio resultado.
            if (webPlaybackTried) return
            if (Date.now() - lastPlayAt < 1000) return // closed espurio post-open
            if (!closedRef.current) {
              closedRef.current = true
              markPlayerClosed()
              onClose?.()
            }
          }
        }
        // El resolver visible abre ExoPlayer desde nativo (sin playStream) —
        // el listener debe estar puesto antes de que lleguen sus estados.
        setPlaybackStateListener(onEmbedState)

        // Embeds con CDN bloqueado a no-Chromium (DLive/tiestep): la URL
        // extraída da 403 en ExoPlayer directo — ir directo al relay local
        // (ExoPlayer + WebView-origin fetch) y solo si falla, al WebView.
        if (stream._wvPlayback) {
          queueMicrotask(() => { if (!embedCancelled) setResolvingEmbed(true) })
          resolveEmbed(stream.url, 15000, embedReferer).then(res => {
            if (embedCancelled) return
            if (res?.status === 'resolved' && res.url && res.referer) {
              relayCtx = { url: res.url, referer: res.referer }
              openRelayPlayback(relayCtx)
            } else {
              openWebViewPlayback()
            }
          }).catch(() => { if (!embedCancelled) openWebViewPlayback() })
          return () => { embedCancelled = true; setPlaybackStateListener(null); setPlayerOpen(false); stopPlayback().catch(() => {}) }
        }

        const openVisibleEmbed = () => {
          return playEmbed(stream.url, title || '', embedReferer, false, embedWaitUntil).then(result => {
          if (embedCancelled) return
          setResolvingEmbed(false)
          if (result && result.status === 'resolved') {
            // Video URL was found and ExoPlayer started automatically
            console.log('[Player] Embed resolved to ExoPlayer:', urlHost(result.url || ''))
            setPlayerOpen(true)
          } else {
            // User closed the WebView without resolving, timeout, or error
            const msg = result?.status === 'timeout' ? 'Tiempo de espera agotado'
              : result?.status === 'error' ? 'Error: ' + (result.message || 'desconocido')
              : result?.status === 'deleted' ? 'El archivo ya no está disponible'
              : 'Cerrado sin resolver'
            console.log('[Player] Embed closed:', result?.status, msg)
            setError(msg)
            if (!closedRef.current) { closedRef.current = true; onClose?.() }
          }
          }).catch(e => {
            if (embedCancelled) return
            console.warn('[Player] playEmbed failed:', e?.message)
            setResolvingEmbed(false)
            setLoading(false)
            setError('No se pudo abrir el embed')
          })
        }

        // Intento invisible primero: corre el challenge JS/captcha en un WebView
        // oculto y captura la URL directa. Solo si falla abrimos el WebView visible.
        queueMicrotask(() => { if (!embedCancelled) setResolvingEmbed(true) })
        resolveEmbed(stream.url, 15000, embedReferer).then(res => {
          if (embedCancelled) return
          if (res?.status === 'resolved' && res.url) {
            console.log('[Player] Headless embed resolved:', urlHost(res.url))
            // Los headers originales de la petición del player (UA, Referer,
            // Origin, Cookie) los exige el CDN firmado — se aplican primero.
            const headers = { ...(res.requestHeaders || {}), ...(stream.headers || {}) }
            if (res.referer && !headers.Referer) headers.Referer = res.referer
            if (res.cookies && !headers.Cookie) headers.Cookie = res.cookies
            relayCtx = { url: res.url, referer: res.referer || '' }
            // Keep resolvingEmbed until the native player takes over so the
            // branded loader never drops to a black gap.
            lastPlayAt = Date.now()
            playStream({
              url: res.url,
              streamType: res.streamType || 'hls',
              title: title || '',
              headers,
              mode: mode === 'live' ? 'live' : 'vod',
            }, onEmbedState).then(() => setResolvingEmbed(false)).catch(e => {
              console.warn('[Player] playStream after headless resolve failed:', e?.message)
              openVisibleEmbed()
            })
          } else {
            console.log('[Player] Headless resolve', res?.status, '→ visible WebView')
            openVisibleEmbed()
          }
        }).catch(() => openVisibleEmbed())
        return () => { embedCancelled = true; setPlaybackStateListener(null); setPlayerOpen(false); stopPlayback().catch(() => {}) }
      }

      // Electron: la cadena embed vive en el wrapper (resolver → relay →
      // ventana). Si aun así llega un embed sin resolver, último recurso:
      // ventana visible con el player del proveedor (equivalente del
      // WebView playback de Android).
      if (isElectron() && window.octostream?.embed?.play) {
        let embedCancelled = false
        queueMicrotask(() => {
          if (embedCancelled) return
          setLoading(false)
          setResolvingEmbed(true)
        })
        const embedReferer = stream.referer || stream.headers?.Referer || ''
        const kickoff = stream._fctvItem?._matchDate || 0
        const embedWaitUntil = kickoff > Date.now() ? kickoff + 90 * 60 * 1000 : 0
        playEmbed(stream.url, title || '', embedReferer, true, embedWaitUntil).then(result => {
          if (embedCancelled) return
          setResolvingEmbed(false)
          if (result?.status === 'closed' || result?.status === 'stopped') {
            if (!closedRef.current) { closedRef.current = true; markPlayerClosed(); onClose?.() }
            return
          }
          setError('El vídeo no se pudo cargar')
        }).catch(e => {
          if (embedCancelled) return
          setResolvingEmbed(false)
          setError(e?.message || 'No se pudo abrir el embed')
        })
        return () => { embedCancelled = true; setPlayerOpen(false) }
      }

      // Web sin app: el iframe del proveedor (no es player interno — es la
      // página remota embebida). loading hasta el onLoad del iframe.
      queueMicrotask(() => setWebEmbed(true))
      return
    }

    let cancelled = false

    const init = async () => {

    // Re-resolver una URL fresca cuando el token firmado caduca:
    // embed → resolver JS sobre originalUrl; deportes → getStreams del item
    // origen (_fctvItem lleva _noCache, así que devuelve tokens nuevos).
    const resolveFreshStreamUrl = async () => {
      // YouTube: URL firmada de googlevideo caducada (o servida desde la
      // caché de resoluciones) → forzar re-resolución con NewPipe.
      if (stream._refreshUrl) {
        try {
          const u = await stream._refreshUrl()
          if (u && u !== stream.url && /^https?:/i.test(u)) return sanitizeUrl(u)
        } catch { /* noop */ }
        return null
      }
      // Debrid: la URL firmada de AllDebrid caduca/4xx — re-desbloquear el
      // enlace de host original (1fichier…) para obtener una URL fresca.
      if (stream.originalDebridUrl) {
        try {
          const r = await adUnlockLink(stream.originalDebridUrl)
          const u = r?.link
          if (u && u !== stream.url) return sanitizeUrl(u)
        } catch { /* noop */ }
        return null
      }
      if (stream.originalUrl) {
        const u = await Promise.race([
          resolveEmbedJs(stream.originalUrl),
          new Promise((_, r) => setTimeout(() => r(new Error('resolve timeout')), 25000)),
        ])
        if (u && u !== stream.url && u !== stream.originalUrl) return sanitizeUrl(u)
        return null
      }
      const src = stream._fctvItem
      if (src?.type && src?.id) {
        const list = await pluginManager.getStreams(src.type, src.id, src.name)
        const direct = (list || []).filter(s => s.streamType !== 'embed' && /^https?:/i.test(s.url || ''))
        const pick = direct.find(s => s.name === stream.name && s.url !== stream.url) || direct.find(s => s.url !== stream.url)
        if (pick) return sanitizeUrl(pick.url)
      }
      return null
    }

    // Arranque del motor P2P compartido: jlibtorrent (plugin Android) o
    // WebTorrent en el main de Electron — misma superficie vía fachada.
    const startTorrentEngine = async () => {
      setTorrentProgress({ state: 'metadata', progress: 0, peers: 0 })
      const TorrentEngine = await getTorrentEngine()
      if (!TorrentEngine) throw new Error('Motor torrent no disponible')
      torrentListenerRef.current = await TorrentEngine.addListener('torrentProgress', ev => {
        if (!cancelled) setTorrentProgress(ev)
        // El overlay de carga cubre el vídeo — progreso en vivo.
        setLoadingText(torrentStatusText(ev))
        // Watchdog: 0 peers sostenidos con descarga incompleta = torrent
        // muerto — se avisa y se cierra para elegir otro enlace.
        if (cancelled || !ev) return
        if (ev.peers === 0 && (ev.progress || 0) < 1 && playerStalledRef.current) {
          if (!noPeersSinceRef.current) {
            noPeersSinceRef.current = Date.now()
          } else if (Date.now() - noPeersSinceRef.current > 75000) {
            noPeersSinceRef.current = 0
            console.warn('[Player] torrent sin peers durante 75s — abortando')
            setLoadingText('Sin fuentes (0 peers) — cerrando…')
            setTimeout(() => {
              stopTorrentEngine()
              stopPlayback().catch(() => {})
              setPlayerOpen(false)
            }, 2500)
          }
        } else {
          noPeersSinceRef.current = 0
        }
      })
      const res = await TorrentEngine.start({
        url: stream.url,
        season: meta?.season ?? undefined,
        episode: meta?.episode ?? undefined,
        title: title || '',
      })
      if (cancelled) return null
      torrentActiveRef.current = true
      return res
    }

    // Reproductores nativos únicamente: ExoPlayer en Android, mpv por IPC en
    // Linux/Windows (sin player web interno). DRM Widevine solo lo cubre
    // ExoPlayer — en escritorio no hay CDM.
    const hasDrm = !!stream.drm?.licenseUrl || stream.drm?.type === 'widevine'
    const android = isExoPlayerAvailable()
    const desktopNative = !android && isElectron() && !hasDrm &&
      await isDesktopPlayerAvailable()
    if (!android && !desktopNative) {
      setPlayerOpen(false)
      setLoading(false)
      setError(hasDrm
        ? 'Este stream lleva DRM Widevine — solo disponible en la app de Android'
        : isElectron()
          ? 'Reproductor mpv no encontrado'
          : 'La reproducción requiere la app (Android o escritorio)')
      return
    }

    {
      const kind = android ? 'exo' : 'mpv'
      setNativeKind(kind)
      nativeKindRef.current = kind
      // Reducir memoria del WebView en Android: quitar video/canvas/source
      // del DOM antes de abrir ExoPlayer (el player nativo se muestra sobre
      // el WebView). En Electron-mpv la app queda visible — no tocar el DOM.
      if (android) {
        try {
          document.querySelectorAll('video, canvas, source').forEach(el => {
            el.src = ''
            el.srcset = ''
          })
          const root = document.getElementById('root')
          if (root) root.style.display = 'none'
        } catch { /* noop */ }
      }
      if (window.gc) { try { window.gc() } catch { /* noop */ } }

      // La app queda oculta (root display:none) mientras ExoPlayer está al
      // frente. Cualquier fallo después de ocultarla dejaba el error
      // renderizado en un DOM invisible → pantalla negra permanente.
      const restoreAppDom = () => {
        try {
          const root = document.getElementById('root')
          if (root) root.style.display = ''
        } catch { /* noop */ }
      }

      let streamUrl = sanitizeUrl(stream.url)
      if (!streamUrl) {
        restoreAppDom()
        setPlayerOpen(false)
        setError('URL del stream no válida')
        setLoading(false)
        return
      }

      // Torrent P2P: el motor descarga el archivo y lo sirve por un endpoint
      // HTTP local que el player nativo lee con Range requests.
      const isTorrent = stream.streamType === 'torrent'
      if (isTorrent) {
        try {
          const res = await startTorrentEngine()
          if (!res) return
          streamUrl = res.url
        } catch (e) {
          if (cancelled) return
          console.warn('[Player] torrent engine failed:', e?.message)
          setTorrentProgress(null)
          restoreAppDom()
          setPlayerOpen(false)
          setError(e?.message || 'No se pudo iniciar el motor torrent')
          setLoading(false)
          return
        }
      }

      // Solo host — la URL completa puede llevar tokens firmados (debrid, CDNs).
      console.log('[Player] Using native player for', stream.streamType, urlHost(streamUrl))
      console.log('[Player] Headers:', Object.keys(stream.headers || {}).join(', ') || 'none')
      console.log('[Player] closedRef at playStream time:', closedRef.current)
      setLoading(false) // el nativo muestra su propio indicador de carga

      const rawLicenseUrl = stream.drm?.type === 'widevine' ? stream.drm.licenseUrl : null
      const licenseUrl = rawLicenseUrl ? sanitizeUrl(rawLicenseUrl) : null
      const drmHeaders = stream.drm?.headers || {}
      if (licenseUrl) {
        console.log('[Player] ExoPlayer DASH with Widevine')
        console.log('[Player] ExoPlayer DRM headers:', Object.keys(drmHeaders).join(', '))
      }

      // LiveTV a veces no tiene el EPG en meta (por ejemplo Continue Watching),
      // pero sí lo tiene en el catálogo de canales. Usar ambos orígenes evita
      // que el OSD solo muestre "DIRECTO".
      // U7D se reproduce con mode='vod' (es contenido grabado): respetar el modo
      // explícito por encima del type del meta para no mostrar la UI de TV.
      const isLive = mode === 'live' || (mode !== 'vod' && (meta?.type === 'live' || meta?.type === 'channel'))
      // channelIndex puede ser -1 si el canal no se encontró por id (rutas
      // distintas usan ids distintos) — fallback por nombre exacto y luego
      // por nombre normalizado (case-insensitive, sin espacios extra).
      const resolvedChannelIndex = isLive && channels?.length
        ? (channelIndex >= 0 ? channelIndex
            : (() => {
                const exact = channels.findIndex(c => (c.name || c.title) === (meta?.name || title))
                if (exact >= 0) return exact
                const mn = (meta?.name || title || '').toLowerCase().trim()
                if (!mn) return -1
                return channels.findIndex(c => (c.name || c.title || '').toLowerCase().trim() === mn)
              })())
        : -1
      const currentChannel = isLive && resolvedChannelIndex >= 0 ? channels[resolvedChannelIndex] : null
      const currentNow = meta?.epgNow || currentChannel?.nowPlaying || currentChannel?.now || ''
      const currentNext = meta?.epgNext || currentChannel?.nextPlaying || currentChannel?.next || ''
      const currentStart = meta?.epgStart || currentChannel?.nowPlayingStart || currentChannel?.start || 0
      const currentEnd = meta?.epgEnd || currentChannel?.nowPlayingEnd || currentChannel?.end || 0
      if (cancelled) return
      const playArgs = {
        url: streamUrl,
        // El tipo se deduce de la URL FINAL (post-debrid/post-resolver):
        // el streamType del proveedor puede quedar obsoleto — un .mkv
        // desbloqueado llegaba como 'hls' y ExoPlayer daba 3002.
        streamType: isTorrent ? 'mp4' : inferStreamType(streamUrl, stream.streamType || 'hls'),
        // Los torrents van por el servidor local (127.0.0.1) — nunca por WARP —
        // y toleran stalls largos mientras llegan las piezas.
        direct: stream.direct === true || isTorrent,
        // TDT sale por la red física; debrid queda en el túnel
        // (el unlock ligó el link a la IP de Riseup).
        bypassVpn: stream.bypassVpn === true,
        longBuffering: isTorrent,
        // CDNs rápidos y adaptativos (YouTube/googlevideo): menos buffer
        // inicial → primer frame antes. El ABR de ExoPlayer cubre el resto.
        fastStart: stream.fastStart === true,
        loadingText: isTorrent ? 'Descargando torrent…' : undefined,
        licenseUrl,
        headers: stream.headers || {},
        drmHeaders,
        title: title || '',
        startTime: startTime || 0,
        channels: isLive && channels?.length > 1
          ? channels.map(c => ({
            name: c.name || c.title || '',
            now: c.nowPlaying || c.now || '',
            next: c.nextPlaying || c.next || '',
            start: c.nowPlayingStart || c.start || 0,
            end: c.nowPlayingEnd || c.end || 0,
            logo: c.logo || c.poster || '',
          }))
          : null,
        channelIndex: resolvedChannelIndex,
        epgNow: currentNow || null,
        epgNext: currentNext || null,
        epgStart: currentStart || 0,
        epgEnd: currentEnd || 0,
        // Logo del canal actual: fallback para cuando no hay lista de canales
        // (historial, favoritos, reproducción directa en móvil)
        logo: currentChannel?.logo || currentChannel?.poster || meta?.poster || '',
        onZap: onZapChannel,
        mode,
        // IMDB + temporada/episodio para el botón "Buscar en OpenSubtitles"
        // del menú de subtítulos nativo (addon Stremio, sin API key).
        imdbId: meta?.imdbId || '',
        season: meta?.season ?? 0,
        episode: meta?.episode ?? 0,
        // Subtítulos del propio proveedor (YouTube: TTML/VTT side-loaded,
        // salen en el menú de subtítulos del player nativo)
        subtitles: stream.subtitles || null,
        // Series: panel lateral de episodios de la temporada (zap de episodios)
        episodes: episodes?.length
          ? episodes.map(e => ({
            name: e.name || `Episodio ${e.episode}`,
            season: e.season ?? 1,
            episode: e.episode ?? 0,
            watched: !!e.watched,
          }))
          : null,
        episodeIndex: episodes?.length && meta?.season != null
          ? episodes.findIndex(e => e.season === meta.season && e.episode === meta.episode)
          : -1,
        // Catálogo de temporadas para los chips del panel (T1/T2…) — solo
        // números >0; el especial T0 queda fuera igual que en la ficha.
        seasons: meta?.seasonsList?.length
          ? meta.seasonsList.map(s => s.seasonNumber).filter(n => n > 0)
          : null,
        onEpisodeSelect: (ev) => {
          // El panel puede estar mostrando otra temporada — buscar el ep por
          // índice en la lista QUE EL PANEL tiene, no en la prop episodes.
          const panel = panelEpsRef.current
          const list = panel?.season === ev.season ? panel.eps : null
          const ep = list?.[ev.index]
            || { season: ev.season, episode: ev.episode, name: ev.name || `Episodio ${ev.episode}` }
          if (onPlayEpisodeRef.current) onPlayEpisodeRef.current(ep)
        },
        onSeasonSelect: async (ev) => {
          const loader = onLoadSeasonRef.current
          if (!loader || !ev?.season) return
          try {
            const eps = await loader(ev.season)
            if (!eps?.length || closedRef.current) return
            panelEpsRef.current = { season: ev.season, eps }
            // ¿Contiene el episodio que suena? (volver a la temporada actual)
            const idx = eps.findIndex(e => e.season === meta?.season && e.episode === meta?.episode)
            setEpisodes({
              season: ev.season,
              episodeIndex: idx,
              episodes: eps.map(e => ({
                name: e.name || `Episodio ${e.episode}`,
                season: e.season ?? ev.season,
                episode: e.episode ?? 0,
                watched: !!e.watched,
              })),
            })
          } catch (e) {
            console.warn('[Player] season load failed:', e?.message)
          }
        },
      }
      const onPlaybackState = (state) => {
        // El watchdog de 0-peers solo actúa cuando el player espera datos.
        // 'position' llega cada 5s incluso durante un stall — no tocarlo.
        if (state.state === 'buffering' || state.state === 'idle') playerStalledRef.current = true
        else if (state.state === 'ready' || state.state === 'ended' || state.state === 'error') playerStalledRef.current = false
        if (state.state === 'playing') setPlaying(true)
        else if (state.state === 'paused' || state.state === 'ended') setPlaying(false)
        if (state.state === 'error') {
          // Sin fallback a reproductor web: el nativo cubre todos los tipos
          // y un segundo player con otra UI confunde.
          const msg = state.message || ''
          const isHttpError = /403|forbidden|source error|bad http|io.*http/i.test(msg)
            || state.errorCode === 2000 // ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
            || state.errorCode === 2001 // ERROR_CODE_IO_BAD_HTTP_STATUS
            || state.errorCode === 2003 // ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
            || state.errorCode === 2004 // ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
            || state.errorCode === -1 // buffering timeout agotado
          if (isHttpError && (stream.originalUrl || stream._fctvItem || stream._refreshUrl || stream.originalDebridUrl) && !reResolveRef.current) {
            // URL firmada caducada (los CDN devuelven 4xx al refrescar el
            // manifest tras minutos de reproducción): re-resolver y
            // reintentar en el nativo una sola vez.
            reResolveRef.current = true
            console.log('[Player] HTTP error — re-resolving fresh URL:', urlHost(stream.originalUrl || stream.url), 'code:', state.errorCode)
            setError(null)
            setResolvingEmbed(true)
            resolveFreshStreamUrl().then(fresh => {
              if (cancelled || closedRef.current) return
              setResolvingEmbed(false)
              if (fresh) {
                console.log('[Player] Re-resolved URL, retrying:', urlHost(fresh))
                playArgs.url = fresh
                playArgs.streamType = inferStreamType(fresh, playArgs.streamType)
                playStream(playArgs, onPlaybackState).catch(e => {
                  console.warn('[Player] retry after re-resolve failed:', e?.message)
                  if (!cancelled && !closedRef.current) {
                    restoreAppDom()
                    setPlayerOpen(false)
                    setError(`No se pudo reproducir el stream: ${e?.message || 'error desconocido'}`)
                    stopPlayback().catch(() => {})
                  }
                })
              } else {
                console.log('[Player] Re-resolve gave no new URL')
                restoreAppDom()
                setPlayerOpen(false)
                setError('No se pudo renovar el enlace — prueba con otro')
                stopPlayback().catch(() => {})
              }
            }).catch(e => {
              console.warn('[Player] Re-resolve failed:', e?.message)
              if (cancelled || closedRef.current) return
              setResolvingEmbed(false)
              restoreAppDom()
              setPlayerOpen(false)
              setError(`No se pudo renovar el enlace: ${e?.message || 'error'}`)
              stopPlayback().catch(() => {})
            })
            return
          }
          console.log('[Player] native player error:', msg, 'code:', state.errorCode)
          // El diálogo nativo puede seguir abierto con el player muerto
          // encima del error — cerrar para que se vea.
          restoreAppDom()
          setPlayerOpen(false)
          setError(`No se pudo reproducir: ${msg || 'error desconocido'}`)
          stopPlayback().catch(() => {})
        } else if (state.state === 'ended') {
          // Episode finished - save final progress as 100% so the tick appears
          saveFinalProgress()
          // Mark as ended so the 'closed' event from openPlayer's closePlayer
          // doesn't unmount the VideoPlayer during episode transition
          endedRef.current = true
          // El episodio terminó — parar y borrar el torrent actual aunque el
          // siguiente sea otro stream (start() re-inicia el motor si toca).
          stopTorrentEngine()
          console.log('[Player] Playback ended, calling onEnded')
          if (onEnded) onEnded()
          else if (!closedRef.current) { closedRef.current = true; onClose?.() }
        } else if (state.state === 'closed') {
          // Guard against duplicate 'closed' events: the native player sends
          // 'closed' when the user presses Back, and the cleanup also calls
          // stopPlayback() which triggers another 'closed'. Only call onClose
          // once to prevent reopening the channel or double navigation.
          // Also ignore 'closed' if we already received 'ended' — that means
          // the episode finished and the next is being loaded.
          console.log('[Player] closed event received, closedRef=', closedRef.current, 'endedReceived=', endedRef.current)
          setMpvEmb(false)
          if (pipRef.current) { mpvPip(false)?.catch?.(() => {}); pipRef.current = false }
          if (!closedRef.current && !endedRef.current) {
            const sinceOpen = Date.now() - openedAtRef.current
            if (sinceOpen < 1000) {
              console.log('[Player] ignoring spurious closed event', sinceOpen, 'ms after open')
              return
            }
            closedRef.current = true
            // Persistir la posición final al cerrar — el throttle de 30s
            // podría descartar el último tramo de progreso.
            if (currentTimeRef.current > 0) {
              const m = currentMetaRef.current || meta
              if (m?.type !== 'live' && m?.type !== 'channel') {
                updateProgress(m.id, m.type, currentTimeRef.current, durationRef.current || 0,
                  m.season != null ? { season: m.season, episode: m.episode, name: m.episodeName || '' } : null, true)
              }
            }
            // Registrar el timestamp del cierre del player nativo para que
            // App.jsx ignore el backButton "leaked" que llega justo después.
            markPlayerClosed()
            // Cierre del player → parar el motor P2P y borrar el torrent ya,
            // sin esperar al desmontaje del componente.
            stopTorrentEngine()
            console.log('[Player] calling onClose from closed event')
            onClose?.()
          }
        } else if (state.state === 'osc') {
          // Acciones del OSC embebido (estilo controles Android).
          handleOscAction(state.action, state.arg, playArgs)
        } else if (state.state === 'ready') {
          setLoading(false)
          setMpvEmb(isMpvEmbedded())
          // Estado inicial del OSC: título, EPG del canal, botones visibles.
          const ch = playArgs.channels?.[playArgs.channelIndex]
          mpvOscState({
            title: playArgs.title || '',
            live: isLive,
            chan: ch?.name || meta?.name || '',
            epgNow: playArgs.epgNow || '',
            epgNext: playArgs.epgNext || '',
            epgStart: playArgs.epgStart || 0,
            epgEnd: playArgs.epgEnd || 0,
            canZap: !!(playArgs.channels?.length > 1),
            hasImdb: !!playArgs.imdbId,
            hasEps: !!(playArgs.episodes?.length > 1),
            hasNext: !!nextEpisode,
          })
        } else if (state.state === 'position' && meta) {
          // Position update - save progress
          const pos = state.position / 1000 // ms → seconds
          const dur = state.duration / 1000
          // Use currentMetaRef (locked to the playing stream) to avoid saving
          // progress for the NEXT episode when onPlayNext changes meta early.
          const m = currentMetaRef.current || meta
          if (pos > 0 && m.type !== 'live' && m.type !== 'channel') {
            updateProgress(m.id, m.type, pos, dur, m.season != null ? {
              season: m.season, episode: m.episode, name: m.episodeName || '',
            } : null)
          }
          currentTimeRef.current = pos
          if (dur > 0) durationRef.current = dur
        }
      }
      playStream(playArgs, onPlaybackState).catch(e => {
        console.error('[Player] native player error:', e?.message)
        restoreAppDom()
        setPlayerOpen(false)
        setError(`Error al iniciar el reproductor: ${e?.message || 'unknown'}`)
      })

      // Cleanup: parar el nativo y restaurar el DOM del WebView en Android.
      // Delay setPlayerOpen(false) so the Android back button that closed
      // ExoPlayer doesn't also trigger navigate(-1) in App.jsx.
      exoCleanupRef.current = () => {
        console.log('[Player] native cleanup running, closedRef=', closedRef.current)
        playerOpenTimerRef.current = setTimeout(() => {
          playerOpenTimerRef.current = null
          setPlayerOpen(false)
        }, 300)
        try {
          const root = document.getElementById('root')
          if (root) root.style.display = ''
        } catch { /* noop */ }
        stopPlayback().catch(() => {})
      }
    }
    } // end of init()

    init().catch(e => {
      console.error('[Player] init error:', e?.message || e)
      if (!cancelled) {
        setError(`Error al iniciar reproducción: ${e?.message || 'unknown'}`)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      console.log('[Player] useEffect cleanup running, closedRef=', closedRef.current, 'hasExoCleanup=', !!exoCleanupRef.current)
      // Stop the P2P engine if a torrent was playing (fire and forget).
      stopTorrentEngine()
      if (typeof exoCleanupRef.current === 'function') {
        try { exoCleanupRef.current() } catch (e) { console.warn('[Player] cleanup error:', e?.message) }
        exoCleanupRef.current = null
        // El cleanup nativo ya restauró root display y programó
        // setPlayerOpen(false) — no ejecutar el setPlayerOpen(false)
        // inmediato de abajo (anularía el retardo anti-Back-leak).
        return
      }
      setPlayerOpen(false)
      try {
        const root = document.getElementById('root')
        if (root) root.style.display = ''
      } catch { /* noop */ }
      try {
        if (typeof cleanupRef.current === 'function') cleanupRef.current()
      } catch (e) { console.warn('[Player] cleanup error:', e?.message) }
      cleanupRef.current = null
    }
  }, [stream, mode])

  // Empujar la lista de canales al player nativo cuando llegue tarde (la ruta
  // Details carga el catálogo en background) o cuando el EPG se refresque.
  // Sin reabrir el player — el nativo solo actualiza su lista/OSD.
  useEffect(() => {
    console.log('[Player] setChannels effect running, closedRef=', closedRef.current, 'channels=', channels?.length, 'meta.type=', meta?.type)
    if (closedRef.current) return
    if ((meta?.type !== 'live' && meta?.type !== 'channel') || !channels?.length) return
    const resolvedIdx = channelIndex >= 0 ? channelIndex
      : channels.findIndex(c => (c.name || c.title) === (meta?.name || title))
        || channels.findIndex(c => {
          const cn = (c.name || c.title || '').toLowerCase().trim()
          const mn = (meta?.name || title || '').toLowerCase().trim()
          return cn && mn && cn === mn
        })
    setChannels({
      channels: channels.map(c => ({
        name: c.name || c.title || '',
        now: c.nowPlaying || c.now || '',
        next: c.nextPlaying || c.next || '',
        start: c.nowPlayingStart || c.start || 0,
        end: c.nowPlayingEnd || c.end || 0,
        logo: c.logo || c.poster || '',
      })),
      channelIndex: resolvedIdx,
    }).catch(() => {})
    // Re-empujar estado al OSC embebido cuando la lista llega tarde: el push
    // inicial (en 'ready') sale con canZap=false y EPG vacío. El mensaje es
    // un merge parcial — solo se actualizan los campos enviados.
    if (isMpvEmbedded()) {
      const ch = resolvedIdx >= 0 ? channels[resolvedIdx] : null
      mpvOscState({
        chan: ch?.name || ch?.title || meta?.name || '',
        epgNow: meta?.epgNow || ch?.nowPlaying || ch?.now || '',
        epgNext: meta?.epgNext || ch?.nextPlaying || ch?.next || '',
        epgStart: meta?.epgStart || ch?.nowPlayingStart || ch?.start || 0,
        epgEnd: meta?.epgEnd || ch?.nowPlayingEnd || ch?.end || 0,
        canZap: channels.length > 1,
      })
    }
  }, [channels, channelIndex, meta?.type, meta?.name, meta?.epgNow, meta?.epgNext, meta?.epgStart, meta?.epgEnd, title])

  // Empujar la lista de episodios al player nativo si llega/cambia después de
  // empezar la reproducción (mismo patrón que setChannels). `season` mantiene
  // el chip correcto si el usuario estaba navegando otra temporada del panel.
  useEffect(() => {
    if (closedRef.current || !episodes?.length) return
    setEpisodes({
      season: meta?.season ?? 0,
      episodes: episodes.map(e => ({
        name: e.name || `Episodio ${e.episode}`,
        season: e.season ?? 1,
        episode: e.episode ?? 0,
        watched: !!e.watched,
      })),
      episodeIndex: meta?.season != null
        ? episodes.findIndex(e => e.season === meta.season && e.episode === meta.episode)
        : -1,
    }).catch(() => {})
  }, [episodes, meta?.season, meta?.episode])

  // Push next episode info to native ExoPlayer so it can show the popup
  // natively (la UI web no se renderiza con el nativo activo).
  useEffect(() => {
    if (!isExoPlayerAvailable()) return
    const autoNextEpEnabled = localStorage.getItem('octostream_auto_next_ep') !== 'false'
    if (nextEpisode && autoNextEpEnabled) {
      const autoplayEnabled = localStorage.getItem('octostream_autoplay') !== 'false'
      setNextEpisode({
        title: nextEpisode.name || `Episodio ${nextEpisode.episode}`,
        seriesName: title?.split(' - ')[0] || meta?.name || '',
        season: nextEpisode.season || 1,
        episode: nextEpisode.episode || 1,
        poster: nextEpisode.poster || '',
        autoPlay: autoplayEnabled,
      })
    } else {
      setNextEpisode({ title: '', seriesName: '', season: 0, episode: 0, poster: '', autoPlay: false })
    }
  }, [nextEpisode, title, meta?.name])

  // Handle native 'nextEpisode' event (from the native popup countdown)
  useEffect(() => {
    if (!isExoPlayerAvailable()) return
    let listener
    let cancelled = false
    ExoPlayer.addListener('playbackState', (state) => {
      if (!cancelled && state.state === 'nextEpisode') {
        // The current episode is ~95% through when the popup fires — mark it
        // watched (currentMetaRef still holds THIS episode's meta).
        saveFinalProgress()
        // Parar y borrar el torrent del episodio actual antes de resolver el siguiente.
        stopTorrentEngine()
        if (onPlayNext) onPlayNext()
      }
    }).then(l => {
      if (cancelled) l.remove()
      else listener = l
    })
    return () => {
      cancelled = true
      if (listener && listener.remove) listener.remove()
    }
  }, [onPlayNext])

  // En escritorio el player va a ventana completa (como el diálogo nativo de
  // Android): al abrir, la ventana Electron va fullscreen; al cerrar, vuelve.
  // Con embeds no aplica — el proveedor se reproduce en su propia ventana.
  useEffect(() => {
    const embed = stream?.streamType === 'embed' || stream?.streamType === 'iframe'
    if (!window.octostream?.setFullscreen || embed || webEmbed) return undefined
    window.octostream.setFullscreen(true).catch?.(() => {})
    return () => { window.octostream.setFullscreen(false).catch?.(() => {}) }
  }, [webEmbed, stream?.streamType])

  // Atajos de teclado para cuando la ventana de la app tiene el foco (mpv es
  // una ventana aparte con sus propios atajos; aquí Esc cierra, PgUp/PgDn
  // zapea y espacio/flechas controlan por IPC).
  const zapByRef = useRef(null)
  useEffect(() => {
    zapByRef.current = (dir) => {
      if (!channels?.length) return
      const n = channels.length
      const next = (((channelIndex < 0 ? 0 : channelIndex) + dir) % n + n) % n
      onZapChannel?.({ index: next, name: channels[next]?.name })
    }
  }, [channels, channelIndex, onZapChannel])

  useEffect(() => {
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      switch (e.key) {
        case 'Escape':
        case 'Back':
        case 'NavigationBack':
          e.preventDefault()
          onClose?.()
          break
        case 'PageUp':
        case 'PageDown':
          if (mode === 'live' && channels?.length > 1 && onZapChannel) {
            e.preventDefault()
            zapByRef.current?.(e.key === 'PageUp' ? 1 : -1)
          }
          break
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          if (nativeKindRef.current) {
            e.preventDefault()
            if (playing) pausePlayback().catch(() => {})
            else resumePlayback().catch(() => {})
          }
          break
        case 'ArrowLeft':
        case 'MediaRewind':
          if (nativeKindRef.current && currentTimeRef.current > 0) {
            e.preventDefault()
            seekTo(Math.max(0, currentTimeRef.current - 10)).catch(() => {})
          }
          break
        case 'ArrowRight':
        case 'MediaFastForward':
          if (nativeKindRef.current && currentTimeRef.current > 0) {
            e.preventDefault()
            seekTo(currentTimeRef.current + 10).catch(() => {})
          }
          break
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [playing, mode, channels, onZapChannel, onClose])

  const openInExternal = async (player) => {
    if (!stream) return
    const safeStreamUrl = sanitizeUrl(stream.url)
    if (!safeStreamUrl) {
      setError('URL del stream no válida')
      return
    }
    // En escritorio los esquemas vlc:///mpv:// no existen: el proceso
    // principal lanza el binario real.
    if (window.octostream?.isElectron && window.octostream?.openExternalPlayer) {
      if (player === 'system') {
        window.open(safeStreamUrl, '_blank', 'noopener,noreferrer')
        return
      }
      try {
        const r = await window.octostream.openExternalPlayer({
          player,
          url: safeStreamUrl,
          headers: stream.headers || {},
          title: title || '',
        })
        if (!r?.ok) setError(r?.error || `No se pudo abrir ${player}`)
      } catch (e) {
        setError(`No se pudo abrir ${player}: ${e?.message || 'error'}`)
      }
      return
    }
    let url = safeStreamUrl
    if (player === 'vlc') {
      url = `vlc://${safeStreamUrl}`
    } else if (player === 'mpv') {
      url = `mpv://${safeStreamUrl}`
    }
    const safeUrl = sanitizeUrl(url)
    if (!safeUrl) {
      setError('URL no válida para reproductor externo')
      return
    }
    window.open(safeUrl, '_blank', 'noopener,noreferrer')
  }

  const initCast = () => {
    return new Promise((resolve) => {
      if (window.chrome && window.chrome.cast && window.chrome.cast.isAvailable) {
        resolve(window.chrome.cast)
        return
      }
      window['__onGCastApiAvailable'] = (isAvailable) => {
        if (isAvailable) resolve(window.chrome.cast)
        else resolve(null)
      }
      if (!document.getElementById('cast-sdk')) {
        const script = document.createElement('script')
        script.id = 'cast-sdk'
        script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
        document.head.appendChild(script)
      }
      setTimeout(() => resolve(window.chrome?.cast || null), 3000)
    })
  }

  const requestCastSession = async () => {
    const currentStream = castStream || stream
    const currentTitle = castTitle || title

    const cast = await initCast()
    if (!cast) {
      setShowCastMenu(true)
      return
    }
    try {
      const context = cast.framework.CastContext.getInstance()
      context.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      })
      await context.requestSession()
      const session = context.getCurrentSession()
      if (session) {
        castSessionRef.current = session
        // For Chromecast, use LAN-accessible proxy URL so the cast device can reach it
        let castUrl = currentStream.url
        const electron = !!window.octostream?.isElectron
        if (electron && /^https?:\/\//.test(castUrl) && !castUrl.includes('127.0.0.1')) {
          try {
            const lanProxyUrl = await window.octostream.getLanProxyUrl()
            if (lanProxyUrl) {
              castUrl = lanProxyUrl + encodeURIComponent(castUrl)
              console.log('[Cast] Using LAN proxy URL for Chromecast')
            }
          } catch {
            console.warn('[Cast] Could not get LAN proxy URL, using direct URL')
          }
        }
        const mediaInfo = new window.chrome.cast.media.MediaInfo(
          castUrl,
          currentStream.streamType === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4'
        )
        mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata()
        mediaInfo.metadata.title = currentTitle
        const request = new window.chrome.cast.media.LoadRequest(mediaInfo)
        session.loadMedia(request).then(
          () => {
            setCasting(true)
            setCastDevice(session.getCastDevice().friendlyName || 'TV')
            setShowCastMenu(false)
          },
          () => {
            setError('Error al enviar a TV')
          }
        )
      }
    } catch {
      setShowCastMenu(true)
    }
  }

  const stopCasting = () => {
    if (castSessionRef.current) {
      castSessionRef.current.endSession(true)
      castSessionRef.current = null
    }
    if (remoteDevice) {
      sendStop(remoteDevice.url)
      setRemoteDevice(null)
    }
    setCasting(false)
    setCastDevice(null)
  }

  const copyStreamUrl = async () => {
    try {
      await navigator.clipboard.writeText(stream.url)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 2000)
    } catch {
      // clipboard not available
    }
  }

  const openOnTvBrowser = () => {
    const castUrl = `${window.location.origin}/#/cast?url=${encodeURIComponent(stream.url)}&title=${encodeURIComponent(title)}`
    window.open(castUrl, '_blank')
    setShowCastMenu(false)
  }

  // El botón Cast nativo reutiliza el mismo flujo Cast de la UI.
  useEffect(() => {
    if (!isAndroidNative()) return undefined
    return setCastRequestListener((event) => {
      console.info('[ExoPlayer] castRequested received', event?.title || '')
      if (event?.url) setCastStream({ url: event.url, streamType: 'hls' })
      if (event?.title) setCastTitle(event.title)
      setShowCastMenu(true)
    })
  }, [])

  const isEmbed = stream && (stream.streamType === 'embed' || stream.streamType === 'iframe')

  return (
    <div
      data-player-overlay
      className="fixed inset-0 z-50 bg-black flex items-center justify-center"
    >
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent">
        <h2 className="text-white text-lg font-medium truncate max-w-[60%]">
          {title}
          {stream?.quality && (
            <span className="ml-3 text-xs bg-primary-600 px-2 py-0.5 rounded">
              {stream.quality}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          {/* Subtítulos OpenSubtitles (addon Stremio, sin API key) — mpv.
              En Android el menú nativo de subtítulos ya lo incluye. */}
          {nativeKind === 'mpv' && meta?.imdbId && (
            <div className="relative">
              <button
                onClick={async () => {
                  if (showSubMenu) { setShowSubMenu(false); return }
                  setShowSubMenu(true)
                  setSubResults(null)
                  setSubMsg('')
                  try {
                    const r = await window.octostream?.player?.searchSubs?.({
                      imdbId: meta.imdbId,
                      season: meta.season || 0,
                      episode: meta.episode || 0,
                    })
                    const list = r?.subs || []
                    setSubResults(list)
                    if (!list.length) setSubMsg('Sin resultados')
                  } catch {
                    setSubResults([])
                    setSubMsg('Error de red')
                  }
                }}
                tabIndex={0}
                className="btn-ghost p-2 focus:bg-primary-600/30 focus:outline-none rounded-lg"
                title="Buscar subtítulos (OpenSubtitles)"
              >
                <Captions size={24} />
              </button>
              {showSubMenu && (
                <div className="absolute top-12 right-0 w-80 max-h-80 overflow-y-auto bg-dark-800 border border-dark-600 rounded-xl shadow-2xl z-30">
                  <div className="px-3 py-2 border-b border-dark-700 flex items-center justify-between">
                    <span className="text-xs text-dark-400">OpenSubtitles</span>
                    <button onClick={() => setShowSubMenu(false)} className="btn-ghost p-1" tabIndex={0}>
                      <X size={14} />
                    </button>
                  </div>
                  {subResults === null && <p className="text-dark-400 text-xs p-3">Buscando…</p>}
                  {subMsg && <p className="text-dark-400 text-xs p-3">{subMsg}</p>}
                  {(subResults || []).map((s, i) => (
                    <button
                      key={s.id || i}
                      tabIndex={0}
                      onClick={async () => {
                        setSubMsg('Aplicando…')
                        const r = await window.octostream?.player?.addSubtitle?.({
                          url: s.url, label: s.name, lang: s.lang,
                        })
                        if (r?.ok) {
                          setShowSubMenu(false)
                          window.octostream?.player?.showText?.(`Subtítulos: ${s.lang?.toUpperCase() || ''} ${s.name}`.slice(0, 80))
                        } else {
                          setSubMsg('No se pudo aplicar')
                        }
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-white hover:bg-dark-700 focus:bg-dark-700 focus:outline-none border-b border-dark-700/50"
                    >
                      <span className="text-primary-300 font-mono mr-2">{(s.lang || '?').toUpperCase()}</span>
                      <span className="break-all">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Enviar a TV / Cast */}
          <div className="relative">
            <button
              onClick={() => (casting || remoteDevice) ? stopCasting() : setShowCastMenu(m => !m)}
              tabIndex={0}
              className={`btn-ghost p-2 ${(casting || remoteDevice) ? 'text-primary-400' : ''} focus:bg-primary-600/30 focus:outline-none rounded-lg`}
              title={(casting || remoteDevice) ? `Enviando a ${castDevice || remoteDevice?.name} - Click para detener` : 'Enviar a TV'}
            >
              <CastIcon size={24} className={(casting || remoteDevice) ? 'animate-pulse' : ''} />
            </button>
            {(casting || remoteDevice) && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
            )}
          </div>

          {/* Menú de Cast */}
          {showCastMenu && (
            <CastMenu
              stream={castStream || stream}
              title={castTitle || title}
              mode={mode}
              meta={meta}
              className="absolute top-14 right-20"
              onRequestCast={() => { setShowCastMenu(false); requestCastSession() }}
              onRemoteSent={(device) => { setRemoteDevice(device); setShowCastMenu(false) }}
              onClose={() => setShowCastMenu(false)}
              copiedUrl={copiedUrl}
              onCopyUrl={copyStreamUrl}
              onOpenTvBrowser={openOnTvBrowser}
            />
          )}

          <button onClick={onClose} tabIndex={0} className="btn-ghost p-2 focus:bg-primary-600/30 focus:outline-none rounded-lg" title="Cerrar">
            <X size={24} />
          </button>
        </div>
      </div>

      {(loading || resolvingEmbed) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black gap-4">
          <LogoLoader size={80} />
          <p className="text-white text-sm text-center whitespace-pre-line px-8">
            {resolvingEmbed ? 'Resolviendo vídeo…'
              : torrentProgress
                ? torrentStatusText(torrentProgress)
                : 'Cargando enlace…'}
          </p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p className="text-red-400 text-lg text-center px-8">{error}</p>
          <button onClick={onClose} className="btn-primary">Cerrar</button>
        </div>
      )}

      {/* mpv embebido (--wid): su ventana nativa cubre la app y no recibe
          input — este div captura ratón/rueda y los reenvía por IPC al OSC
          estilo Android. Invisible (mpv pinta encima); en plataformas donde
          mpv sí recibe eventos, no estorba. */}
      {mpvEmb && nativeKind === 'mpv' && !error && (
        <div
          className="absolute inset-0 z-40"
          style={{ cursor: cursorHidden ? 'none' : 'default' }}
          onMouseMove={(e) => {
            const now = performance.now()
            if (now - mouseTsRef.current >= 20) {
              mouseTsRef.current = now
              mpvMouse(e.clientX, e.clientY)
            }
            setCursorHidden(false)
            clearTimeout(cursorTimerRef.current)
            cursorTimerRef.current = setTimeout(() => setCursorHidden(true), 2500)
          }}
          onMouseDown={(e) => {
            // Click con coordenadas (clickat): mouse+keypress por separado
            // llegaban desincronizados y el OSC hit-testeaba la posición vieja.
            if (e.button === 0) mpvClick(e.clientX, e.clientY)
            else if (e.button === 2) mpvKey('MOUSE_BTN2')
          }}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => mpvKey(e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN')}
        />
      )}

      {/* Indicador cuando la app tiene el foco con el nativo al frente.
          Con mpv embebido no se ve (mpv pinta encima) — queda para Android. */}
      {nativeKind && !mpvEmb && !loading && !error && !isEmbed && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-dark-500 text-xs">
          Reproduciendo en {nativeKind === 'mpv' ? 'mpv' : 'ExoPlayer'} — Esc para cerrar
        </div>
      )}

      {webEmbed && isEmbed && (
        <iframe
          src={sanitizeUrl(stream.url)}
          className="w-full h-full"
          onLoad={() => setLoading(false)}
          allowFullScreen
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture; gyroscope; accelerometer; media-controls; downloads"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-modals allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      )}

      {/* Controles para embed web (solo externos — no hay player interno) */}
      {webEmbed && isEmbed && !error && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent pb-4 pt-12">
          <div className="flex items-center justify-center gap-2">
            <span className="text-dark-400 text-xs mr-2">Reproducir en externo:</span>
            <button
              onClick={() => openInExternal('vlc')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors text-xs font-bold"
              title="Abrir en VLC"
            >
              VLC
            </button>
            <button
              onClick={() => openInExternal('mpv')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors text-xs font-bold"
              title="Abrir en MPV"
            >
              MPV
            </button>
            <button
              onClick={() => openInExternal('system')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Reproductor del sistema"
            >
              <ExternalLink size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Wrapper con resolución de embeds en Electron ────────────────────────────
// En Android la cadena embed → WebView oculto → relay → WebView visible vive
// dentro del flujo nativo. En Electron el equivalente corre aquí ANTES de
// montar el player: (1) resolver headless (BrowserWindow oculta + sniff de
// red) → URL directa + headers; (2) relay de origen para CDNs ligados al
// documento (DLive/tiestep) → URL loopback /embed-relay; (3) para embeds con
// «sandbox check», el player embebido en ventana propia; (4) resolución
// interactiva o ventana-player como último recurso.
export default function VideoPlayer(props) {
  const { stream, title, onClose, mode } = props
  const isElectronEnv = !!window.octostream?.isElectron
  const isEmbedStream = !!stream && (stream.streamType === 'embed' || stream.streamType === 'iframe')
  const canResolve = isElectronEnv && isEmbedStream && !!window.octostream?.embed?.resolve
  // resolution: {for: stream, stream: resolvedStream|null} — keyed por el
  // stream de entrada así el estado se deriva sin setState síncrono.
  const [resolution, setResolution] = useState(null)
  const resolvedStream = resolution?.for === stream ? resolution.stream : null
  const resolving = canResolve && !(resolution && resolution.for === stream)
  const relayIdRef = useRef(null)

  useEffect(() => {
    if (!canResolve) return undefined
    let cancelled = false
    const url = sanitizeUrl(stream.url)
    const referer = stream.referer || stream.headers?.Referer || ''
    // Embeds con cuenta atrás pre-emisión (FCTV): esperar hasta kickoff+90min.
    const kickoff = stream._fctvItem?._matchDate || 0
    const waitUntil = kickoff > Date.now() ? kickoff + 90 * 60 * 1000 : 0

    ;(async () => {
      // 1) Resolver headless — el equivalente del resolveEmbed de Android.
      let res = null
      try { res = await resolveEmbed(url, 15000, referer) } catch { /* fallthrough */ }
      if (cancelled) return
      if (res?.status === 'resolved' && res.url && !stream._wvPlayback) {
        // URL extraída reproducible con headers — los del request real de la
        // página (Referer/Origin/UA/cookies) los exige el CDN firmado.
        const headers = { ...(res.requestHeaders || {}), ...(stream.headers || {}) }
        if (res.referer && !headers.Referer && !headers.referer) headers.Referer = res.referer
        if (res.cookies && !headers.Cookie && !headers.cookie) headers.Cookie = res.cookies
        setResolution({ for: stream, stream: {
          ...stream,
          url: res.url,
          streamType: res.streamType || inferStreamType(res.url) || 'hls',
          headers,
        } })
        return
      }
      // 2) Relay de origen — el m3u8 solo se sirve al documento del embed
      // (TLS/cookies del navegador). Solo con media URL ya resuelta.
      if (res?.status === 'resolved' && res.url) try {
        const r = await playRelay(res.url, res.referer || referer || url, title || '', mode === 'live' ? 'live' : 'vod')
        if (cancelled) {
          if (r?.id) window.octostream?.embed?.relayStop?.({ id: r.id })?.catch?.(() => {})
          return
        }
        if (r?.status === 'playing' && r.url) {
          relayIdRef.current = r.id
          // URL loopback servida por el proxy local con la sesión del embed.
          setResolution({ for: stream, stream: { ...stream, url: r.url, streamType: 'hls', headers: {} } })
          return
        }
      } catch { /* fallthrough */ }
      // 3) Fallbacks de ventana visible (misma cadena que Android):
      //    - _wvPlayback (sandbox check DLive/tiestep): reproducir dentro de
      //      la ventana del embed (playEmbed playback:true).
      //    - resto: resolución interactiva — el usuario completa el
      //      captcha/click y la ventana se cierra sola al detectar el vídeo
      //      (playEmbed playback:false), devolviendo la URL directa.
      try {
        if (stream._wvPlayback) {
          const r = await playEmbed(url, title || '', referer, true, waitUntil)
          if (!cancelled && r?.status === 'closed') { onClose?.(); return }
        } else {
          const r = await playEmbed(url, title || '', referer, false, waitUntil)
          if (cancelled) return
          if (r?.status === 'resolved' && r.url) {
            const headers = { ...(r.requestHeaders || {}), ...(stream.headers || {}) }
            if (r.referer && !headers.Referer && !headers.referer) headers.Referer = r.referer
            if (r.cookies && !headers.Cookie && !headers.cookie) headers.Cookie = r.cookies
            setResolution({ for: stream, stream: {
              ...stream, url: r.url,
              streamType: r.streamType || inferStreamType(r.url) || 'hls', headers,
            } })
            return
          }
          if (r?.status === 'closed') { onClose?.(); return }
        }
      } catch { /* fallthrough */ }
      // 4) Último recurso: el stream queda sin resolver — VideoPlayerInner
      // abrirá la ventana-player del embed (Electron) o el iframe (web).
      if (!cancelled) setResolution({ for: stream, stream: null })
    })()

    return () => {
      cancelled = true
      if (relayIdRef.current) {
        window.octostream?.embed?.relayStop?.({ id: relayIdRef.current })?.catch?.(() => {})
        relayIdRef.current = null
      }
    }
  }, [stream, canResolve, mode, onClose, title])

  if (canResolve && resolving && !resolvedStream) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center gap-4">
        <LogoLoader size={80} />
        <p className="text-white text-sm text-center px-8">Resolviendo vídeo…</p>
        <button
          onClick={onClose}
          className="absolute top-4 right-4 btn-ghost p-2 rounded-lg"
          title="Cerrar"
        >
          <X size={24} />
        </button>
      </div>
    )
  }

  const effStream = resolvedStream || stream
  return <VideoPlayerInner {...props} stream={effStream} />
}
