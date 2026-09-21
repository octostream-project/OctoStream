import { useEffect, useState, lazy, Suspense } from 'react'
import { isAndroidNative } from '../utils/platform.js'
import { getSyncServer } from '../utils/remotePlay.js'
import { sanitizeRemoteUrl } from '../utils/sanitizeUrl.js'

const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }

const VideoPlayer = lazy(() => import('./VideoPlayer.jsx'))

// Receptor global de "Enviar a OctoStream": arranca el SyncServer al iniciar
// la app (Android) para que otros dispositivos puedan encontrarla por la LAN
// y abre el reproductor cuando llega un POST /play.
// Seguridad: /play, /stop y /sync solo aceptan IPs emparejadas. Una IP
// desconocida genera 'pairRequest' → diálogo de aceptación aquí.
export default function RemotePlayReceiver() {
  const [request, setRequest] = useState(null) // { url, title, type, mode }
  const [pairReq, setPairReq] = useState(null) // { ip, endpoint, data }

  useEffect(() => {
    if (!isAndroidNative()) return undefined
    let playHandle = null
    let stopHandle = null
    let pairHandle = null
    let cancelled = false
    ;(async () => {
      const SyncServer = await getSyncServer()
      if (!SyncServer || cancelled) return
      try { await SyncServer.start() } catch (e) {
        console.warn('[RemotePlay] server start:', e?.message)
      }
      playHandle = await SyncServer.addListener('playReceived', (ev) => {
        const url = sanitizeRemoteUrl(ev?.url)
        if (!url) return
        console.log('[RemotePlay] playReceived:', ev.title || urlHost(url))
        setRequest({
          url, title: ev.title || 'Stream remoto', type: ev.type || 'hls', mode: ev.mode || 'live',
          // 0 = campo ausente en el JSON: pasar undefined para que la búsqueda
          // de subtítulos no lo confunda con una serie (ttXXX:0:0 da 404).
          imdbId: ev.imdbId || '',
          season: ev.season > 0 ? ev.season : undefined,
          episode: ev.episode > 0 ? ev.episode : undefined,
        })
      })
      stopHandle = await SyncServer.addListener('stopReceived', () => {
        setRequest(null)
      })
      pairHandle = await SyncServer.addListener('pairRequest', (ev) => {
        if (!ev?.ip) return
        setPairReq(prev => prev || ev) // un diálogo a la vez
      })
    })()
    return () => {
      cancelled = true
      playHandle?.remove()
      stopHandle?.remove()
      pairHandle?.remove()
    }
  }, [])

  const answerPair = async (allow) => {
    const req = pairReq
    setPairReq(null)
    if (!req) return
    const SyncServer = await getSyncServer()
    if (!SyncServer) return
    // Emparejamiento por identidad (endpoint /pair): el token lo recoge el
    // emisor en su siguiente poll — no hay acción local posterior.
    if (req.endpoint === 'pair' && req.deviceId) {
      try { await SyncServer.answerPair({ deviceId: req.deviceId, allow }) } catch {}
      return
    }
    try { await SyncServer.allowDevice({ ip: req.ip, allow }) } catch {}
    if (!allow) return
    if (req.endpoint === 'play' && req.data) {
      try {
        const ev = JSON.parse(req.data)
        const url = sanitizeRemoteUrl(ev.url)
        if (url) {
          setRequest({
            url, title: ev.title || 'Stream remoto', type: ev.type || 'hls', mode: ev.mode || 'live',
            imdbId: ev.imdbId || '',
            season: ev.season > 0 ? ev.season : undefined,
            episode: ev.episode > 0 ? ev.episode : undefined,
          })
        }
      } catch {}
    } else if (req.endpoint === 'sync' && req.data) {
      // Push de datos autorizado tras aceptar — Sync.jsx lo recoge si está abierto.
      window.dispatchEvent(new CustomEvent('octostream:syncData', { detail: req.data }))
    }
  }

  const pairTitle = (() => {
    if (!pairReq) return ''
    if (pairReq.endpoint === 'play') {
      try { return JSON.parse(pairReq.data || '{}').title || '' } catch { return '' }
    }
    return ''
  })()

  return (
    <>
      {pairReq && (
        <div data-tv-modal className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
          <div className="bg-dark-800 border border-dark-600 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h2 className="text-lg font-semibold text-white mb-2">Solicitud de dispositivo</h2>
            <p className="text-dark-300 text-sm mb-1">
              <span className="font-medium text-primary-300">{pairReq.alias || pairReq.ip}</span>{' '}
              {pairReq.endpoint === 'play' ? 'quiere reproducir contenido aquí'
                : pairReq.endpoint === 'pair' ? 'quiere emparejarse con este dispositivo'
                : 'quiere sincronizar datos'}
            </p>
            {pairReq.fingerprint && (
              <p className="text-dark-400 text-xs mb-1">
                Código de verificación: <span className="font-mono text-primary-300">{pairReq.fingerprint}</span>
                {' '}— comprueba que coincide en la otra pantalla
              </p>
            )}
            {pairReq.alias && <p className="text-dark-500 text-xs mb-1 font-mono">{pairReq.ip}</p>}
            {pairTitle && <p className="text-white text-sm font-medium mb-1">«{pairTitle}»</p>}
            <p className="text-dark-500 text-xs mb-5">Si lo aceptas, el dispositivo quedará autorizado para próximas veces.</p>
            <div className="flex gap-3">
              <button
                data-tv-card
                tabIndex={0}
                autoFocus
                onClick={() => answerPair(false)}
                className="flex-1 px-4 py-3 rounded-lg bg-dark-700 text-dark-300 hover:bg-dark-600 focus:bg-dark-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                Rechazar
              </button>
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => answerPair(true)}
                className="flex-1 px-4 py-3 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-500 focus:bg-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                Aceptar
              </button>
            </div>
          </div>
        </div>
      )}
      {request && (
        <Suspense fallback={null}>
          <VideoPlayer
            mode={request.mode === 'vod' ? 'vod' : 'live'}
            stream={{ url: request.url, streamType: request.type, quality: '' }}
            title={request.title}
            meta={{
              id: `remote-${request.url}`, type: 'live', name: request.title,
              imdbId: request.imdbId, season: request.season, episode: request.episode,
            }}
            onClose={() => setRequest(null)}
          />
        </Suspense>
      )}
    </>
  )
}
