import { useEffect, useState, useRef } from 'react'
import { RefreshCw, Wifi, Check, AlertCircle, Download, X, MonitorSmartphone, ListChecks } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { httpGetJson } from '../utils/httpClient.js'
import OctoLoader from './OctoLoader.jsx'
import Modal from './ui/Modal.jsx'
import { getSyncServer, getDiscovered, scanDevices, pullSync, pushSync, forgetTokens } from '../utils/remotePlay.js'
import { mergeRemoteData, localSyncPayload, SYNC_CATEGORIES, loadSyncCategories, saveSyncCategories } from '../utils/syncMerge.js'

// Panel de sincronización LAN (estilo LocalSend): los demás OctoStream de la
// red se descubren solos por UDP y aparecen aquí; al pulsar uno se elige
// Descargar (traer sus datos) o Enviar (mandar los nuestros). Embebido en el
// tab "Sincronizar" de Ajustes y en la página /sync.
export default function SyncDevices() {
  const favorites = useStore(s => s.favorites)
  const watchHistory = useStore(s => s.watchHistory)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  const [serverUrl, setServerUrl] = useState('')
  const [remoteIp, setRemoteIp] = useState('')
  const [deviceInfo, setDeviceInfo] = useState(null) // {deviceId, alias, fingerprint}
  // Dispositivo objetivo del diálogo de acción: {ip, url, deviceId, alias, fingerprint}
  const [actionDevice, setActionDevice] = useState(null)
  const [discovered, setDiscovered] = useState([])
  const [sweeping, setSweeping] = useState(false)
  const [status, setStatus] = useState('idle') // idle | connecting | syncing | done | error
  const [message, setMessage] = useState('')
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('octostream_last_sync') || '')
  const [pairedDevices, setPairedDevices] = useState([])
  const [confirmForget, setConfirmForget] = useState(false)
  const [syncCats, setSyncCats] = useState(loadSyncCategories)
  const syncListenerRef = useRef(null)

  // El merge es una UNIÓN por clave (lo remoto se junta con lo local, gana el
  // watchedAt más reciente) — nunca sustitución. Vive en syncMerge.js para
  // compartirlo con el receptor global (RemotePlayReceiver), que aplica los
  // pushes aunque este panel esté cerrado.
  const mergeData = (remoteData) => mergeRemoteData(remoteData)

  const toggleSyncCategory = (id) => {
    const next = syncCats.includes(id)
      ? syncCats.filter(c => c !== id)
      : [...syncCats, id]
    if (!next.length) return
    setSyncCats(saveSyncCategories(next))
  }

  const syncCountsText = (counts) => [
    counts.favs ? `+${counts.favs} favoritos` : '',
    counts.watchlist ? `+${counts.watchlist} mi lista` : '',
    counts.hist ? `+${counts.hist} historial` : '',
    counts.eps ? `+${counts.eps} episodios` : '',
    counts.settings ? `+${counts.settings} ajustes` : '',
  ].filter(Boolean).join(', ')

  const selectedCategoryLabels = () => SYNC_CATEGORIES
    .filter(c => syncCats.includes(c.id))
    .map(c => c.label)
    .join(' · ')

  const handleReceivedData = (dataStr) => {
    try {
      const remoteData = JSON.parse(dataStr)
      const counts = mergeData(remoteData)
      setStatus('done')
      setMessage(`Datos recibidos y unidos a los tuyos${syncCountsText(counts) ? ` (${syncCountsText(counts)})` : ''}`)
      const now = new Date().toLocaleString('es-ES')
      localStorage.setItem('octostream_last_sync', now)
      setLastSync(now)
    } catch (e) {
      console.error('[Sync] Parse error:', e.message)
    }
  }

  const refreshPaired = async () => {
    const SyncServer = await getSyncServer()
    if (!SyncServer) return
    try {
      const res = await SyncServer.getPairedDevices()
      setPairedDevices(res?.devices || [])
    } catch { /* lista opcional */ }
  }

  const updateLocalData = async () => {
    const SyncServer = await getSyncServer()
    if (!SyncServer) return
    const data = JSON.stringify(await localSyncPayload())
    try {
      await SyncServer.setLocalData({ data })
    } catch (e) {
      console.warn('[Sync] setLocalData failed:', e.message)
    }
  }

  // Barrido /24 como respaldo del anuncio UDP: muchos routers filtran
  // multicast/broadcast (aislamiento de AP, IGMP snooping, bandas 2.4/5GHz
  // separadas) y el descubrimiento solo-UDP se queda vacío para siempre.
  const runSweep = async () => {
    if (sweeping) return
    setSweeping(true)
    try {
      const list = await scanDevices()
      setDiscovered(prev => {
        const merged = new Map(prev.map(d => [d.deviceId || d.ip, d]))
        for (const d of list) merged.set(d.deviceId || d.ip, d)
        return [...merged.values()]
      })
    } catch { /* sweep opcional */ } finally {
      setSweeping(false)
    }
  }

  useEffect(() => {
    let active = true
    let discIv = null
    let sweepTimer = null
    let swept = false
    ;(async () => {
      const SyncServer = await getSyncServer()
      if (!SyncServer || !active) return
      try {
        const info = await SyncServer.start()
        if (!active) return
        setServerUrl(info.url)
        setDeviceInfo({ deviceId: info.deviceId, alias: info.alias, fingerprint: info.fingerprint })
        // Dispositivos anunciándose por UDP — lista viva.
        getDiscovered().then(setDiscovered)
        discIv = setInterval(() => getDiscovered().then(d => { if (active) setDiscovered(d) }), 4000)
        // Si en ~8s el UDP no encontró a nadie, barrer el /24 una vez.
        sweepTimer = setTimeout(() => {
          if (!active || swept) return
          swept = true
          setDiscovered(prev => {
            if (prev.length === 0) runSweep()
            return prev
          })
        }, 8000)
        updateLocalData()
        syncListenerRef.current = await SyncServer.addListener('syncDataReceived', (event) => {
          handleReceivedData(event.data)
        })
        refreshPaired()
      } catch (e) {
        console.error('[Sync] Server start failed:', e.message)
        setStatus('error')
        setMessage('No se pudo iniciar el servidor: ' + e.message)
      }
    })()
    return () => {
      active = false
      if (discIv) clearInterval(discIv)
      if (sweepTimer) clearTimeout(sweepTimer)
      if (syncListenerRef.current) syncListenerRef.current.remove()
    }
  }, [])

  useEffect(() => { updateLocalData() }, [favorites, watchHistory, watchedEpisodes, syncCats])

  // Push autorizado tras aceptar el diálogo de emparejamiento.
  useEffect(() => {
    const onSyncData = (e) => handleReceivedData(e.detail)
    window.addEventListener('octostream:syncData', onSyncData)
    return () => window.removeEventListener('octostream:syncData', onSyncData)
  }, [])

  // URL normalizada a partir de un dispositivo descubierto o una IP manual.
  const deviceUrl = (d) => d?.url || (remoteIp.startsWith('http') ? remoteIp : `http://${remoteIp}:8765`)

  // Abre el diálogo "Descargar o Enviar" para un dispositivo. Para IP manual
  // se hace ping antes: /ping devuelve deviceId/alias/fingerprint → la
  // conexión manual también puede emparejarse (antes no había identidad y el
  // /sync caía siempre en 403).
  const openDevice = async (d) => {
    if (d?.deviceId) {
      setActionDevice(d)
      return
    }
    const url = deviceUrl(d)
    setStatus('connecting')
    setMessage('Comprobando dispositivo...')
    try {
      const pong = await httpGetJson(`${url}/ping`, {}, AbortSignal.timeout(5000))
      if (pong?.ok) {
        setActionDevice({
          ip: d?.ip || remoteIp, url,
          deviceId: pong.deviceId || null,
          alias: pong.alias || pong.name || remoteIp,
          fingerprint: pong.fingerprint || '',
        })
        setStatus('idle')
        setMessage('')
      } else {
        throw new Error('sin respuesta')
      }
    } catch {
      setStatus('error')
      setMessage('No se pudo conectar con esa IP — comprueba que el otro OctoStream está abierto y en la misma red.')
    }
  }

  const finishOk = (msg) => {
    setStatus('done')
    setMessage(msg)
    const now = new Date().toLocaleString('es-ES')
    localStorage.setItem('octostream_last_sync', now)
    setLastSync(now)
    refreshPaired()
  }

  const failWith = (e, verb) => {
    setStatus('error')
    setMessage(/403/.test(e?.message || '')
      ? 'El otro dispositivo debe aceptar la conexión — pulsa "Aceptar" en su pantalla y reintenta.'
      : `Error al ${verb}: ` + e.message)
  }

  // Pull: trae los datos del otro dispositivo y los fusiona.
  const handlePull = async (dev) => {
    const url = deviceUrl(dev)
    setActionDevice(null)
    setStatus('connecting')
    setMessage(`Conectando con ${dev?.alias || 'el dispositivo'}...`)
    setStatus('syncing')
    setMessage('Descargando datos...')
    try {
      const remoteData = await pullSync(url, dev)
      if (remoteData === 'denied') {
        setStatus('error')
        setMessage('El otro dispositivo rechazó el emparejamiento.')
        return
      }
      const counts = mergeData(remoteData)
      finishOk(`Descargado y unido${syncCountsText(counts) ? ` (${syncCountsText(counts)})` : ' — sin cambios'}`)
    } catch (e) {
      failWith(e, 'descargar')
    }
  }

  // Sincronizar: manda nuestros datos Y descarga los suyos — ambos dispositivos
  // terminan con la unión (lo enviado + lo que ya tenía cada uno). El receptor
  // une lo nuestro con lo suyo al recibir el push (RemotePlayReceiver, aunque
  // su panel esté cerrado); nosotros unimos lo suyo al hacer pull.
  const handleSync = async (dev) => {
    const url = deviceUrl(dev)
    setActionDevice(null)
    setStatus('connecting')
    setMessage(`Conectando con ${dev?.alias || 'el dispositivo'}...`)
    try {
      setStatus('syncing')
      setMessage('Enviando tus datos...')
      const r = await pushSync(url, dev, await localSyncPayload(syncCats))
      if (r === 'denied') {
        setStatus('error')
        setMessage('El otro dispositivo rechazó el emparejamiento.')
        return
      }
      setMessage('Descargando los datos del otro dispositivo...')
      const remoteData = await pullSync(url, dev)
      if (remoteData === 'denied') {
        setStatus('error')
        setMessage('Datos enviados, pero el otro dispositivo no compartió los suyos.')
        return
      }
      const counts = mergeData(remoteData)
      finishOk(`Sincronizado: enviado y recibido${syncCountsText(counts) ? ` (${syncCountsText(counts)})` : ' — sin cambios'}`)
    } catch (e) {
      failWith(e, 'sincronizar')
    }
  }

  const busy = status === 'connecting' || status === 'syncing'

  return (
    <div className="space-y-4">
      {/* Este dispositivo */}
      <div className="card p-4">
        <h3 className="text-white font-semibold mb-2 flex items-center gap-2">
          <Wifi size={18} className="text-primary-400" />
          Este dispositivo
        </h3>
        {serverUrl ? (
          <div>
            <p className="text-white font-medium">{deviceInfo?.alias || 'OctoStream'}</p>
            <p className="text-xs text-dark-400 font-mono mt-0.5">
              {serverUrl}{deviceInfo?.fingerprint ? ` · ${deviceInfo.fingerprint}` : ''}
            </p>
            <p className="text-xs text-dark-500 mt-1">
              Visible en la red como «{deviceInfo?.alias || 'OctoStream'}» — los demás te encuentran solos
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <OctoLoader size={18} />
            <p className="text-dark-400 text-sm">Iniciando servidor...</p>
          </div>
        )}
      </div>

      {/* Secciones sincronizadas */}
      <div className="card p-4">
        <h3 className="text-white font-semibold mb-2 flex items-center gap-2">
          <ListChecks size={18} className="text-primary-400" />
          Qué se sincroniza
        </h3>
        <p className="text-xs text-dark-500 mb-3">
          Elige las secciones que se envían y se aplican al sincronizar.
        </p>
        <div className="flex flex-wrap gap-2">
          {SYNC_CATEGORIES.map(cat => (
            <label
              key={cat.id}
              data-tv-card
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSyncCategory(cat.id) } }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer select-none text-sm transition-colors ${syncCats.includes(cat.id) ? 'bg-primary-600/20 border-primary-500 text-white' : 'bg-dark-900 border-dark-700 text-dark-400'}`}
            >
              <input
                type="checkbox"
                tabIndex={-1}
                checked={syncCats.includes(cat.id)}
                onChange={() => toggleSyncCategory(cat.id)}
                className="accent-primary-500"
              />
              {cat.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-dark-500 mt-3">
          «Cuentas y claves» y «Ajustes» pueden incluir credenciales/API (AllDebrid, HDFull, WARP/VPS…): actívalas solo con dispositivos tuyos.
        </p>
      </div>

      {/* Dispositivos encontrados */}
      <div className="card p-4">
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <MonitorSmartphone size={18} className="text-primary-400" />
          Dispositivos en tu red
        </h3>
        {discovered.length > 0 ? (
          <div className="space-y-2">
            {discovered.map(d => (
              <button
                key={d.deviceId || d.ip}
                data-tv-card
                tabIndex={0}
                disabled={busy}
                onClick={() => openDevice(d)}
                className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors bg-dark-800 hover:bg-dark-700 border border-dark-700 disabled:opacity-50"
              >
                <Wifi size={18} className="text-primary-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">{d.alias || d.name}</p>
                  <p className="text-xs text-dark-400 font-mono">{d.ip}{d.fingerprint ? ` · ${d.fingerprint}` : ''}</p>
                </div>
                <RefreshCw size={16} className="text-dark-500 shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-dark-500 text-sm py-2">
            <OctoLoader size={16} />
            <p>{sweeping ? 'Buscando OctoStream en la red local…' : 'Buscando OctoStream en la red…'}</p>
            {!sweeping && (
              <button
                data-tv-card
                tabIndex={0}
                onClick={runSweep}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-dark-300 text-xs transition-colors"
              >
                <RefreshCw size={13} />
                Reintentar
              </button>
            )}
          </div>
        )}

        {/* IP manual */}
        <p className="text-xs text-dark-500 mt-4 mb-2">O por IP manual:</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={remoteIp}
            onChange={e => setRemoteIp(e.target.value)}
            placeholder="192.168.1.100:8765"
            className="flex-1 bg-dark-800 text-white px-3 py-2.5 rounded-lg border border-dark-700 focus:border-primary-500 focus:outline-none text-sm"
          />
          <button
            data-tv-card
            tabIndex={0}
            onClick={() => openDevice(null)}
            disabled={!remoteIp || busy}
            className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50"
          >
            Conectar
          </button>
        </div>
      </div>

      {/* Estado */}
      {busy && (
        <div className="flex items-center gap-3 text-primary-400">
          <OctoLoader size={20} />
          <p className="text-sm">{message}</p>
        </div>
      )}
      {status === 'done' && (
        <div className="flex items-center gap-3 text-green-400 bg-green-900/20 border border-green-700/30 rounded-lg p-3">
          <Check size={18} />
          <p className="text-sm text-green-300">{message}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-3 text-red-400 bg-red-900/20 border border-red-700/30 rounded-lg p-3">
          <AlertCircle size={18} />
          <p className="text-sm text-red-300">{message}</p>
        </div>
      )}
      {lastSync && (
        <p className="text-xs text-dark-500 text-center">Última sincronización: {lastSync}</p>
      )}

      {/* Autorizados */}
      {pairedDevices.length > 0 && (
        <div className="card p-4">
          <h3 className="text-white font-semibold mb-1 text-sm">Dispositivos autorizados</h3>
          <p className="text-xs text-dark-500 mb-2">Pueden enviarte contenido sin pedir permiso.</p>
          <ul className="space-y-1 mb-3">
            {pairedDevices.map((d, i) => (
              <li key={d.deviceId || d.ip || i} className="text-sm bg-dark-800 px-3 py-1.5 rounded-lg flex items-center justify-between gap-2">
                <span className="text-primary-300">{d.alias || d.ip || d.deviceId}</span>
                <span className="font-mono text-xs text-dark-500">{d.fingerprint || ''}{d.alias && d.ip ? ` · ${d.ip}` : ''}</span>
              </li>
            ))}
          </ul>
          <button
            data-tv-card
            tabIndex={0}
            onClick={() => setConfirmForget(true)}
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            Olvidar todos
          </button>
        </div>
      )}

      {/* Confirmación: olvidar todos los dispositivos autorizados */}
      {confirmForget && (
        <Modal onClose={() => setConfirmForget(false)} labelledBy="sync-forget-title">
          <h3 id="sync-forget-title" className="text-white font-semibold mb-2">Olvidar todos los dispositivos</h3>
          <p className="text-dark-400 text-sm mb-5">
            Se desemparejarán los {pairedDevices.length} dispositivos autorizados y tendrán que volver a pedir permiso para enviarte contenido.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmForget(false)} className="btn-ghost text-sm">
              Cancelar
            </button>
            <button
              onClick={async () => {
                setConfirmForget(false)
                const SyncServer = await getSyncServer()
                if (!SyncServer) return
                await SyncServer.forgetDevices()
                forgetTokens()
                setPairedDevices([])
              }}
              className="btn-primary text-sm bg-red-600 hover:bg-red-500"
            >
              Olvidar todos
            </button>
          </div>
        </Modal>
      )}

      {/* Diálogo de acción: Descargar o Enviar */}
      {actionDevice && (
        <Modal onClose={() => setActionDevice(null)} labelledBy="sync-action-title">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p id="sync-action-title" className="text-white font-bold text-lg">{actionDevice.alias || actionDevice.ip}</p>
                <p className="text-xs text-dark-400 font-mono mt-0.5">
                  {actionDevice.ip || actionDevice.url}{actionDevice.fingerprint ? ` · ${actionDevice.fingerprint}` : ''}
                </p>
              </div>
              <button onClick={() => setActionDevice(null)} className="btn-ghost p-1.5" data-tv-card tabIndex={0} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-dark-400 mb-1">¿Qué quieres hacer con este dispositivo?</p>
            <p className="text-xs text-dark-500 mb-4">Secciones activas: {selectedCategoryLabels()}</p>
            <div className="space-y-2">
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => handleSync(actionDevice)}
                className="w-full btn-primary px-4 py-3 flex items-center gap-3 justify-center"
              >
                <RefreshCw size={18} />
                <span className="text-left">
                  <span className="block font-medium">Sincronizar</span>
                  <span className="block text-xs opacity-70">Juntar los datos de los dos — nada se pierde</span>
                </span>
              </button>
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => handlePull(actionDevice)}
                className="w-full btn-secondary px-4 py-3 flex items-center gap-3 justify-center"
              >
                <Download size={18} />
                <span className="text-left">
                  <span className="block font-medium">Solo descargar</span>
                  <span className="block text-xs opacity-70">Traer sus datos aquí sin enviar los tuyos</span>
                </span>
              </button>
            </div>
            <p className="text-xs text-dark-500 mt-4 text-center">
              La primera vez, el otro dispositivo pedirá aceptar la conexión en su pantalla.
            </p>
        </Modal>
      )}
    </div>
  )
}
