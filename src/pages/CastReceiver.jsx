import { useEffect, useState } from 'react'
import { AlertCircle, Cast } from 'lucide-react'
import { sanitizeRemoteUrl } from '../utils/sanitizeUrl.js'
import { inferStreamType } from '../utils/streamType.js'
import {
  playStream, stopPlayback, isExoPlayerAvailable, isDesktopPlayerAvailable,
} from '../utils/exoPlayer.js'
import { isElectron } from '../utils/platform.js'
import LogoLoader from '../components/LogoLoader.jsx'

// Receptor "Enviar a TV" — reproduce la URL en el player nativo del
// dispositivo (ExoPlayer en Android, mpv en escritorio). Sin player web
// interno: en un navegador solo muestra el aviso.
const castParams = () => new URLSearchParams(window.location.hash.split('?')[1] || '')

export default function CastReceiver() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [title] = useState(() => castParams().get('title') || 'Reproduciendo en TV')

  useEffect(() => {
    let cancelled = false
    const params = castParams()
    const rawUrl = params.get('url')
    const t = params.get('title') || 'Reproduciendo en TV'

    const fail = (msg) => {
      setError(msg)
      setLoading(false)
    }

    if (!rawUrl) return fail('No se proporcionó URL de stream')
    const url = sanitizeRemoteUrl(rawUrl)
    if (!url) return fail('URL de stream no válida')

    ;(async () => {
      const native = isExoPlayerAvailable() ||
        (isElectron() && await isDesktopPlayerAvailable().catch(() => false))
      if (cancelled) return
      if (!native) {
        fail('Esta página requiere la app OctoStream (Android o escritorio)')
        return
      }
      playStream({
        url,
        streamType: inferStreamType(url) || 'hls',
        title: t,
        mode: 'vod',
      }, (state) => {
        if (cancelled || !state) return
        if (state.state === 'ready' || state.state === 'playing') setLoading(false)
        if (state.state === 'error') fail(state.message || 'Error al cargar el video')
        if (state.state === 'closed' || state.state === 'ended') setLoading(false)
      }).catch(e => fail(e?.message || 'Error al iniciar el reproductor'))
    })()

    return () => {
      cancelled = true
      stopPlayback().catch(() => {})
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4 flex items-center gap-2 text-white">
        <Cast className="text-primary-500" size={24} />
        <span className="text-sm font-medium">{title}</span>
      </div>

      {loading && !error && (
        <LogoLoader size={80} />
      )}

      {error && (
        <div className="flex flex-col items-center gap-4 px-8">
          <AlertCircle className="text-red-400" size={48} />
          <p className="text-red-400 text-lg text-center">{error}</p>
        </div>
      )}
    </div>
  )
}
