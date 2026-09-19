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
      if (!isSeeking && now - lastUiTickRef.current > 1000) {
        lastUiTickRef.current = now
        setCurrentTime(videoEl.currentTime)
      }
      // Don't save progress for live TV channels (only for U7D programs, movies, series, etc.)
      if (meta && meta.type !== 'live' && meta.type !== 'channel' && now - lastSaveRef.current > 10000) {
        lastSaveRef.current = now
        const duration = videoEl.duration
        if (Number.isFinite(duration) && duration > 0) {
          updateProgress(meta.id, meta.type, videoEl.currentTime, duration, episodeInfo)
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
      if (meta && meta.type !== 'live' && meta.type !== 'channel' && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        updateProgress(meta.id, meta.type, videoEl.currentTime, videoEl.duration, episodeInfo)
      }
    }
  }, [videoRef, meta, startTime, isSeeking, updateProgress, setPlaying, setCurrentTime, setDuration, setSeekable, episodeInfo])
}
