import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { Loader2, AlertCircle, Cast } from 'lucide-react'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'

export default function CastReceiver() {
  const videoRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const rawUrl = params.get('url')
    const t = params.get('title') || 'Reproduciendo en TV'

    if (!rawUrl) {
      setError('No se proporcionó URL de stream')
      setLoading(false)
      return
    }

    const url = sanitizeUrl(rawUrl)
    if (!url) {
      setError('URL de stream no válida')
      setLoading(false)
      return
    }

    setTitle(t)

    const videoEl = videoRef.current
    if (!videoEl) return

    const isHls = url.includes('.m3u8') || url.includes('hls')

    if (isHls && Hls.isSupported()) {
      const hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(videoEl)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false)
        videoEl.play()
      })
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError('Error al cargar stream HLS')
          setLoading(false)
        }
      })
    } else {
      videoEl.src = url
      videoEl.addEventListener('loadedmetadata', () => {
        setLoading(false)
        videoEl.play()
      })
      videoEl.addEventListener('error', () => {
        setError('Error al cargar el video')
        setLoading(false)
      })
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4 flex items-center gap-2 text-white">
        <Cast className="text-primary-500" size={24} />
        <span className="text-sm font-medium">{title}</span>
      </div>

      {loading && (
        <Loader2 className="animate-spin text-primary-500" size={48} />
      )}

      {error && (
        <div className="flex flex-col items-center gap-4">
          <AlertCircle className="text-red-400" size={48} />
          <p className="text-red-400 text-lg">{error}</p>
        </div>
      )}

      <video
        ref={videoRef}
        controls
        autoPlay
        className="w-full h-full"
        style={{ display: error ? 'none' : 'block' }}
      />
    </div>
  )
}
