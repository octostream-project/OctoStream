import { useEffect, useRef } from 'react'

// Sincroniza eventos del elemento video con el historial de reproducción.
// Mantenerlo separado evita mezclar ciclo de vida, controles y renderizado del player.
export function useVideoProgress({
  videoRef,
  meta,
  startTime,
  isSeeking,
  updateProgress,
  setPlaying,
  setCurrentTime,
  setDuration,
  setSeekable,
  episodeInfo = null,
}) {
  const lastSaveRef = useRef(0)
  const lastUiTickRef = useRef(0)

  // meta y episodeInfo llegan como objetos nuevos en cada render del padre
  // (Details construye meta inline). Usarlos como deps re-ejecuta el efecto
  // en CADA render → el cleanup llama updateProgress → set(watchHistory) →
  // el padre (suscrito a watchHistory) re-renderiza → efecto otra vez →
  // bucle infinito (React #185) cuando el <video> web existe y tiene
  // duración cargada. Refs + deps primitivas: el efecto solo se re-ejecuta
  // cuando cambia el contenido de verdad.
  const metaRef = useRef(meta)
  const epInfoRef = useRef(episodeInfo)
  useEffect(() => {
    metaRef.current = meta
    epInfoRef.current = episodeInfo
  })

  const metaId = meta?.id
  const metaType = meta?.type

  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return undefined

    const updateDuration = () => {
      const duration = videoEl.duration
      setDuration(Number.isFinite(duration) ? duration : 0)
      setSeekable(Number.isFinite(duration) && duration > 0)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTimeUpdate = () => {
      const now = Date.now()
      // timeupdate dispara ~4-15 Hz. Actualizar el estado a ~1 Hz: el seekbar
      // muestra segundos enteros, así que no se percibe diferencia y se evita
      // re-renderizar el player cada 250 ms en WebViews lentas.
      const m = metaRef.current
      if (!isSeeking && now - lastUiTickRef.current > 1000) {
        lastUiTickRef.current = now
        setCurrentTime(videoEl.currentTime)
      }
      // Don't save progress for live TV channels (only for U7D programs, movies, series, etc.)
      if (m && m.type !== 'live' && m.type !== 'channel' && now - lastSaveRef.current > 10000) {
        lastSaveRef.current = now
        const duration = videoEl.duration
        if (Number.isFinite(duration) && duration > 0) {
          updateProgress(m.id, m.type, videoEl.currentTime, duration, epInfoRef.current)
        }
      }
    }
    const onLoadedMetadata = () => {
      updateDuration()
      if (startTime > 0 && Number.isFinite(videoEl.duration) && startTime < videoEl.duration) {
        videoEl.currentTime = startTime
      }
    }

    videoEl.addEventListener('play', onPlay)
    videoEl.addEventListener('pause', onPause)
    videoEl.addEventListener('timeupdate', onTimeUpdate)
    videoEl.addEventListener('durationchange', updateDuration)
    videoEl.addEventListener('loadedmetadata', onLoadedMetadata)

    return () => {
      videoEl.removeEventListener('play', onPlay)
      videoEl.removeEventListener('pause', onPause)
      videoEl.removeEventListener('timeupdate', onTimeUpdate)
      videoEl.removeEventListener('durationchange', updateDuration)
      videoEl.removeEventListener('loadedmetadata', onLoadedMetadata)
      const m = metaRef.current
      if (m && m.type !== 'live' && m.type !== 'channel' && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        updateProgress(m.id, m.type, videoEl.currentTime, videoEl.duration, epInfoRef.current)
      }
    }
  }, [videoRef, metaId, metaType, startTime, isSeeking, updateProgress, setPlaying, setCurrentTime, setDuration, setSeekable])
}
