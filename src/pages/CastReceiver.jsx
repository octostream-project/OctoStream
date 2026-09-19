import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Cast } from 'lucide-react'
import { sanitizeRemoteUrl } from '../utils/sanitizeUrl.js'
import { loadHls } from '../utils/loadPlayerLibs.js'
import LogoLoader from '../components/LogoLoader.jsx'

export default function CastReceiver() {
  const videoRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    let hls
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const rawUrl = params.get('url')
    const t = params.get('title') || 'Reproduciendo en TV'

    if (!rawUrl) {
      setError('No se proporcionó URL de stream')
      setLoading(false)
      return
    }

    const url = sanitizeRemoteUrl(rawUrl)
    if (!url) {
      setError('URL de stream no válida')
      setLoading(false)
      return
    }

    setTitle(t)

    const videoEl = videoRef.current
    if (!videoEl) return

    const isHls = url.includes('.m3u8') || url.includes('hls')
    let cancelled = false

    const onLoaded = () => {
      setLoading(false)
      videoEl.play().catch(() => {})
    }
    const onError = () => {
      setError('Error al cargar el video')
      setLoading(false)
    }
    const playDirect = () => {
      videoEl.src = url
      videoEl.addEventListener('loadedmetadata', onLoaded)
      videoEl.addEventListener('error', onError)
    }

    const init = async () => {
      if (isHls) {
        const Hls = await loadHls()
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls()
          hls.loadSource(url)
          hls.attachMedia(videoEl)
          hls.on(Hls.Events.MANIFEST_PARSED, onLoaded)
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              setError('Error al cargar stream HLS')
              setLoading(false)
            }
          })
        } else {
          playDirect()
        }
      } else {
        playDirect()
      }
    }
    init()

    return () => {
      cancelled = true
      videoEl.removeEventListener('loadedmetadata', onLoaded)
      videoEl.removeEventListener('error', onError)
      if (hls) hls.destroy()
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4 flex items-center gap-2 text-white">
        <Cast className="text-primary-500" size={24} />
        <span className="text-sm font-medium">{title}</span>
      </div>

      {loading && (
        <LogoLoader size={80} />
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
