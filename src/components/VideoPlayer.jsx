import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { openSubtitlesPlugin } from '../plugins/builtIn/index.js'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'
import {
  X, Maximize, Minimize, Loader2, Volume2, VolumeX, Volume1,
  Monitor, Captions, Settings, Download, ExternalLink,
  Subtitles, ChevronUp, ChevronDown, RotateCcw, Gauge,
  Cast, Tv, Smartphone, Wifi, Copy, Check,
} from 'lucide-react'

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/^\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export default function VideoPlayer({ stream, title, onClose, meta }) {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const hlsRef = useRef(null)
  const gainNodeRef = useRef(null)
  const audioCtxRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
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
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [hlsLevels, setHlsLevels] = useState([])
  const [currentLevel, setCurrentLevel] = useState(-1) // -1 = auto
  const [hlsSubtitles, setHlsSubtitles] = useState([])
  const [activeHlsSub, setActiveHlsSub] = useState(-1) // -1 = off
  const castSessionRef = useRef(null)

  useEffect(() => {
    if (!stream) return

    setLoading(true)
    setError(null)

    if (stream.streamType === 'embed' || stream.streamType === 'iframe') {
      setLoading(false)
      return
    }

    const videoEl = videoRef.current
    if (!videoEl) return

    // In Electron, route stream through local proxy to avoid CORS/SSL issues
    const proxyUrl = window.optopus?.proxyUrl
    const isElectron = !!window.optopus?.isElectron
    let streamUrl = stream.url
    if (proxyUrl && isElectron && /^https?:\/\//.test(streamUrl) && !streamUrl.includes('127.0.0.1')) {
      streamUrl = proxyUrl + encodeURIComponent(streamUrl)
    }

    // Timeout: if manifest doesn't load in 15s, show error
    const loadTimeout = setTimeout(() => {
      setLoading(prev => {
        if (prev) {
          setError('Timeout: no se pudo cargar el stream en 15 segundos. Puede que el canal no esté disponible o requiera CORS.')
        }
        return false
      })
    }, 15000)

    videoEl.disableRemotePlayback = true

    if (stream.streamType === 'hls') {
      if (Hls.isSupported()) {
        const hlsConfig = {
          // Enable verbose logging for debugging
          debug: false,
          // Start loading immediately
          startLoading: true,
        }
        // When NOT using the proxy, pass custom headers
        if (stream.headers && !streamUrl.includes('127.0.0.1')) {
          hlsConfig.xhrSetup = (xhr) => {
            for (const [key, val] of Object.entries(stream.headers)) {
              try { xhr.setRequestHeader(key, val) } catch {}
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
          setHlsSubtitles(hls.subtitleTracks.map((t, i) => ({
            index: i,
            name: t.name || t.lang || `Track ${i + 1}`,
            lang: t.lang,
          })))
          // Disable all subtitles by default
          hls.subtitleTrack = -1
          setActiveHlsSub(-1)
          // Also disable any native text tracks
          for (let i = 0; i < videoEl.textTracks.length; i++) {
            videoEl.textTracks[i].mode = 'disabled'
          }
          setLoading(false)
          videoEl.play().catch(e => console.warn('[Player] play() failed:', e))
        })
        hls.on(Hls.Events.ERROR, (_, data) => {
          console.error('[Player] HLS error:', data.type, data.details, data.fatal ? '(FATAL)' : '(non-fatal)')
          if (data.fatal) {
            const reason = data.details || data.type || 'unknown'
            setError(`Error al cargar el stream HLS: ${reason}`)
            setLoading(false)
          }
        })
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = streamUrl
        videoEl.addEventListener('loadedmetadata', () => setLoading(false))
        videoEl.addEventListener('error', () => {
          setError('Error al cargar el stream')
          setLoading(false)
        })
      }
    } else if (stream.streamType === 'mp4') {
      videoEl.src = streamUrl
      videoEl.addEventListener('loadedmetadata', () => setLoading(false))
      videoEl.addEventListener('error', () => {
        setError('Error al cargar el video')
        setLoading(false)
      })
    } else {
      videoEl.src = streamUrl
      videoEl.addEventListener('loadedmetadata', () => setLoading(false))
    }

    return () => {
      clearTimeout(loadTimeout)
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      // Clean up video element
      videoEl.removeAttribute('src')
      videoEl.load()
    }
  }, [stream])

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  const isEmbed = stream && (stream.streamType === 'embed' || stream.streamType === 'iframe')

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
    if (hlsRef.current) {
      hlsRef.current.subtitleTrack = subIndex
      setActiveHlsSub(subIndex)
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
    if (!meta && !title) return
    setSubsLoading(true)
    setShowSubsPanel(true)
    try {
      const query = meta?.name || title
      const results = await openSubtitlesPlugin.searchSubtitles({
        query,
        languages: 'es,en',
      })
      setSubtitles(results)
    } catch (e) {
      setSubtitles([])
    }
    setSubsLoading(false)
  }

  const applySubtitle = async (sub) => {
    try {
      const srtContent = await openSubtitlesPlugin.downloadSubtitle(sub.downloadUrl)
      const vttContent = srtToVtt(srtContent)
      const blob = new Blob([vttContent], { type: 'text/vtt' })
      const blobUrl = URL.createObjectURL(blob)

      const videoEl = videoRef.current
      if (!videoEl) return

      let track = videoEl.querySelector('track[data-subs]')
      if (track) track.remove()

      track = document.createElement('track')
      track.kind = 'subtitles'
      track.label = sub.language
      track.srclang = sub.language.split('-')[0]
      track.src = blobUrl
      track.default = true
      track.setAttribute('data-subs', '1')
      videoEl.appendChild(track)

      videoEl.textTracks[0].mode = 'showing'
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
        const mediaInfo = new window.chrome.cast.media.MediaInfo(
          stream.url,
          stream.streamType === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4'
        )
        mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata()
        mediaInfo.metadata.title = title
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

  return (
    <div
      ref={containerRef}
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
          {activeSubtitle && (
            <span className="ml-2 text-xs bg-green-600 px-2 py-0.5 rounded">
              SUB: {activeSubtitle.language}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          {/* Enviar a TV / Cast */}
          <div className="relative">
            <button
              onClick={() => casting ? stopCasting() : requestCastSession()}
              className={`btn-ghost p-2 ${casting ? 'text-primary-400' : ''}`}
              title={casting ? `Enviando a ${castDevice} - Click para detener` : 'Enviar a TV'}
            >
              {casting ? <Cast size={22} className="fill-primary-400 animate-pulse" /> : <Cast size={22} />}
            </button>
            {casting && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
            )}
          </div>

          {/* Menú de Cast */}
          {showCastMenu && (
            <div className="absolute top-14 right-20 bg-dark-800 rounded-xl p-3 shadow-2xl border border-dark-700 w-72 z-30">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-medium text-sm flex items-center gap-2">
                  <Cast size={16} className="text-primary-500" />
                  Enviar a TV
                </h3>
                <button onClick={() => setShowCastMenu(false)} className="text-dark-400 hover:text-white">
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-1">
                <button
                  onClick={() => { requestCastSession() }}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-dark-700 transition-colors text-left"
                >
                  <Cast size={18} className="text-primary-400" />
                  <div>
                    <p className="text-white text-sm font-medium">Chromecast / Google TV</p>
                    <p className="text-xs text-dark-500">Buscar dispositivos ChromeCast</p>
                  </div>
                </button>

                <button
                  onClick={openOnTvBrowser}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-dark-700 transition-colors text-left"
                >
                  <Tv size={18} className="text-primary-400" />
                  <div>
                    <p className="text-white text-sm font-medium">Abrir en navegador de TV</p>
                    <p className="text-xs text-dark-500">URL para abrir en la TV directamente</p>
                  </div>
                </button>

                <button
                  onClick={copyStreamUrl}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-dark-700 transition-colors text-left"
                >
                  {copiedUrl ? <Check size={18} className="text-green-400" /> : <Copy size={18} className="text-primary-400" />}
                  <div>
                    <p className="text-white text-sm font-medium">
                      {copiedUrl ? 'URL copiada' : 'Copiar URL del stream'}
                    </p>
                    <p className="text-xs text-dark-500">Pégala en tu TV o DLNA app</p>
                  </div>
                </button>

                <div className="pt-2 mt-2 border-t border-dark-700">
                  <p className="text-xs text-dark-500 px-2">
                    <Wifi size={12} className="inline mr-1" />
                    Asegúrate de que tu TV y este dispositivo estén en la misma red WiFi
                  </p>
                </div>
              </div>
            </div>
          )}

          <button onClick={toggleFullscreen} className="btn-ghost p-2" title="Pantalla completa">
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
          <button onClick={onClose} className="btn-ghost p-2" title="Cerrar">
            <X size={24} />
          </button>
        </div>
      </div>

      {loading && !isEmbed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin text-primary-500" size={48} />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p className="text-red-400 text-lg">{error}</p>
          <button onClick={onClose} className="btn-primary">Cerrar</button>
        </div>
      )}

      {isEmbed && (
        <iframe
          src={sanitizeUrl(stream.url)}
          className="w-full h-full"
          allowFullScreen
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      )}

      {!isEmbed && !error && (
        <div className="w-full h-full flex items-center justify-center">
          <video
            ref={videoRef}
            className="w-full h-full"
            autoPlay
            playsInline
          />
        </div>
      )}

      {/* Barra inferior de iconos sueltos */}
      {!isEmbed && !error && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent pb-4 pt-12">
          <div className="flex items-center justify-center gap-1 sm:gap-2">

            {/* Volumen */}
            <div
              className="relative"
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={() => setShowVolumeSlider(false)}
            >
              <button
                onClick={toggleMute}
                className="text-white p-2 hover:bg-white/10 rounded-lg transition-colors"
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
                className={`p-2 rounded-lg transition-colors ${activeSubtitle || activeHlsSub >= 0 ? 'text-primary-400 bg-primary-600/20' : 'text-white hover:bg-white/10'}`}
                title="Subtítulos"
              >
                <Captions size={22} />
              </button>
              {(activeSubtitle || activeHlsSub >= 0) && (
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

                  {/* HLS subtitle tracks */}
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
                        <Loader2 className="animate-spin text-primary-500" size={20} />
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

      {/* Controles para embed (solo externos) */}
      {isEmbed && !error && (
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
