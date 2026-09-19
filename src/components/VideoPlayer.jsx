import { useEffect, useRef, useState, useCallback } from 'react'
import { openSubtitlesPlugin } from '../plugins/builtIn/index.js'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'
import { isAndroidNative } from '../utils/platform.js'
import { createAndroidHlsLoader, setManifestBaseUrl } from '../utils/hlsAndroidLoader.js'
import { setPlayerOpen, markPlayerClosed } from '../utils/tvNavigation.js'
import { playStream, stopPlayback, isExoPlayerAvailable, playEmbed, playRelay, resolveEmbed, setChannels, setEpisodes, setNextEpisode, setCastRequestListener, setLoadingText, setPlaybackStateListener } from '../utils/exoPlayer.js'
import { resolveEmbed as resolveEmbedJs } from '../plugins/bundled/plurtasko/resolver.js'
import { pluginManager } from '../plugins/manager.js'
import { ExoPlayer } from '@octostream/exo-player'
import { loadHls, loadShaka } from '../utils/loadPlayerLibs.js'
import { useStore } from '../store/useStore.js'
import { useVideoProgress } from '../hooks/useVideoProgress.js'
import {
  X, Maximize, Minimize, Volume2, VolumeX, Volume1,
  Captions, Settings, ExternalLink,
  RotateCcw, Gauge,
  Play, Pause, SkipBack, SkipForward,
} from 'lucide-react'
import CastIcon from './CastIcon.jsx'
import CastMenu from './CastMenu.jsx'
import { sendStop } from '../utils/remotePlay.js'
import OctoLoader from './OctoLoader.jsx'
import LogoLoader from './LogoLoader.jsx'

// Log solo host — las URLs de stream llevan tokens firmados.
const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }


function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/^\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const fmtBytes = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`
const fmtRate = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${Math.round(b / 1e3)} KB/s`

// Texto de progreso del motor P2P — compartido entre el overlay del WebView
// (antes de abrir ExoPlayer) y el overlay nativo (vía setLoadingText).
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

export default function VideoPlayer({ mode = 'vod', stream, title, onClose, onEnded, meta, startTime = 0, channels = null, channelIndex = -1, onZapChannel = null, nextEpisode = null, onPlayNext = null, episodes = null, onPlayEpisode = null }) {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const hlsRef = useRef(null)
  const shakaRef = useRef(null)
  const gainNodeRef = useRef(null)
  const audioCtxRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const updateProgress = useStore(s => s.updateProgress)
  const [loading, setLoading] = useState(true)
  const [resolvingEmbed, setResolvingEmbed] = useState(false)
  const [torrentProgress, setTorrentProgress] = useState(null)
  const [error, setError] = useState(null)
  const [exoFailed, setExoFailed] = useState(false)
  const lastStreamRef = useRef(null)
  // Guard to prevent onClose from firing more than once. The native player
  // sends 'closed' when the user presses Back, and the cleanup also calls
  // stopPlayback() which triggers another 'closed'. Without this guard,
  // the second 'closed' could reopen the channel or cause navigation.
  const closedRef = useRef(false)
  const endedRef = useRef(false)
  // Timestamp del último openPlayer. El nativo a veces emite un "closed"
  // espurio ~150ms después de abrir (race del Dialog anterior cerrándose).
  // Sin este guard, React interpreta ese closed como cierre manual, llama
  // onClose(), y el canal se reabre. Ignoramos cualquier closed que llegue
  // en el primer segundo tras abrir un stream.
  const openedAtRef = useRef(0)
  // Reintento único de re-resolución cuando la URL firmada caduca en mitad
  // de la reproducción (CDN devuelve 4xx al refrescar el manifest HLS).
  const reResolveRef = useRef(false)
  const hlsRetriedRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [volumeBoost, setVolumeBoost] = useState(1)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const [showBoostMenu, setShowBoostMenu] = useState(false)
  const [showSubsPanel, setShowSubsPanel] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [subtitles, setSubtitles] = useState([])
  const [activeSubtitle, setActiveSubtitle] = useState(null)
  const [subsLoading, setSubsLoading] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showCastMenu, setShowCastMenu] = useState(false)
  const [casting, setCasting] = useState(false)
  const [castDevice, setCastDevice] = useState(null)
  const [remoteDevice, setRemoteDevice] = useState(null) // OctoStream LAN
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [hlsLevels, setHlsLevels] = useState([])
  const [currentLevel, setCurrentLevel] = useState(-1) // -1 = auto
  const [hlsSubtitles, setHlsSubtitles] = useState([])
  const [activeHlsSub, setActiveHlsSub] = useState(-1) // -1 = off
  const [nativeSubs, setNativeSubs] = useState([]) // CEA-608/708 tracks from video element
  const [activeNativeSub, setActiveNativeSub] = useState(-1) // -1 = off
  const [subDelay, setSubDelay] = useState(0) // subtitle delay in seconds (positive = later, negative = earlier)
  const castSessionRef = useRef(null)
  const streamRef = useRef(stream)
  streamRef.current = stream
  const titleRef = useRef(title)
  titleRef.current = title
  // Refs frescos para el listener nativo 'episodeSelected': el callback se
  // registra una vez al llamar a playStream y debe leer la lista actual.
  const episodesRef = useRef(episodes)
  episodesRef.current = episodes
  const onPlayEpisodeRef = useRef(onPlayEpisode)
  onPlayEpisodeRef.current = onPlayEpisode
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // Ref mirror of duration so event-handler closures registered once during
  // init() (ExoPlayer 'ended'/'position') always read the LATEST value.
  // Without this, saveFinalProgress captures the initial duration=0 and
  // computes progress=0, so the green tick never appears.
  const durationRef = useRef(0)
  const currentTimeRef = useRef(0)
  const setDurationTracked = (d) => { durationRef.current = d; setDuration(d) }
  const [seekable, setSeekable] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const hideControlsTimer = useRef(null)
  // Next episode popup (Netflix-style): shows 30s before end with countdown
  const [showNextEpPopup, setShowNextEpPopup] = useState(false)
  const [nextEpCountdown, setNextEpCountdown] = useState(10)
  const nextEpTimerRef = useRef(null)
  const nextEpShownRef = useRef(false)
  const seekBarRef = useRef(null)
  const cleanupRef = useRef(null)
  const loadTimeoutRef = useRef(null)
  const playerOpenTimerRef = useRef(null)
  const subBlobUrlRef = useRef(null)
  // Stores the ExoPlayer-specific cleanup returned from inside init(). The
  // async init() return value is otherwise lost (init().catch() ignores it),
  // so stopPlayback() and the delayed setPlayerOpen(false) never ran on
  // unmount when ExoPlayer was active. This ref bridges that gap.
  const exoCleanupRef = useRef(null)
  const torrentListenerRef = useRef(null)
  const torrentActiveRef = useRef(false)
  // Watchdog de torrents muertos: timestamp del primer evento con 0 peers
  // sostenidos. Si supera el umbral, se aborta en vez de esperar eternamente.
  const noPeersSinceRef = useRef(0)
  // true mientras el player nativo espera datos (carga inicial o stall de
  // buffering). El watchdog de 0-peers solo actúa cuando el playback necesita
  // piezas — un torrent parado con buffer suficiente no se corta.
  const playerStalledRef = useRef(true)
  const [isSeeking, setIsSeeking] = useState(false)

  // Para el motor P2P y borra los archivos del torrent (DELETE_FILES). Se
  // llama al cerrar el player, al terminar el episodio y en el cleanup del
  // componente — no se espera al desmontaje para no seguir descargando.
  const stopTorrentEngine = useCallback(() => {
    if (!torrentActiveRef.current && !torrentListenerRef.current) return
    torrentActiveRef.current = false
    noPeersSinceRef.current = 0
    try { torrentListenerRef.current?.remove?.() } catch {}
    torrentListenerRef.current = null
    setTorrentProgress(null)
    import('@octostream/torrent-engine').then(m => m.TorrentEngine.stop()).catch(() => {})
  }, [])

  useEffect(() => {
    if (!stream) return
    console.log('[Player] main effect running, stream=', urlHost(stream?.url || ''), 'streamChanged=', lastStreamRef.current !== stream, 'closedRef=', closedRef.current)

    // Cancel any pending setPlayerOpen(false) from a previous cleanup so it
    // can't fire after this run marks the player as open again.
    if (playerOpenTimerRef.current) {
      clearTimeout(playerOpenTimerRef.current)
      playerOpenTimerRef.current = null
    }

    // Only reset state when the stream changes, not when exoFailed changes
    const streamChanged = lastStreamRef.current !== stream
    if (streamChanged) {
      setExoFailed(false)
      lastStreamRef.current = stream
      reResolveRef.current = false
      hlsRetriedRef.current = false
      setLoading(true)
      setError(null)
      // Reset the close guard for the new stream
      closedRef.current = false
      endedRef.current = false
      // Registrar cuándo se abre este stream para ignorar "closed" espurios
      // que llegan ~150ms después de openPlayer (race del Dialog anterior).
      openedAtRef.current = Date.now()
    }
    setPlayerOpen(true)

    if (stream.streamType === 'embed' || stream.streamType === 'iframe') {
      // On Android: first try the invisible headless resolver (runs the JS
      // challenge, auto-plays, intercepts the media URL). If it resolves we
      // play the direct URL in ExoPlayer without ever showing a WebView.
      // Only if it fails do we open the visible interactive WebView.
      if (isExoPlayerAvailable()) {
        setLoading(false) // The native WebView shows its own loading
        setResolvingEmbed(false)
        let embedCancelled = false
        let webPlaybackTried = false
        let relayTried = false
        let relayCtx = null
        let lastPlayAt = 0
        const embedReferer = stream.referer || stream.headers?.Referer || ''

        // Reproducir el embed DENTRO del WebView nativo: CDNs como el de
        // DLive/tiestep solo sirven el m3u8 a documentos del propio proveedor
        // (Referer+TLS del iframe), así que la URL extraída da 403 fuera.
        const openWebViewPlayback = () => {
          webPlaybackTried = true
          setResolvingEmbed(true)
          lastPlayAt = Date.now()
          setPlaybackStateListener(onEmbedState) // stopPlayback() lo limpia
          return playEmbed(stream.url, title || '', embedReferer, true).then(result => {
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
          setResolvingEmbed(true)
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
          return playEmbed(stream.url, title || '', embedReferer).then(result => {
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
            // Fall back to iframe
            setResolvingEmbed(false)
            setLoading(false)
          })
        }

        // Intento invisible primero: corre el challenge JS/captcha en un WebView
        // oculto y captura la URL directa. Solo si falla abrimos el WebView visible.
        setResolvingEmbed(true)
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
      // Web iframe: keep `loading` until the iframe fires onLoad so the
      // branded loader covers the black screen while the page loads.
      return
    }

    let cancelled = false
    const mediaListeners = []
    const listen = (target, event, handler) => {
      target?.addEventListener?.(event, handler)
      mediaListeners.push([target, event, handler])
    }

    const init = async () => {

    // Re-resolver una URL fresca cuando el token firmado caduca:
    // embed → resolver JS sobre originalUrl; deportes → getStreams del item
    // origen (_fctvItem lleva _noCache, así que devuelve tokens nuevos).
    const resolveFreshStreamUrl = async () => {
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

    // On Android, use native ExoPlayer for all video playback
    // ExoPlayer handles HLS, DASH, and Widevine DRM natively without CORS issues
    // If ExoPlayer previously failed (e.g. 403 from CDN), fall back to HLS.js
    if (isExoPlayerAvailable() && !exoFailed) {
      // Reducir memoria del WebView: quitar video/canvas/source del DOM
      // antes de abrir ExoPlayer (el player nativo se muestra sobre el WebView).
      // NO limpiar <img> — React no restaura srcs borrados fuera de su control
      // y el banner/thumbnails quedaban vacíos al volver del player.
      try {
        document.querySelectorAll('video, canvas, source').forEach(el => {
          el.src = ''
          el.srcset = ''
        })
        // Ocultar el contenido de la página para liberar memoria de render
        const root = document.getElementById('root')
        if (root) root.style.display = 'none'
      } catch {}
      if (window.gc) { try { window.gc() } catch {} }

      const proxyUrl = window.octostream?.proxyUrl
      const isElectron = !!window.octostream?.isElectron
      let streamUrl = sanitizeUrl(stream.url)
      if (!streamUrl) {
        setError('URL del stream no válida')
        setLoading(false)
        return
      }

      // Torrent P2P: el motor nativo (jlibtorrent) descarga el archivo y lo
      // sirve por un endpoint HTTP local que ExoPlayer lee con Range requests.
      const isTorrent = stream.streamType === 'torrent'
      if (isTorrent) {
        try {
          setTorrentProgress({ state: 'metadata', progress: 0, peers: 0 })
          const { TorrentEngine } = await import('@octostream/torrent-engine')
          torrentListenerRef.current = await TorrentEngine.addListener('torrentProgress', ev => {
            if (!cancelled) setTorrentProgress(ev)
            // El overlay de carga nativo cubre el WebView — empujar el
            // progreso de la predescarga para que se vea en vivo.
            setLoadingText(torrentStatusText(ev))
            // Watchdog: 0 peers sostenidos con descarga incompleta = torrent
            // muerto. Sin esto el player esperaría piezas eternamente. Se
            // avisa y se cierra para poder elegir otro enlace.
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
          if (cancelled) return
          torrentActiveRef.current = true
          streamUrl = res.url
        } catch (e) {
          if (cancelled) return
          console.warn('[Player] torrent engine failed:', e?.message)
          setTorrentProgress(null)
          setError(e?.message || 'No se pudo iniciar el motor torrent')
          setLoading(false)
          return
        }
      }
      const skipProxy = stream.streamType === 'dash' || /directos\.mediasetinfinity\.es|dai\.google\.com|doubleclick\.net/i.test(streamUrl)
      if (proxyUrl && isElectron && /^https?:\/\//.test(streamUrl) && !streamUrl.includes('127.0.0.1') && !skipProxy) {
        streamUrl = proxyUrl + encodeURIComponent(streamUrl)
      }

      // Solo host — la URL completa puede llevar tokens firmados (debrid, CDNs).
      console.log('[Player] Using native ExoPlayer for', stream.streamType, urlHost(streamUrl))
      console.log('[Player] Headers:', Object.keys(stream.headers || {}).join(', ') || 'none')
      console.log('[Player] closedRef at playStream time:', closedRef.current)
      setLoading(false) // ExoPlayer shows its own loading indicator

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
            : channels.findIndex(c => (c.name || c.title) === (meta?.name || title))
              || channels.findIndex(c => {
                const cn = (c.name || c.title || '').toLowerCase().trim()
                const mn = (meta?.name || title || '').toLowerCase().trim()
                return cn && mn && cn === mn
              }))
        : -1
      const currentChannel = isLive && resolvedChannelIndex >= 0 ? channels[resolvedChannelIndex] : null
      const currentNow = meta?.epgNow || currentChannel?.nowPlaying || currentChannel?.now || ''
      const currentNext = meta?.epgNext || currentChannel?.nextPlaying || currentChannel?.next || ''
      const currentStart = meta?.epgStart || currentChannel?.nowPlayingStart || currentChannel?.start || 0
      const currentEnd = meta?.epgEnd || currentChannel?.nowPlayingEnd || currentChannel?.end || 0
      if (cancelled) return
      const playArgs = {
        url: streamUrl,
        streamType: isTorrent ? 'mp4' : stream.streamType || 'hls',
        // Los torrents van por el servidor local (127.0.0.1) — nunca por WARP —
        // y toleran stalls largos mientras llegan las piezas.
        direct: stream.direct === true || isTorrent,
        longBuffering: isTorrent,
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
        onEpisodeSelect: (ev) => {
          const ep = episodesRef.current?.[ev.index]
          if (ep && onPlayEpisodeRef.current) onPlayEpisodeRef.current(ep)
        },
      }
      const onPlaybackState = (state) => {
        // El watchdog de 0-peers solo actúa cuando el player espera datos.
        // 'position' llega cada 5s incluso durante un stall — no tocarlo.
        if (state.state === 'buffering' || state.state === 'idle') playerStalledRef.current = true
        else if (state.state === 'ready' || state.state === 'ended' || state.state === 'error') playerStalledRef.current = false
        if (state.state === 'error') {
          // If ExoPlayer fails with HTTP 403 or source error, fall back to HLS.js in WebView
          const msg = state.message || ''
          const isHttpError = /403|forbidden|source error|bad http|io.*http/i.test(msg)
            || state.errorCode === 2000 // ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
            || state.errorCode === 2001 // ERROR_CODE_IO_BAD_HTTP_STATUS
            || state.errorCode === 2003 // ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
            || state.errorCode === 2004 // ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
            || state.errorCode === -1 // buffering timeout agotado → probar HLS.js
          if (isHttpError) {
            // URL firmada caducada (los CDN devuelven 4xx/491 al refrescar el
            // manifest tras minutos de reproducción): re-resolver (embed o
            // item de deportes) y reintentar en ExoPlayer una sola vez antes
            // de caer a HLS.js, que moriría con el mismo código HTTP.
            if ((stream.originalUrl || stream._fctvItem) && !reResolveRef.current) {
              reResolveRef.current = true
              console.log('[Player] HTTP error — re-resolving fresh URL:', urlHost(stream.originalUrl || stream.url), 'code:', state.errorCode)
              setError(null)
              setResolvingEmbed(true)
              resolveFreshStreamUrl().then(fresh => {
                if (cancelled || closedRef.current) return
                setResolvingEmbed(false)
                if (fresh) {
                  console.log('[Player] Re-resolved URL, retrying ExoPlayer:', urlHost(fresh))
                  playArgs.url = fresh
                  playArgs.streamType = /\.m3u8(\?|$)/i.test(fresh) ? 'hls'
                    : /\.mp4(\?|$)/i.test(fresh) ? 'mp4' : playArgs.streamType
                  playStream(playArgs, onPlaybackState).catch(e => {
                    console.warn('[Player] ExoPlayer retry after re-resolve failed:', e?.message)
                    if (!cancelled && !closedRef.current) {
                      setExoFailed(true)
                      setLoading(true)
                    }
                  })
                } else {
                  console.log('[Player] Re-resolve gave no new URL, falling back to HLS.js')
                  setExoFailed(true)
                  setLoading(true)
                  stopPlayback().catch(() => {})
                }
              }).catch(e => {
                console.warn('[Player] Re-resolve failed:', e?.message)
                if (cancelled || closedRef.current) return
                setResolvingEmbed(false)
                setExoFailed(true)
                setLoading(true)
                stopPlayback().catch(() => {})
              })
              return
            }
            console.log('[Player] ExoPlayer HTTP error, falling back to HLS.js:', msg, 'code:', state.errorCode)
            setExoFailed(true)
            setError(null)
            setLoading(true)
            // Stop ExoPlayer to prevent subsequent 'closed' state from closing the app
            stopPlayback().catch(() => {})
          } else {
            setError(`Error ExoPlayer: ${msg}`)
          }
        } else if (state.state === 'ended') {
          // Episode finished - save final progress as 100% so the tick appears
          saveFinalProgress()
          // Mark as ended so the 'closed' event from openPlayer's closePlayer
          // doesn't unmount the VideoPlayer during episode transition
          endedRef.current = true
          // El episodio terminó — parar y borrar el torrent actual aunque el
          // siguiente sea otro stream (start() re-inicia el motor si toca).
          stopTorrentEngine()
          // Episode finished - trigger autoplay if available
          console.log('[Player] Playback ended, calling onEnded')
          if (onEnded) onEnded()
          else if (!closedRef.current) { closedRef.current = true; onClose?.() }
        } else if (state.state === 'closed') {
          // Don't close if we're falling back to HLS.js
          // Guard against duplicate 'closed' events: the native player sends
          // 'closed' when the user presses Back, and the cleanup also calls
          // stopPlayback() which triggers another 'closed'. Only call onClose
          // once to prevent reopening the channel or double navigation.
          // Also ignore 'closed' if we already received 'ended' — that means
          // the episode finished and the next is being loaded (openPlayer
          // calls closePlayer internally, which may emit 'closed').
          console.log('[Player] closed event received, exoFailed=', exoFailed, 'closedRef=', closedRef.current, 'endedReceived=', endedRef.current)
          if (!exoFailed && !closedRef.current && !endedRef.current) {
            // Ignorar "closed" espurios que llegan en el primer segundo tras
            // abrir el player. El nativo a veces emite un closed ~150ms después
            // de openPlayer por la race del Dialog anterior cerrándose.
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
        } else if (state.state === 'ready') {
          setLoading(false)
        } else if (state.state === 'position' && meta) {
          // ExoPlayer position update - save progress
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
          setCurrentTime(pos)
          currentTimeRef.current = pos
          if (dur > 0) setDurationTracked(dur)
        }
      }
      playStream(playArgs, onPlaybackState).catch(e => {
        console.error('[Player] ExoPlayer error:', e?.message)
        setError(`Error al iniciar ExoPlayer: ${e?.message || 'unknown'}`)
      })

      // Cleanup: stop ExoPlayer and restore the WebView DOM when falling back
      // Delay setPlayerOpen(false) so the Android back button that closed ExoPlayer
      // doesn't also trigger navigate(-1) in App.jsx's backButton handler.
      // Store in exoCleanupRef (not return) because init() is async — a return
      // value here resolves the Promise and is discarded by init().catch(),
      // so the cleanup would never run. The actual useEffect cleanup below
      // calls exoCleanupRef.current.
      exoCleanupRef.current = () => {
        console.log('[Player] ExoPlayer cleanup running, closedRef=', closedRef.current)
        playerOpenTimerRef.current = setTimeout(() => {
          playerOpenTimerRef.current = null
          setPlayerOpen(false)
        }, 300)
        try {
          const root = document.getElementById('root')
          if (root) root.style.display = ''
        } catch {}
        stopPlayback().catch(() => {})
      }
    }

    if (stream.streamType === 'torrent') {
      // Sin ExoPlayer (web/Electron) no hay motor P2P: el torrent solo es
      // reproducible si debrid ya lo convirtió a directo antes de llegar aquí.
      setError('Los torrents necesitan Android (motor P2P) o una cuenta Debrid')
      setLoading(false)
      return
    }

    console.log('[Player] ExoPlayer skipped, trying WebView/HLS.js fallback. exoFailed=', exoFailed)

    const videoEl = videoRef.current
    if (!videoEl) {
      console.log('[Player] videoEl is null - video element not rendered yet')
      return
    }
    console.log('[Player] videoEl found, setting up HLS.js for', stream.streamType, urlHost(stream.url || ''))

    // In Electron, route stream through local proxy to avoid CORS/SSL issues
    // For Mediaset VOD (rawvod.mediaset.es), route through proxy to add Origin/Referer headers
    // For Mediaset live (dai.google.com/doubleclick), skip proxy - CDN cookie chain breaks
    const proxyUrl = window.octostream?.proxyUrl
    const isElectron = !!window.octostream?.isElectron
    let streamUrl = stream.url
    const skipProxy = stream.streamType === 'dash' || /directos\.mediasetinfinity\.es|dai\.google\.com|doubleclick\.net/i.test(streamUrl)
    if (proxyUrl && isElectron && /^https?:\/\//.test(streamUrl) && !streamUrl.includes('127.0.0.1') && !skipProxy) {
      streamUrl = proxyUrl + encodeURIComponent(streamUrl)
    }

    // Cuando el token firmado caduca a mitad de reproducción (fragLoadError /
    // manifestLoadError fatal), re-resolver una URL fresca una sola vez.
    const tryFreshUrlRetry = async (hls) => {
      if (hlsRetriedRef.current) return false
      hlsRetriedRef.current = true
      try {
        const fresh = await resolveFreshStreamUrl()
        if (!fresh || fresh === streamUrl || closedRef.current) return false
        console.log('[Player] HLS fatal — reintentando con URL fresca:', urlHost(fresh))
        if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null }
        setError(null)
        setLoading(true)
        setManifestBaseUrl(fresh)
        hls.loadSource(fresh)
        return true
      } catch (e) {
        console.warn('[Player] reintento con URL fresca falló:', e?.message)
        return false
      }
    }

    // Timeout: if manifest doesn't load in 15s, show error
    loadTimeoutRef.current = setTimeout(() => {
      setLoading(prev => {
        if (prev) {
          setError('Timeout: no se pudo cargar el stream en 15 segundos. Puede que el canal no esté disponible o requiera CORS.')
        }
        return false
      })
    }, 15000)

    videoEl.disableRemotePlayback = true

    if (stream.streamType === 'hls') {
      const android = isAndroidNative()
      const isMediasetStream = /mediaset|dai\.google\.com|doubleclick\.net/i.test(streamUrl)

      // On Android, for Mediaset live streams, fetch manifest via CapacitorHttp
      // and pass as blob URL to native player (bypasses CORS + DAI parse issues)
      if (android && isMediasetStream && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        console.log('[Player] Mediaset live: fetching manifest via CapacitorHttp for native playback')
        import('@capacitor/core').then(({ CapacitorHttp }) => {
          CapacitorHttp.request({
            method: 'GET',
            url: streamUrl,
            headers: stream.headers || {},
            responseType: 'text',
          }).then(manifestResp => {
            if (manifestResp.status === 200 && manifestResp.data) {
              let manifestText = manifestResp.data
              const baseUrl = streamUrl
              manifestText = manifestText.split('\n').map(line => {
                const trimmed = line.trim()
                if (!trimmed || trimmed.startsWith('#')) return line
                try { return new URL(trimmed, baseUrl).href } catch { return line }
              }).join('\n')
              const blob = new Blob([manifestText], { type: 'application/vnd.apple.mpegurl' })
              const blobUrl = URL.createObjectURL(blob)
              console.log('[Player] Mediaset live: manifest blob created, trying native playback')
              videoEl.src = blobUrl
              const onLoadedMetadata = () => {
                console.log('[Player] Mediaset live: native HLS metadata loaded, starting playback')
                setLoading(false)
                videoEl.play().catch(e => console.warn('[Player] play() failed:', e))
              }
              const onError = (e) => {
                const err = videoEl.error
                console.error('[Player] Mediaset live: native HLS error:', 'code:', err?.code, 'message:', err?.message)
                setError(`Error al cargar Mediaset: ${err?.message || 'unknown'}`)
                setLoading(false)
              }
              listen(videoEl, 'loadedmetadata', onLoadedMetadata)
              listen(videoEl, 'error', onError)
              cleanupRef.current = () => {
                videoEl.removeEventListener('loadedmetadata', onLoadedMetadata)
                videoEl.removeEventListener('error', onError)
                URL.revokeObjectURL(blobUrl)
              }
            }
          }).catch(e => {
            console.error('[Player] Mediaset live: manifest fetch failed:', e?.message)
          })
        })
        // Return early - the manifest fetch is async and will set up playback
        // But we need to not fall through to HLS.js
        // Use a flag to prevent HLS.js setup
        // Actually, we can't return false here because the async hasn't completed
        // Let the timeout handle it - if manifest doesn't load in 15s, show error
        return false
      }

      // On Android, try native WebView HLS playback first for non-Mediaset streams
      // Fall back to HLS.js with CapacitorHttp loader if native fails
      if (android && !isMediasetStream && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        console.log('[Player] Trying native Android WebView HLS playback for', urlHost(streamUrl))
        let nativeHlsFailed = false
        const tryHlsJs = async () => {
          if (nativeHlsFailed) return
          nativeHlsFailed = true
          console.log('[Player] Native HLS failed, falling back to HLS.js + CapacitorHttp loader')
          videoEl.removeAttribute('src')
          videoEl.load()
          // Fall through to HLS.js by not returning - call the HLS.js setup
          const Hls = await loadHls()
          if (Hls.isSupported()) {
            const hlsConfig = {
              debug: false,
              startLoading: true,
              capLevelToPlayerSize: true,
              subtitleDisplay: false,
              enableWebVTT: true,
              enableCEA708Captions: true,
            }
            const AndroidLoader = createAndroidHlsLoader(stream.headers || {})
            if (AndroidLoader) {
              hlsConfig.loader = AndroidLoader
              setManifestBaseUrl(streamUrl)
              console.log('[Player] Using Android CapacitorHttp HLS loader (fallback)')
            }
            const hls = new Hls(hlsConfig)
            hlsRef.current = hls
            hls.attachMedia(videoEl)
            hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl))
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              console.log('[Player] HLS manifest parsed (fallback), starting playback')
              setLoading(false)
              videoEl.play().catch(e => console.warn('[Player] play() failed:', e))
            })
            hls.on(Hls.Events.ERROR, (event, data) => {
              console.log('[Player] HLS error (fallback):', data.type, data.details, data.fatal ? '(FATAL)' : '(non-fatal)')
              if (data.fatal) {
                tryFreshUrlRetry(hls).then(ok => {
                  if (!ok) {
                    setError(`Error HLS: ${data.details}`)
                    setLoading(false)
                  }
                })
              }
            })
          }
        }

        videoEl.src = streamUrl
        const onLoadedMetadata = () => {
          if (nativeHlsFailed) return
          console.log('[Player] Native HLS metadata loaded, starting playback')
          setLoading(false)
          videoEl.play().catch(e => console.warn('[Player] play() failed:', e))
        }
        const onError = (e) => {
          if (nativeHlsFailed) return
          const err = videoEl.error
          console.error('[Player] Native HLS error:', 'code:', err?.code, 'message:', err?.message, 'url:', urlHost(streamUrl))
          // Fall back to HLS.js for any native error
          tryHlsJs()
        }
        listen(videoEl, 'loadedmetadata', onLoadedMetadata)
        listen(videoEl, 'error', onError)
        listen(videoEl, 'ended', () => {
          console.log('[Player] Web video ended, calling onEnded')
          saveFinalProgress()
          if (onEnded) onEnded()
          else onClose?.()
        })
        // Capture native text tracks
        listen(videoEl.textTracks, 'addtrack', () => {
          const tracks = []
          for (let i = 0; i < videoEl.textTracks.length; i++) {
            const tt = videoEl.textTracks[i]
            if (tt.kind === 'subtitles' || tt.kind === 'captions') {
              if (tt.mode === 'showing') tt.mode = 'disabled'
              tracks.push({ index: i, name: tt.label || tt.language || `Track ${i + 1}`, lang: tt.language, kind: tt.kind })
            }
          }
          setNativeSubs(tracks)
        })
        // Cleanup listeners on unmount
        cleanupRef.current = () => {
          videoEl.removeEventListener('loadedmetadata', onLoadedMetadata)
          videoEl.removeEventListener('error', onError)
        }
        return false
      }

      const Hls = await loadHls()
      if (Hls.isSupported()) {
        const isMediasetStream = /mediaset|dai\.google\.com|doubleclick\.net/i.test(streamUrl)
        const android = isAndroidNative()
        const hlsConfig = {
          debug: false,
          startLoading: true,
          // No descargar rendiciones que superen el tamaño del reproductor:
          // sin esto hls.js puede elegir 4K en una pantalla de 720p.
          capLevelToPlayerSize: true,
          // Subtitles off by default - user can enable via UI
          subtitleDisplay: false,
          enableWebVTT: true,
          enableCEA708Captions: true,
        }

        // On Android, use custom loader with CapacitorHttp to bypass CORS
        if (android) {
          const AndroidLoader = createAndroidHlsLoader(stream.headers || {})
          if (AndroidLoader) {
            hlsConfig.loader = AndroidLoader
            // Set base URL for resolving relative URLs in manifests
            setManifestBaseUrl(streamUrl)
            console.log('[Player] Using Android CapacitorHttp HLS loader')
          }
        } else {
          // Configure XHR for direct (non-proxied) requests (Electron/web)
          hlsConfig.xhrSetup = (xhr, url) => {
            // Mediaset CDN requires cookies (hdntl) for segment auth
            if (/mediaset|dai\.google\.com|doubleclick\.net/i.test(url)) {
              xhr.withCredentials = true
            }
            // When NOT using the proxy, pass custom headers
            if (stream.headers && !streamUrl.includes('127.0.0.1')) {
              for (const [key, val] of Object.entries(stream.headers)) {
                try { xhr.setRequestHeader(key, val) } catch {}
              }
            }
          }
        }
        const hls = new Hls(hlsConfig)
        hlsRef.current = hls
        hls.loadSource(streamUrl)
        hls.attachMedia(videoEl)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('[Player] HLS manifest parsed, starting playback')
          // Capture quality levels
          setHlsLevels(hls.levels.map((l, i) => ({
            index: i,
            height: l.height,
            bitrate: l.bitrate,
            label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}kbps`,
          })))
          // Auto quality by default
          hls.currentLevel = -1
          setCurrentLevel(-1)
          // Capture subtitle tracks from HLS
          const captureHlsSubs = () => {
            setHlsSubtitles(hls.subtitleTracks.map((t, i) => ({
              index: i,
              name: t.name || t.lang || `Track ${i + 1}`,
              lang: t.lang,
            })))
          }
          captureHlsSubs()
          // Disable all subtitles by default
          hls.subtitleTrack = -1
          hls.subtitleDisplay = false
          setActiveHlsSub(-1)
          // Listen for subtitle tracks that arrive after MANIFEST_PARSED
          // (some streams add subtitle tracks dynamically)
          hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, captureHlsSubs)
          // Capture native text tracks (CEA-608/708) without disabling HLS-managed ones
          const captureNativeTracks = () => {
            const tracks = []
            for (let i = 0; i < videoEl.textTracks.length; i++) {
              const tt = videoEl.textTracks[i]
              // Only capture subtitles/captions tracks
              if (tt.kind === 'subtitles' || tt.kind === 'captions') {
                // Don't disable tracks that HLS.js is managing (mode='hidden')
                // Only disable tracks that are 'showing' by default
                if (tt.mode === 'showing') tt.mode = 'disabled'
                tracks.push({
                  index: i,
                  name: tt.label || tt.language || `Track ${i + 1}`,
                  lang: tt.language,
                  kind: tt.kind,
                })
              }
            }
            setNativeSubs(tracks)
          }
          captureNativeTracks()
          // Watch for new text tracks being added (CEA-708 may arrive late)
          listen(videoEl.textTracks, 'addtrack', () => {
            // Don't disable 'hidden' tracks - HLS.js uses that mode internally
            captureNativeTracks()
          })
          setLoading(false)
          videoEl.play().catch(e => console.warn('[Player] play() failed:', e))
        })
        listen(videoEl, 'ended', () => {
          console.log('[Player] HLS.js video ended, calling onEnded')
          saveFinalProgress()
          if (onEnded) onEnded()
          else onClose?.()
        })
        hls.on(Hls.Events.ERROR, (_, data) => {
          console.error('[Player] HLS error:', data.type, data.details, data.fatal ? '(FATAL)' : '(non-fatal)')
          if (data.fatal) {
            tryFreshUrlRetry(hls).then(ok => {
              if (ok) return
              const reason = data.details || data.type || 'unknown'
              setError(`Error al cargar el stream HLS: ${reason}`)
              setLoading(false)
            })
          }
        })
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = streamUrl
        listen(videoEl, 'loadedmetadata', () => setLoading(false))
        listen(videoEl, 'error', () => {
          setError('Error al cargar el stream')
          setLoading(false)
        })
      }
    } else if (stream.streamType === 'dash') {
      // DASH with Widevine DRM support via Shaka Player
      const android = isAndroidNative()
      const shaka = await loadShaka()
      shaka.polyfill.installAll()
      console.log('[Player] EME environment:', JSON.stringify({ platform: android ? 'android' : 'electron', origin: window.location.origin, secureContext: window.isSecureContext, eme: typeof navigator.requestMediaKeySystemAccess === 'function' }))
      const player = new shaka.Player()
      shakaRef.current = player
      player.attach(videoEl).then(async () => {
        // Configure DRM if license URL is provided
        const drmConfig = {}
        if (stream.drm?.type === 'widevine' && stream.drm?.licenseUrl) {
          let licenseUrl = stream.drm.licenseUrl
          // On Electron, route license through proxy for Origin/Referer headers
          // On Android, the WebView handles cross-origin requests natively (no proxy needed)
          if (isElectron && proxyUrl && /^https?:\/\//.test(licenseUrl)) {
            licenseUrl = proxyUrl + encodeURIComponent(licenseUrl)
          }
          drmConfig.drm = {
            servers: {
              'com.widevine.alpha': licenseUrl,
            },
          }
          if (android) {
            // Android WebView Widevine: use native DRM, no persistent state needed
            drmConfig.drm.advanced = {
              'com.widevine.alpha': {
                sessionType: 'temporary',
              },
            }
          }
          console.log('[Player] DASH with Widevine DRM')
        }

        // On Android, register a custom networking scheme to bypass CORS via CapacitorHttp
        if (android) {
          const { CapacitorHttp } = await import('@capacitor/core')
          const schemePlugin = async (uri, request, requestType, progressUpdated, headersReceived) => {
            // For license requests (POST with binary body), try CapacitorHttp first
            // (fetch() fails with CORS on license servers). CapacitorHttp may work
            // for small binary payloads like license challenges/responses.
            if (requestType === shaka.net.NetworkingEngine.RequestType.LICENSE) {
              console.log('[Player] License request via CapacitorHttp:', urlHost(uri))
              try {
                // Convert binary body to string for CapacitorHttp
                let bodyStr = undefined
                if (request.body) {
                  const bodyBytes = new Uint8Array(request.body)
                  // Convert to base64 for safe transport
                  let binary = ''
                  for (let i = 0; i < bodyBytes.length; i++) binary += String.fromCharCode(bodyBytes[i])
                  bodyStr = btoa(binary)
                }
                const licResp = await CapacitorHttp.request({
                  method: request.method || 'POST',
                  url: uri,
                  headers: { ...(stream.headers || {}), ...(request.headers || {}), 'Content-Type': 'application/octet-stream' },
                  responseType: 'arraybuffer',
                  data: bodyStr,
                })
                if (licResp.status >= 400) {
                  throw new Error(`HTTP ${licResp.status}`)
                }
                let data
                if (typeof licResp.data === 'string') {
                  const cleanB64 = licResp.data.replace(/\s/g, '')
                  const binaryStr = atob(cleanB64)
                  const len = binaryStr.length
                  const bytes = new Uint8Array(len)
                  for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i)
                  data = bytes.buffer
                  console.log('[Player] License response decoded:', len, 'bytes')
                } else {
                  data = new Uint8Array(licResp.data || []).buffer
                }
                return {
                  uri: uri,
                  data: data,
                  headers: licResp.headers || {},
                }
              } catch (capErr) {
                console.error('[Player] License CapacitorHttp failed:', capErr?.message, '- trying fetch')
                // Fall back to fetch
                try {
                  const fetchResp = await fetch(uri, {
                    method: request.method || 'POST',
                    headers: { ...(stream.headers || {}), ...(request.headers || {}), 'Content-Type': 'application/octet-stream' },
                    body: request.body || undefined,
                    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
                  })
                  if (!fetchResp.ok) {
                    throw new Error(`HTTP ${fetchResp.status}`)
                  }
                  const ab = await fetchResp.arrayBuffer()
                  console.log('[Player] License fetch OK:', ab.byteLength, 'bytes')
                  return { uri, data: ab, headers: {} }
                } catch (fetchErr) {
                  console.error('[Player] License fetch also failed:', fetchErr?.message)
                  throw new shaka.util.Error(
                    shaka.util.Error.Severity.CRITICAL,
                    shaka.util.Error.Category.DRM,
                    shaka.util.Error.Code.LICENSE_REQUEST_FAILED,
                    uri, String(fetchErr?.message || fetchErr)
                  )
                }
              }
            }
            // For manifest and segment requests, use CapacitorHttp to bypass CORS
            const resp = await CapacitorHttp.request({
              method: request.method || 'GET',
              url: uri,
              headers: { ...(stream.headers || {}), ...(request.headers || {}) },
              responseType: 'arraybuffer',
            })
            if (resp.status >= 400) {
              throw new shaka.util.Error(
                shaka.util.Error.Severity.RECOVERABLE,
                shaka.util.Error.Category.NETWORK,
                shaka.util.Error.Code.BAD_HTTP_STATUS,
                uri, resp.status
              )
            }
            let data
            if (typeof resp.data === 'string') {
              const cleanB64 = resp.data.replace(/\s/g, '')
              const binary = atob(cleanB64)
              data = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
            } else {
              data = new Uint8Array(resp.data || [])
            }
            return {
              uri: resp.url || uri,
              data: data.buffer,
              headers: resp.headers || {},
            }
          }
          // registerScheme is a static method in Shaka v4
          if (shaka.net && shaka.net.NetworkingEngine && shaka.net.NetworkingEngine.registerScheme) {
            shaka.net.NetworkingEngine.registerScheme('https', schemePlugin)
            shaka.net.NetworkingEngine.registerScheme('http', schemePlugin)
            console.log('[Player] Shaka custom scheme registered via static method')
          } else {
            console.warn('[Player] Shaka registerScheme not available, using request filter only')
            player.getNetworkingEngine().registerRequestFilter((type, request) => {
              if (stream.headers) {
                request.headers = { ...request.headers, ...stream.headers }
              }
            })
          }
        }

        player.configure(drmConfig)

        player.addEventListener('error', (e) => {
          console.error('[Player] Shaka error:', e.detail?.code, e.detail?.message, e.detail?.data)
          setError(`Error al cargar el stream DASH: ${e.detail?.message || e.detail?.code || 'unknown'}`)
          setLoading(false)
        })

        player.load(streamUrl).then(() => {
          console.log('[Player] DASH manifest loaded, starting playback')
          setLoading(false)
          videoEl.play().catch(err => console.warn('[Player] play() failed:', err))
        }).catch(err => {
          console.error('[Player] DASH load error:', err)
          setError(`Error al cargar el stream DASH: ${err.code || err.message || 'unknown'}`)
          setLoading(false)
        })
      }).catch(err => {
        console.error('[Player] Shaka attach error:', err)
        setError(`Error al iniciar Shaka Player: ${err.message || 'unknown'}`)
        setLoading(false)
      })
    } else if (stream.streamType === 'mp4') {
      videoEl.src = streamUrl
      listen(videoEl, 'loadedmetadata', () => setLoading(false))
      listen(videoEl, 'error', () => {
        setError('Error al cargar el video')
        setLoading(false)
      })
      listen(videoEl, 'ended', () => {
        console.log('[Player] MP4 video ended, calling onEnded')
        saveFinalProgress()
        if (onEnded) onEnded()
        else onClose?.()
      })
    } else {
      videoEl.src = streamUrl
      listen(videoEl, 'loadedmetadata', () => setLoading(false))
      listen(videoEl, 'ended', () => {
        console.log('[Player] Video ended, calling onEnded')
        saveFinalProgress()
        if (onEnded) onEnded()
        else onClose?.()
      })
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
      clearTimeout(loadTimeoutRef.current)
      for (const [target, event, handler] of mediaListeners) {
        target?.removeEventListener?.(event, handler)
      }
      // Stop the P2P engine if a torrent was playing (fire and forget).
      stopTorrentEngine()
      // If the ExoPlayer path ran, call its cleanup (stopPlayback + delayed
      // setPlayerOpen(false)). This was previously lost because init() is
      // async and its return value was discarded by init().catch().
      if (typeof exoCleanupRef.current === 'function') {
        try { exoCleanupRef.current() } catch (e) { console.warn('[Player] Exo cleanup error:', e?.message) }
        exoCleanupRef.current = null
        // ExoPlayer cleanup already restored root display and scheduled
        // setPlayerOpen(false). Don't run the HLS cleanup below — it would
        // call setPlayerOpen(false) immediately, defeating the 300ms delay
        // that prevents the leaked Back button from navigating away.
        return
      }
      setPlayerOpen(false)
      // Restaurar el DOM que ocultamos para liberar memoria
      try {
        const root = document.getElementById('root')
        if (root) root.style.display = ''
      } catch {}
      try {
        if (typeof cleanupRef.current === 'function') {
          cleanupRef.current()
        }
      } catch (e) { console.warn('[Player] cleanup error:', e?.message) }
      cleanupRef.current = null
      try {
        if (hlsRef.current?.destroy) {
          hlsRef.current.destroy()
        }
      } catch (e) { console.warn('[Player] HLS destroy error:', e?.message) }
      hlsRef.current = null
      try {
        if (shakaRef.current?.destroy) {
          shakaRef.current.destroy()
        }
      } catch (e) { console.warn('[Player] Shaka destroy error:', e?.message) }
      shakaRef.current = null
      // Revoke subtitle blob URL
      if (subBlobUrlRef.current) {
        URL.revokeObjectURL(subBlobUrlRef.current)
        subBlobUrlRef.current = null
      }
      // Clean up video element
      try {
        const v = videoRef.current
        if (v) {
          v.pause()
          v.removeAttribute('src')
          v.load()
        }
      } catch (e) { /* ignore */ }
    }
  }, [stream, exoFailed, mode])

  // Empujar la lista de canales al player nativo cuando llegue tarde (la ruta
  // Details carga el catálogo en background) o cuando el EPG se refresque.
  // Sin reabrir el player — el nativo solo actualiza su lista/OSD.
  useEffect(() => {
    // Skip if the player is already closed (cleanup ran) to avoid calling
    // native setChannels after closePlayer() which could re-add the channel
    // list panel to a null rootLayoutRef.
    console.log('[Player] setChannels effect running, closedRef=', closedRef.current, 'channels=', channels?.length, 'meta.type=', meta?.type)
    if (closedRef.current) return
    if ((meta?.type !== 'live' && meta?.type !== 'channel') || !channels?.length || exoFailed) return
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
  }, [channels, channelIndex, meta?.type, meta?.name, title, exoFailed])

  // Empujar la lista de episodios al player nativo si llega/cambia después de
  // empezar la reproducción (mismo patrón que setChannels).
  useEffect(() => {
    if (closedRef.current || exoFailed || !episodes?.length) return
    setEpisodes({
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
  }, [episodes, meta?.season, meta?.episode, exoFailed])

  // Keep currentMetaRef in sync with meta, but ONLY when the stream changes
  // (not when onPlayNext changes meta before the episode ends).
  // This prevents saveFinalProgress from marking the NEXT episode as watched.
  const currentMetaRef = useRef(null)
  const lastStreamForMetaRef = useRef(null)
  useEffect(() => {
    if (stream !== lastStreamForMetaRef.current) {
      lastStreamForMetaRef.current = stream
      currentMetaRef.current = meta
    }
  }, [stream, meta])

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

  useVideoProgress({
    videoRef,
    meta,
    startTime,
    isSeeking,
    updateProgress,
    setPlaying,
    setCurrentTime,
    setDuration: setDurationTracked,
    setSeekable,
    // Para series, anime y doramas: info del episodio actual para guardar
    // progreso por capítulo. Antes solo se pasaba cuando type === 'series',
    // por lo que anime y dorama nunca se marcaban como vistos.
    episodeInfo: meta?.season != null && meta?.episode != null
      ? { season: meta.season, episode: meta.episode, name: meta.episodeName || '' }
      : null,
  })

  // Next episode popup: detect when we're 30s before the end and show popup.
  // Only for series with a next episode available and autoplay enabled.
  // Skip the web popup when ExoPlayer is active — the native player has its
  // own popup and both firing would trigger onPlayNext twice.
  useEffect(() => {
    if (isExoPlayerAvailable()) {
      setShowNextEpPopup(false)
      nextEpShownRef.current = false
      return
    }
    // Respect the "auto next episode" setting: if disabled, no popup.
    if (localStorage.getItem('octostream_auto_next_ep') === 'false') {
      setShowNextEpPopup(false)
      nextEpShownRef.current = false
      return
    }
    if (!nextEpisode || !duration || duration <= 0) {
      setShowNextEpPopup(false)
      nextEpShownRef.current = false
      return
    }
    // Show popup 30s before end (or 10s for short episodes < 2min)
    const threshold = duration > 120 ? 30 : 10
    const timeLeft = duration - currentTime
    if (timeLeft <= threshold && timeLeft > 0 && !nextEpShownRef.current) {
      nextEpShownRef.current = true
      setShowNextEpPopup(true)
      setNextEpCountdown(10)
    }
    // Reset when a new episode starts (currentTime goes back to near 0)
    if (currentTime < 5 && nextEpShownRef.current && timeLeft > threshold) {
      nextEpShownRef.current = false
      setShowNextEpPopup(false)
    }
  }, [currentTime, duration, nextEpisode, onPlayNext])

  // Countdown del popup en efecto propio: antes vivía dentro del efecto de
  // arriba (deps currentTime) y su cleanup mataba el intervalo en el primer
  // tick de progreso → countdown congelado y onPlayNext nunca disparaba.
  useEffect(() => {
    if (!showNextEpPopup) return
    nextEpTimerRef.current = setInterval(() => {
      setNextEpCountdown(prev => {
        if (prev <= 1) {
          clearInterval(nextEpTimerRef.current)
          nextEpTimerRef.current = null
          setShowNextEpPopup(false)
          saveFinalProgress()
          if (onPlayNext) onPlayNext()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (nextEpTimerRef.current) {
        clearInterval(nextEpTimerRef.current)
        nextEpTimerRef.current = null
      }
    }
  }, [showNextEpPopup, onPlayNext])

  // Push next episode info to native ExoPlayer so it can show the popup
  // natively (the web UI is not rendered when ExoPlayer is active).
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
      // Clear next episode info (e.g. movies, last episode)
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

  // Auto-hide controls after inactivity
  useEffect(() => {
    const resetTimer = () => {
      setShowControls(true)
      clearTimeout(hideControlsTimer.current)
      hideControlsTimer.current = setTimeout(() => {
        if (playing) setShowControls(false)
      }, 3000)
    }
    const container = containerRef.current
    if (!container) return
    container.addEventListener('mousemove', resetTimer)
    container.addEventListener('mousedown', resetTimer)
    container.addEventListener('touchstart', resetTimer)
    resetTimer()
    return () => {
      clearTimeout(hideControlsTimer.current)
      container.removeEventListener('mousemove', resetTimer)
      container.removeEventListener('mousedown', resetTimer)
      container.removeEventListener('touchstart', resetTimer)
    }
  }, [playing])

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    document.addEventListener('webkitfullscreenchange', handleFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange)
      document.removeEventListener('webkitfullscreenchange', handleFsChange)
    }
  }, [])

  // Apply subtitle delay to active text tracks
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return
    for (let i = 0; i < videoEl.textTracks.length; i++) {
      const tt = videoEl.textTracks[i]
      if (tt.mode === 'showing' || tt.mode === 'hidden') {
        const cues = tt.cues
        if (!cues) continue
        // Store original times on first access
        if (!tt._origCues) {
          tt._origCues = []
          for (let c = 0; c < cues.length; c++) {
            tt._origCues.push({ start: cues[c].startTime, end: cues[c].endTime })
          }
        }
        // Apply delay
        for (let c = 0; c < cues.length && c < tt._origCues.length; c++) {
          cues[c].startTime = Math.max(0, tt._origCues[c].start + subDelay)
          cues[c].endTime = Math.max(0, tt._origCues[c].end + subDelay)
        }
      }
    }
  }, [subDelay])

  // Keyboard shortcuts. No aplican con ExoPlayer nativo: el reproductor
  // nativo tiene su propio diálogo/foco y gestiona el botón atrás por su
  // cuenta (ver ExoPlayerPlugin.java). Registrar este listener igualmente
  // podría cerrar el estado de React ante una pulsación residual mientras
  // el diálogo nativo sigue abierto, desincronizando ambas capas.
  useEffect(() => {
    if (useNativeExoPlayer) return undefined
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      switch (e.key) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          e.preventDefault()
          togglePlayPause()
          break
        case 'MediaPlay':
          e.preventDefault()
          videoRef.current?.play?.()?.catch?.(() => {})
          break
        case 'MediaPause':
          e.preventDefault()
          videoRef.current?.pause?.()
          break
        case 'ArrowLeft':
        case 'MediaRewind':
          e.preventDefault()
          seekTo(currentTime - 10)
          break
        case 'ArrowRight':
        case 'MediaFastForward':
          e.preventDefault()
          seekTo(currentTime + 10)
          break
        case 'ArrowUp':
          e.preventDefault()
          handleVolumeChange(Math.min(1, volume + 0.1))
          break
        case 'ArrowDown':
          e.preventDefault()
          handleVolumeChange(Math.max(0, volume - 0.1))
          break
        case 'f':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'm':
          e.preventDefault()
          toggleMute()
          break
        case 'Escape':
        case 'Back':
        case 'NavigationBack':
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen()
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
          } else {
            e.preventDefault()
            onClose?.()
          }
          break
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [currentTime, volume, playing])

  const toggleFullscreen = () => {
    const el = containerRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen()
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
      } else {
        if (el.requestFullscreen) el.requestFullscreen()
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
        else if (el.mozRequestFullScreen) el.mozRequestFullScreen()
        else if (el.msRequestFullscreen) el.msRequestFullscreen()
      }
    } catch (e) {
      console.error('[Player] fullscreen error:', e?.message)
    }
  }

  const togglePlayPause = () => {
    const videoEl = videoRef.current
    if (!videoEl) return
    if (videoEl.paused) videoEl.play().catch(() => {})
    else videoEl.pause()
  }

  const seekTo = (time) => {
    const videoEl = videoRef.current
    if (!videoEl || !isFinite(time)) return
    videoEl.currentTime = Math.max(0, Math.min(time, duration))
  }

  const skipForward = () => seekTo(currentTime + 10)
  const skipBackward = () => seekTo(currentTime - 10)

  const handleSeekBarChange = (e) => {
    const val = parseFloat(e.target.value)
    setCurrentTime(val)
    seekTo(val)
  }

  const formatTime = (s) => {
    if (!isFinite(s) || s < 0) return '0:00'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const isEmbed = stream && (stream.streamType === 'embed' || stream.streamType === 'iframe')
  // On Android, embeds are handled by native WebView (playEmbed), not iframe
  const isNativeEmbed = isEmbed && isExoPlayerAvailable()
  const useNativeExoPlayer = isExoPlayerAvailable() && stream && !isEmbed && !exoFailed

  const initAudioBoost = useCallback(() => {
    const videoEl = videoRef.current
    if (!videoEl || audioCtxRef.current) return
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const source = ctx.createMediaElementSource(videoEl)
      const gain = ctx.createGain()
      gain.gain.value = volumeBoost
      source.connect(gain)
      gain.connect(ctx.destination)
      audioCtxRef.current = ctx
      gainNodeRef.current = gain
      sourceNodeRef.current = source
    } catch (e) {
      // AudioContext not available
    }
  }, [volumeBoost])

  const handleVolumeChange = useCallback((newVol) => {
    const videoEl = videoRef.current
    setVolume(newVol)
    setMuted(newVol === 0)
    if (videoEl) videoEl.muted = newVol === 0
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newVol * volumeBoost
    } else if (videoEl) {
      videoEl.volume = newVol
    }
  }, [volumeBoost])

  const handleBoostChange = useCallback((boost) => {
    setVolumeBoost(boost)
    if (!gainNodeRef.current) {
      initAudioBoost()
    }
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume * boost
    }
    setShowBoostMenu(false)
  }, [volume, initAudioBoost])

  const handleQualityChange = (levelIndex) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex
      setCurrentLevel(levelIndex)
    }
    setShowSettings(false)
  }

  const handleHlsSubtitleToggle = (subIndex) => {
    const hls = hlsRef.current
    if (hls) {
      hls.subtitleTrack = subIndex
      hls.subtitleDisplay = subIndex >= 0
      setActiveHlsSub(subIndex)
    }
    // Don't touch videoEl.textTracks - HLS.js manages them internally
    // when subtitleDisplay=true, HLS.js renders cues on the video element
    // Clear native sub selection when using HLS subs
    if (subIndex >= 0) setActiveNativeSub(-1)
    // Also clear OpenSubtitles
    if (subIndex >= 0) {
      const videoEl = videoRef.current
      if (videoEl) {
        const track = videoEl.querySelector('track[data-subs]')
        if (track) track.remove()
        setActiveSubtitle(null)
      }
    }
    // Reset subtitle delay cache so it re-applies to new track
    const videoEl = videoRef.current
    if (videoEl) {
      for (let i = 0; i < videoEl.textTracks.length; i++) {
        videoEl.textTracks[i]._origCues = null
      }
    }
    setShowSubsPanel(false)
  }

  const handleNativeSubtitleToggle = (trackIndex) => {
    const videoEl = videoRef.current
    if (!videoEl) return
    // Disable HLS subtitles when using native
    const hls = hlsRef.current
    if (hls) {
      hls.subtitleTrack = -1
      hls.subtitleDisplay = false
      setActiveHlsSub(-1)
    }
    // Toggle native text tracks
    for (let i = 0; i < videoEl.textTracks.length; i++) {
      videoEl.textTracks[i].mode = (trackIndex >= 0 && i === trackIndex) ? 'showing' : 'disabled'
      videoEl.textTracks[i]._origCues = null
    }
    setActiveNativeSub(trackIndex)
    // Also clear OpenSubtitles
    if (trackIndex >= 0) {
      const track = videoEl.querySelector('track[data-subs]')
      if (track) track.remove()
      setActiveSubtitle(null)
    }
    setShowSubsPanel(false)
  }

  const toggleMute = () => {
    const newMuted = !muted
    setMuted(newMuted)
    const videoEl = videoRef.current
    if (videoEl) videoEl.muted = newMuted
    if (gainNodeRef.current && newMuted) {
      gainNodeRef.current.gain.value = 0
    } else if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume * volumeBoost
    }
  }

  const handlePlaybackRate = (rate) => {
    setPlaybackRate(rate)
    const videoEl = videoRef.current
    if (videoEl) videoEl.playbackRate = rate
    setShowSettings(false)
  }

  const openInExternal = (player) => {
    if (!stream) return
    const safeStreamUrl = sanitizeUrl(stream.url)
    if (!safeStreamUrl) {
      setError('URL del stream no válida')
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

  const searchSubs = async () => {
    const query = meta?.name || title || stream?.name
    if (!query) return
    setSubsLoading(true)
    setShowSubsPanel(true)
    try {
      const results = await openSubtitlesPlugin.searchSubtitles({
        query,
        languages: 'es,en',
        imdbId: meta?.imdbId || undefined,
        season: meta?.season ?? undefined,
        episode: meta?.episode ?? undefined,
      })
      setSubtitles(results)
    } catch (e) {
      setSubtitles([])
    }
    setSubsLoading(false)
  }

  const applySubtitle = async (sub) => {
    try {
      const srtContent = await openSubtitlesPlugin.downloadSubtitle(sub.downloadUrl, sub.encoding)
      const vttContent = srtToVtt(srtContent)
      const blob = new Blob([vttContent], { type: 'text/vtt' })
      const blobUrl = URL.createObjectURL(blob)
      // Revoke the previous subtitle blob URL to avoid memory leaks
      if (subBlobUrlRef.current) URL.revokeObjectURL(subBlobUrlRef.current)
      subBlobUrlRef.current = blobUrl

      const videoEl = videoRef.current
      if (!videoEl) return

      let track = videoEl.querySelector('track[data-subs]')
      if (track) track.remove()

      const lang = sub.language || 'es'
      track = document.createElement('track')
      track.kind = 'subtitles'
      track.label = lang
      track.srclang = lang.split('-')[0]
      track.src = blobUrl
      track.default = true
      track.setAttribute('data-subs', '1')
      videoEl.appendChild(track)

      // textTracks[0] no es necesariamente la pista nueva — el stream puede
      // tener pistas de texto embebidas. Usar el TextTrack del <track> creado.
      if (track.track) track.track.mode = 'showing'
      setActiveSubtitle(sub)
      setShowSubsPanel(false)
    } catch (e) {
      setError('Error al cargar subtítulo')
    }
  }

  const removeSubtitles = () => {
    const videoEl = videoRef.current
    if (!videoEl) return
    const track = videoEl.querySelector('track[data-subs]')
    if (track) track.remove()
    setActiveSubtitle(null)
  }

  const boostLevels = [1, 1.5, 2, 2.5, 3, 4]
  const speedLevels = [0.5, 0.75, 1, 1.25, 1.5, 2]

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
    const videoEl = videoRef.current
    const currentStream = streamRef.current || stream
    const currentTitle = titleRef.current || title

    if (videoEl && videoEl.remote && typeof videoEl.remote.prompt === 'function') {
      try {
        videoEl.disableRemotePlayback = false
        const state = await videoEl.remote.prompt()
        if (state === 'connected') {
          setCasting(true)
          setCastDevice('TV')
          setShowCastMenu(false)
          videoEl.remote.onconnect = () => {
            setCasting(true)
            setCastDevice('TV')
          }
          videoEl.remote.ondisconnect = () => {
            setCasting(false)
            setCastDevice(null)
            videoEl.disableRemotePlayback = true
          }
          return
        }
        videoEl.disableRemotePlayback = true
      } catch (e) {
        videoEl.disableRemotePlayback = true
      }
    }

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
        const isElectron = !!window.octostream?.isElectron
        if (isElectron && /^https?:\/\//.test(castUrl) && !castUrl.includes('127.0.0.1')) {
          try {
            const lanProxyUrl = await window.octostream.getLanProxyUrl()
            if (lanProxyUrl) {
              castUrl = lanProxyUrl + encodeURIComponent(castUrl)
              console.log('[Cast] Using LAN proxy URL for Chromecast')
            }
          } catch (e) {
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
    } catch (e) {
      setShowCastMenu(true)
    }
  }

  const stopCasting = () => {
    const videoEl = videoRef.current
    if (videoEl && videoEl.remote && videoEl.remote.state === 'connected') {
      videoEl.remote.disconnect()
      videoEl.disableRemotePlayback = true
    }
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

  // El botón Cast nativo reutiliza el mismo flujo Cast de la UI web.
  useEffect(() => {
    if (!isAndroidNative()) return undefined
    return setCastRequestListener((event) => {
      console.info('[ExoPlayer] castRequested received', event?.title || '')
      // Actualizar stream/title con lo que el nativo envía para que
      // requestCastSession use la URL correcta.
      if (event?.url) {
        streamRef.current = { url: event.url, streamType: 'hls' }
      }
      if (event?.title) titleRef.current = event.title
      // Abrir el menú de Cast para que el usuario elija dispositivo.
      setShowCastMenu(true)
    })
  }, [])

  // La reproducción nativa tiene su propio PlayerView, controles, menú de
  // ajustes y navegación D-pad. No renderizar una segunda UI web detrás.
  // Pero el menú de Cast SI debe renderizarse para que el botón nativo pueda
  // abrir el diálogo de dispositivos.
  if (useNativeExoPlayer && !error && !showCastMenu && !casting && !remoteDevice) return null

  if (useNativeExoPlayer && !error) {
    return (
      <div className="fixed inset-0 z-[60] pointer-events-none">
        {showCastMenu && (
          <CastMenu
            stream={streamRef.current || stream}
            title={titleRef.current || title}
            mode={mode}
            meta={meta}
            className="absolute top-14 right-4 pointer-events-auto"
            onRequestCast={() => { setShowCastMenu(false); requestCastSession() }}
            onRemoteSent={(device) => { setRemoteDevice(device); setShowCastMenu(false) }}
            onClose={() => setShowCastMenu(false)}
            copiedUrl={copiedUrl}
            onCopyUrl={copyStreamUrl}
            onOpenTvBrowser={openOnTvBrowser}
          />
        )}
        {(casting || remoteDevice) && (
          <div className="absolute top-4 right-4 bg-dark-800/95 backdrop-blur-md rounded-xl px-4 py-2.5 shadow-2xl border border-primary-600/50 flex items-center gap-2.5 pointer-events-auto">
            <CastIcon size={18} className="text-primary-400 animate-pulse" />
            <span className="text-white text-sm font-medium">Enviando a {castDevice || remoteDevice?.name || remoteDevice?.ip}</span>
            <button onClick={stopCasting} className="ml-1 text-dark-400 hover:text-white">
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-player-overlay
      className={`fixed inset-0 z-50 bg-black flex items-center justify-center ${!showControls ? 'cursor-none' : ''}`}
    >
      <div className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <h2 className="text-white text-lg font-medium truncate max-w-[60%]">
          {title}
          {stream?.quality && (
            <span className="ml-3 text-xs bg-primary-600 px-2 py-0.5 rounded">
              {stream.quality}
            </span>
          )}
          {(activeSubtitle || activeHlsSub >= 0 || activeNativeSub >= 0) && (
            <span className="ml-2 text-xs bg-green-600 px-2 py-0.5 rounded">
              SUB
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
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
              stream={streamRef.current || stream}
              title={titleRef.current || title}
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
          <p className="text-red-400 text-lg">{error}</p>
          <button onClick={onClose} className="btn-primary">Cerrar</button>
        </div>
      )}

      {isEmbed && !isNativeEmbed && (
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

      {!isEmbed && !error && !useNativeExoPlayer && (
        <div className="w-full h-full flex items-center justify-center" onClick={togglePlayPause}>
          <video
            ref={videoRef}
            className="w-full h-full"
            autoPlay
            playsInline
          />
          {/* Play/Pause overlay icon */}
          {!loading && !playing && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-black/50 rounded-full p-5">
                <Play size={48} className="text-white ml-1" />
              </div>
            </div>
          )}
        </div>
      )}

      {useNativeExoPlayer && (
        <div className="w-full h-full flex flex-col items-center justify-center bg-black gap-4">
          <LogoLoader size={80} />
          <p className="text-white text-sm">Cargando enlace…</p>
        </div>
      )}

      {/* Barra inferior de controles */}
      {!isEmbed && !error && !useNativeExoPlayer && (
        <div className={`absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent pb-3 pt-12 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>

          {/* Seek bar */}
          {seekable && (
            <div className="px-4 mb-2">
              <div className="flex items-center gap-3">
                <span className="text-white text-xs font-mono min-w-[40px] text-right">{formatTime(currentTime)}</span>
                <input
                  ref={seekBarRef}
                  type="range"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={currentTime}
                  onChange={handleSeekBarChange}
                  onMouseDown={() => setIsSeeking(true)}
                  onMouseUp={() => setIsSeeking(false)}
                  onTouchStart={() => setIsSeeking(true)}
                  onTouchEnd={() => setIsSeeking(false)}
                  className="flex-1 h-1.5 accent-primary-500 cursor-pointer appearance-none bg-dark-600 rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:bg-primary-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-primary-400"
                  style={{ background: duration > 0 ? `linear-gradient(to right, rgb(var(--color-primary-500)) ${(currentTime / duration) * 100}%, rgb(55 65 81) ${(currentTime / duration) * 100}%)` : undefined }}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="text-dark-400 text-xs font-mono min-w-[40px]">{formatTime(duration)}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-1 sm:gap-2">

            {/* Play/Pause */}
            <button
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); togglePlayPause() }}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors focus:bg-primary-600/30 focus:outline-none"
              title={playing ? 'Pausa' : 'Reproducir'}
            >
              {playing ? <Pause size={24} /> : <Play size={24} className="ml-0.5" />}
            </button>

            {/* Skip backward 10s */}
            <button
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); skipBackward() }}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors focus:bg-primary-600/30 focus:outline-none"
              title="Retroceder 10s"
            >
              <SkipBack size={20} />
            </button>

            {/* Skip forward 10s */}
            <button
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); skipForward() }}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors focus:bg-primary-600/30 focus:outline-none"
              title="Avanzar 10s"
            >
              <SkipForward size={20} />
            </button>

            {/* Separador */}
            <div className="w-px h-6 bg-dark-600 mx-1" />

            {/* Volumen */}
            <div
              className="relative"
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={() => setShowVolumeSlider(false)}
            >
              <button
                tabIndex={0}
                onClick={toggleMute}
                className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors focus:bg-primary-600/30 focus:outline-none"
                title="Volumen"
              >
                {muted || volume === 0 ? <VolumeX size={22} /> :
                 volume < 0.5 ? <Volume1 size={22} /> :
                 <Volume2 size={22} />}
              </button>
              {showVolumeSlider && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-dark-800 rounded-xl p-3 shadow-2xl border border-dark-700">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={muted ? 0 : volume}
                    onChange={e => handleVolumeChange(parseFloat(e.target.value))}
                    className="w-24 accent-primary-500"
                    style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                  />
                  <p className="text-center text-xs text-dark-400 mt-1">
                    {Math.round((muted ? 0 : volume) * 100)}%
                  </p>
                </div>
              )}
            </div>

            {/* Amplificador de volumen */}
            <div className="relative">
              <button
                onClick={() => setShowBoostMenu(!showBoostMenu)}
                className={`p-2 rounded-lg transition-colors ${volumeBoost > 1 ? 'text-primary-400 bg-primary-600/20' : 'text-white hover:bg-white/10'}`}
                title="Amplificador de volumen"
              >
                <Gauge size={22} />
              </button>
              {showBoostMenu && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-dark-800 rounded-xl p-2 shadow-2xl border border-dark-700 min-w-[120px]">
                  <p className="text-xs text-dark-400 px-2 py-1 font-medium">Amplificador</p>
                  {boostLevels.map(level => (
                    <button
                      key={level}
                      onClick={() => handleBoostChange(level)}
                      className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${volumeBoost === level ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                    >
                      {level}x{level > 1 ? ' ⚡' : ' (Normal)'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Subtitulos */}
            <div className="relative">
              <button
                onClick={() => setShowSubsPanel(!showSubsPanel)}
                className={`p-2 rounded-lg transition-colors ${activeSubtitle || activeHlsSub >= 0 || activeNativeSub >= 0 ? 'text-primary-400 bg-primary-600/20' : 'text-white hover:bg-white/10'}`}
                title="Subtítulos"
              >
                <Captions size={22} />
              </button>
              {(activeSubtitle || activeHlsSub >= 0 || activeNativeSub >= 0) && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full" />
              )}

              {showSubsPanel && (
                <div className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-dark-800 rounded-xl p-3 shadow-2xl border border-dark-700 w-80 max-h-80 overflow-y-auto">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-white font-medium text-sm">Subtítulos</h3>
                    <button onClick={() => setShowSubsPanel(false)} className="text-dark-400 hover:text-white">
                      <X size={16} />
                    </button>
                  </div>

                  {/* No subtitles available */}
                  {hlsSubtitles.length === 0 && nativeSubs.length === 0 && !meta && !title && (
                    <p className="text-dark-400 text-sm text-center py-4">Sin subtítulos disponibles</p>
                  )}

                  {/* "Desactivado" button - always show when any subs exist */}
                  {(hlsSubtitles.length > 0 || nativeSubs.length > 0) && (activeHlsSub >= 0 || activeNativeSub >= 0) && (
                    <button
                      onClick={() => { handleHlsSubtitleToggle(-1); handleNativeSubtitleToggle(-1) }}
                      className="w-full text-left px-3 py-1.5 rounded text-sm transition-colors bg-primary-600 text-white mb-2"
                    >
                      Desactivar subtítulos
                    </button>
                  )}

                  {/* HLS subtitle tracks (WebVTT from manifest) */}
                  {hlsSubtitles.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-dark-400 px-1 mb-1 font-medium">Del stream</p>
                      <button
                        onClick={() => handleHlsSubtitleToggle(-1)}
                        className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${activeHlsSub === -1 ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                      >
                        Desactivado
                      </button>
                      {hlsSubtitles.map(s => (
                        <button
                          key={s.index}
                          onClick={() => handleHlsSubtitleToggle(s.index)}
                          className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${activeHlsSub === s.index ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                        >
                          {s.name}{s.lang ? ` (${s.lang})` : ''}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Native text tracks (CEA-608/708 embedded captions) */}
                  {nativeSubs.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-dark-400 px-1 mb-1 font-medium">Subtítulos embebidos (TV)</p>
                      <button
                        onClick={() => handleNativeSubtitleToggle(-1)}
                        className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${activeNativeSub === -1 ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                      >
                        Desactivado
                      </button>
                      {nativeSubs.map(s => (
                        <button
                          key={s.index}
                          onClick={() => handleNativeSubtitleToggle(s.index)}
                          className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${activeNativeSub === s.index ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                        >
                          {s.name}{s.lang ? ` (${s.lang})` : ''}{s.kind === 'captions' ? ' [CC]' : ''}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Subtitle sync control - show when any subtitle is active */}
                  {(activeHlsSub >= 0 || activeNativeSub >= 0 || activeSubtitle) && (
                    <div className="border-t border-dark-700 pt-2 mb-2">
                      <div className="flex items-center justify-between px-1 mb-1">
                        <p className="text-xs text-dark-400 font-medium">Sincronización</p>
                        <span className="text-xs text-primary-400 font-mono">
                          {subDelay > 0 ? '+' : ''}{subDelay.toFixed(1)}s
                        </span>
                      </div>
                      <div className="flex items-center gap-2 px-1">
                        <button
                          onClick={() => setSubDelay(d => Math.max(-30, +(d - 0.5).toFixed(1)))}
                          className="p-1 rounded text-dark-300 hover:bg-dark-700 transition-colors"
                          title="Adelantar 0.5s"
                        >
                          <SkipBack size={16} />
                        </button>
                        <input
                          type="range"
                          min="-30"
                          max="30"
                          step="0.5"
                          value={subDelay}
                          onChange={e => setSubDelay(parseFloat(e.target.value))}
                          className="flex-1 accent-primary-500"
                        />
                        <button
                          onClick={() => setSubDelay(d => Math.min(30, +(d + 0.5).toFixed(1)))}
                          className="p-1 rounded text-dark-300 hover:bg-dark-700 transition-colors"
                          title="Retrasar 0.5s"
                        >
                          <SkipForward size={16} />
                        </button>
                        <button
                          onClick={() => setSubDelay(0)}
                          className="text-xs text-dark-400 hover:text-white px-2 py-1 rounded hover:bg-dark-700 transition-colors"
                          title="Resetear"
                        >
                          0s
                        </button>
                      </div>
                    </div>
                  )}

                  {/* OpenSubtitles */}
                  <div className="border-t border-dark-700 pt-2">
                    <p className="text-xs text-dark-400 px-1 mb-1 font-medium">OpenSubtitles</p>
                    {activeSubtitle && (
                      <button
                        onClick={removeSubtitles}
                        className="w-full text-left px-3 py-1.5 rounded text-sm text-dark-300 hover:bg-dark-700 transition-colors mb-1"
                      >
                        Quitar subtítulo actual
                      </button>
                    )}
                    {subsLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <OctoLoader size={20} className="text-primary-500" />
                      </div>
                    ) : subtitles.length === 0 ? (
                      <button
                        onClick={searchSubs}
                        className="w-full text-left px-3 py-1.5 rounded text-sm text-dark-300 hover:bg-dark-700 transition-colors"
                      >
                        Buscar en OpenSubtitles...
                      </button>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {subtitles.map(sub => (
                          <button
                            key={sub.id}
                            onClick={() => applySubtitle(sub)}
                            className="w-full text-left p-2 rounded-lg hover:bg-dark-700 transition-colors"
                          >
                            <span className="text-white text-sm font-medium">
                              {sub.language === 'es' ? '🇪🇸' : '🇬🇧'} {sub.language}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Velocidad de reproducción */}
            <div className="relative">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-2 rounded-lg transition-colors ${playbackRate !== 1 ? 'text-primary-400 bg-primary-600/20' : 'text-white hover:bg-white/10'}`}
                title="Velocidad"
              >
                <Settings size={22} />
              </button>
              {showSettings && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-dark-800 rounded-xl p-2 shadow-2xl border border-dark-700 min-w-[140px] max-h-[300px] overflow-y-auto">
                  {hlsLevels.length > 0 && (
                    <>
                      <p className="text-xs text-dark-400 px-2 py-1 font-medium">Calidad</p>
                      <button
                        onClick={() => handleQualityChange(-1)}
                        className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${currentLevel === -1 ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                      >
                        Auto
                      </button>
                      {hlsLevels.map(l => (
                        <button
                          key={l.index}
                          onClick={() => handleQualityChange(l.index)}
                          className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${currentLevel === l.index ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                        >
                          {l.label}
                        </button>
                      ))}
                      <div className="h-px bg-dark-700 my-1" />
                    </>
                  )}
                  <p className="text-xs text-dark-400 px-2 py-1 font-medium">Velocidad</p>
                  {speedLevels.map(rate => (
                    <button
                      key={rate}
                      onClick={() => handlePlaybackRate(rate)}
                      className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${playbackRate === rate ? 'bg-primary-600 text-white' : 'text-dark-300 hover:bg-dark-700'}`}
                    >
                      {rate}x{rate === 1 ? ' (Normal)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Reset velocidad */}
            {playbackRate !== 1 && (
              <button
                onClick={() => handlePlaybackRate(1)}
                className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
                title="Reset velocidad"
              >
                <RotateCcw size={22} />
              </button>
            )}

            {/* Separador */}
            <div className="w-px h-6 bg-dark-600 mx-1" />

            {/* Reproductor externo: VLC */}
            <button
              onClick={() => openInExternal('vlc')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Abrir en VLC"
            >
              <span className="text-xs font-bold">VLC</span>
            </button>

            {/* Reproductor externo: MPV */}
            <button
              onClick={() => openInExternal('mpv')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Abrir en MPV"
            >
              <span className="text-xs font-bold">MPV</span>
            </button>

            {/* Abrir en sistema */}
            <button
              onClick={() => openInExternal('system')}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Abrir en reproductor del sistema"
            >
              <ExternalLink size={22} />
            </button>

            {/* Separador */}
            <div className="w-px h-6 bg-dark-600 mx-1" />

            {/* Pantalla completa */}
            <button
              onClick={toggleFullscreen}
              className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Pantalla completa"
            >
              {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      )}

      {/* Controles para embed (solo externos, no en Android nativo) */}
      {isEmbed && !isNativeEmbed && !error && (
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

      {/* Popup "Siguiente episodio" — estilo Netflix */}
      {showNextEpPopup && nextEpisode && (
        <div className="absolute bottom-20 right-4 z-30 bg-dark-800/95 backdrop-blur rounded-xl p-4 shadow-2xl border border-dark-600 max-w-xs animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex gap-3">
            {nextEpisode.poster ? (
              <img
                src={nextEpisode.poster}
                alt={nextEpisode.name}
                className="flex-shrink-0 w-20 h-12 rounded object-cover"
              />
            ) : (
              <div className="flex-shrink-0 w-20 h-12 bg-primary-600 rounded flex items-center justify-center text-white text-xs font-bold">
                E{nextEpisode.episode}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-dark-400 text-xs">Siguiente episodio</p>
              <p className="text-white text-sm font-medium truncate">{nextEpisode.name}</p>
              <p className="text-dark-500 text-xs">
                {title?.split(' - ')[0]} · T{nextEpisode.season} · E{nextEpisode.episode}
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => {
                setShowNextEpPopup(false)
                if (nextEpTimerRef.current) {
                  clearInterval(nextEpTimerRef.current)
                  nextEpTimerRef.current = null
                }
                saveFinalProgress()
                if (onPlayNext) onPlayNext()
              }}
              className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <Play size={16} />
              Siguiente
            </button>
            <button
              onClick={() => {
                setShowNextEpPopup(false)
                if (nextEpTimerRef.current) {
                  clearInterval(nextEpTimerRef.current)
                  nextEpTimerRef.current = null
                }
              }}
              className="flex items-center gap-1.5 bg-dark-700 hover:bg-dark-600 text-dark-300 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <X size={16} />
              Cerrar
            </button>
            <span className="flex items-center text-dark-400 text-xs ml-auto">
              {nextEpCountdown}s
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
