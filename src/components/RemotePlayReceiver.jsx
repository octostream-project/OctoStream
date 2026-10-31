import { useEffect, useState, lazy, Suspense } from 'react'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { getSyncServer } from '../utils/remotePlay.js'
import Modal from './ui/Modal.jsx'
import { sanitizeRemoteUrl } from '../utils/sanitizeUrl.js'
import { mergeRemoteData, localSyncPayload } from '../utils/syncMerge.js'
import { isValidPartyId, isValidWatchPartyState } from '../utils/watchParty.js'

const urlHost = (u) => { try { return new URL(u).host } catch { return 'unknown' } }
const lastPartyEventAt = new Map()

// Push entrante → unión con lo local y re-publicar: el siguiente que nos
// descargue recibe ya los datos fusionados (y así se propaga la unión).
const applySync = (dataStr) => {
  try {
    const data = JSON.parse(dataStr)
    if (isValidWatchPartyState(data)) {
      const previousAt = lastPartyEventAt.get(data.partyId) || 0
      if (data.sentAt <= previousAt) return
      lastPartyEventAt.set(data.partyId, data.sentAt)
      if (lastPartyEventAt.size > 64) {
        const oldest = lastPartyEventAt.keys().next().value
        lastPartyEventAt.delete(oldest)
      }
      window.dispatchEvent(new CustomEvent('octostream:watch-party', { detail: data }))
      return
    }
    const counts = mergeRemoteData(data)
    if (!counts.favs && !counts.hist && !counts.eps && !counts.watchlist && !counts.settings) return
    console.log(`[Sync] merge recibido: +${counts.favs} favoritos, ${counts.watchlist} mi lista, ${counts.hist} historial, ${counts.eps} episodios, ${counts.settings} ajustes`)
    getSyncServer().then(async S => {
      const p = await localSyncPayload()
      S?.setLocalData({ data: JSON.stringify(p) }).catch(() => {})
    })
  } catch (e) {
    console.error('[Sync] Parse error:', e?.message)
  }
}

const VideoPlayer = lazy(() => import('./VideoPlayer.jsx'))

// Receptor global de "Enviar a OctoStream": arranca el SyncServer al iniciar
// la app para que otros dispositivos puedan encontrarla por la LAN
// y abre el reproductor cuando llega un POST /play.
// Seguridad: /play, /stop y /sync solo aceptan IPs emparejadas. Una IP
// desconocida genera 'pairRequest' → diálogo de aceptación aquí.
export default function RemotePlayReceiver() {
  const [request, setRequest] = useState(null) // { url, title, type, mode }
  const [pairReq, setPairReq] = useState(null) // { ip, endpoint, data }

  useEffect(() => {
    // Android: plugin nativo. Electron: servidor Node en el proceso
    // principal — el mismo protocolo, así que móvil y PC se ven entre sí.
    if (!isAndroidNative() && !isElectron()) return undefined
    let playHandle = null
    let stopHandle = null
    let pairHandle = null
    let syncHandle = null
    let cancelled = false
    ;(async () => {
      const SyncServer = await getSyncServer()
      if (!SyncServer || cancelled) return
      try { await SyncServer.start() } catch (e) {
        console.warn('[RemotePlay] server start:', e?.message)
      }
      syncHandle = await SyncServer.addListener('syncDataReceived', (ev) => {
        if (ev?.data) applySync(ev.data)
      })
      // Pushes que llegaron antes de enganchar el listener (ventana entre el
      // arranque del servidor y el mount del renderer) quedan en
      // receivedData — drenarlos aquí o se pierden para siempre.
      try {
        const pending = await SyncServer.getReceivedData()
        if (pending?.data && pending.data !== '{}') {
          applySync(pending.data)
          await SyncServer.clearReceivedData()
        }
      } catch { /* tolerado */ }
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
          partyId: isValidPartyId(ev.partyId) ? ev.partyId : '',
        })
      })
      stopHandle = await SyncServer.addListener('stopReceived', () => {
        setRequest(null)
      })
      pairHandle = await SyncServer.addListener('pairRequest', async (ev) => {
        if (!ev?.ip) return
        // "Confiar siempre": un deviceId ya emparejado se acepta sin
        // re-preguntar — el sync periódico no interrumpe con el diálogo.
        if (ev.deviceId) {
          try {
            const paired = await SyncServer.getPairedDevices?.()
            const known = (paired?.devices || paired || []).some(d => d.deviceId === ev.deviceId || d === ev.deviceId)
            if (known) {
              await SyncServer.answerPair({ deviceId: ev.deviceId, allow: true })
              return
            }
          } catch { /* fallthrough al diálogo */ }
        }
        setPairReq(prev => prev || ev) // un diálogo a la vez
      })
    })()
    return () => {
      cancelled = true
      playHandle?.remove()
      stopHandle?.remove()
      pairHandle?.remove()
      syncHandle?.remove()
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
      try { await SyncServer.answerPair({ deviceId: req.deviceId, allow }) } catch { /* tolerado */ }
      return
    }
    try { await SyncServer.allowDevice({ ip: req.ip, allow }) } catch { /* tolerado */ }
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
            partyId: isValidPartyId(ev.partyId) ? ev.partyId : '',
          })
        }
      } catch { /* tolerado */ }
    } else if (req.endpoint === 'sync' && req.data) {
      // Push autorizado tras aceptar → merge directo aquí (funciona aunque
      // el panel de sync esté cerrado).
      applySync(req.data)
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
        <Modal onClose={() => answerPair(false)} labelledBy="pair-title" closeOnBackdrop={false} z="z-[90]">
            <h2 id="pair-title" className="text-lg font-semibold text-white mb-2">Solicitud de dispositivo</h2>
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
        </Modal>
      )}
      {request && (
        <Suspense fallback={null}>
          <VideoPlayer
            mode={request.mode === 'vod' ? 'vod' : 'live'}
            stream={{ url: request.url, streamType: request.type, quality: '' }}
            title={request.title}
            partyId={request.partyId}
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
