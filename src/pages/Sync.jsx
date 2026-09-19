import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, Wifi, QrCode, ArrowLeft, Check, AlertCircle, Download, Upload } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { isAndroidNative } from '../utils/platform.js'
import { httpGetJson, httpPostJson } from '../utils/httpClient.js'
import OctoLoader from '../components/OctoLoader.jsx'

// Lazy import del plugin nativo (solo disponible en Android).
// Usa el mismo loader que remotePlay.js — require() no existe en el
// bundle ESM y dejaba SyncServer siempre a null.
import { getSyncServer } from '../utils/remotePlay.js'

export default function Sync() {
  const navigate = useNavigate()
  const favorites = useStore(s => s.favorites)
  const watchHistory = useStore(s => s.watchHistory)
  const watchedEpisodes = useStore(s => s.watchedEpisodes)
  const setFavorites = useStore(s => s.setFavorites)
  const setWatchHistory = useStore(s => s.setWatchHistory)
  const setWatchedEpisodes = useStore(s => s.setWatchedEpisodes)

  const [serverUrl, setServerUrl] = useState('')
  const [remoteIp, setRemoteIp] = useState('')
  const [status, setStatus] = useState('idle') // idle | connecting | connected | syncing | done | error
  const [message, setMessage] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('octostream_last_sync') || '')
  const [pairedDevices, setPairedDevices] = useState([])
  const syncListenerRef = useRef(null)

  const refreshPaired = async () => {
    const SyncServer = await getSyncServer()
    if (!SyncServer) return
    try {
      const res = await SyncServer.getPairedDevices()
      setPairedDevices(res?.devices || [])
    } catch {}
  }

  // Start sync server on mount (Android only)
  useEffect(() => {
    let active = true
    ;(async () => {
      const SyncServer = await getSyncServer()
      if (!SyncServer || !active) return
      try {
        const info = await SyncServer.start()
        if (!active) return
        setServerUrl(info.url)
        // Generate QR code
        try {
          const QRCode = (await import('qrcode')).default
          const dataUrl = await QRCode.toDataURL(info.url, { width: 256, margin: 1, color: { dark: '#ffffff', light: '#020617' } })
          setQrDataUrl(dataUrl)
        } catch (e) {
          console.warn('[Sync] QR generation failed:', e.message)
        }
        // Push local data to server so it can serve it
        updateLocalData()
        // Listen for incoming sync data
        syncListenerRef.current = await SyncServer.addListener('syncDataReceived', (event) => {
          console.log('[Sync] Data received from remote')
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
      if (syncListenerRef.current) syncListenerRef.current.remove()
    }
  }, [])

  // Update the server's local data whenever state changes
  const updateLocalData = async () => {
    const SyncServer = await getSyncServer()
    if (!SyncServer) return
    const data = JSON.stringify({ favorites, watchHistory, watchedEpisodes })
    try {
      await SyncServer.setLocalData({ data })
    } catch (e) {
      console.warn('[Sync] setLocalData failed:', e.message)
    }
  }

  useEffect(() => { updateLocalData() }, [favorites, watchHistory, watchedEpisodes])

  // Push autorizado tras aceptar el diálogo de emparejamiento (el SyncServer
  // lo entregó vía pairRequest y RemotePlayReceiver lo reenvía por window).
  useEffect(() => {
    const onSyncData = (e) => handleReceivedData(e.detail)
    window.addEventListener('octostream:syncData', onSyncData)
    return () => window.removeEventListener('octostream:syncData', onSyncData)
  }, [favorites, watchHistory, watchedEpisodes])

  // Ping a remote device to check if it's reachable
  const pingRemote = async (url) => {
    try {
      const data = await httpGetJson(`${url}/ping`, {}, AbortSignal.timeout(5000))
      return data?.ok === true
    } catch {
      return false
    }
  }

  // Pull data from remote device and merge
  const handlePull = async () => {
    if (!remoteIp) return
    const url = remoteIp.startsWith('http') ? remoteIp : `http://${remoteIp}:8765`
    setStatus('connecting')
    setMessage('Conectando...')
    const ok = await pingRemote(url)
    if (!ok) {
      setStatus('error')
      setMessage('No se pudo conectar. Verifica que la IP y el puerto sean correctos y que el otro dispositivo tenga OctoStream abierto.')
      return
    }
    setStatus('syncing')
    setMessage('Descargando datos...')
    try {
      const remoteData = await httpGetJson(`${url}/sync`, {}, AbortSignal.timeout(10000))
      mergeData(remoteData)
      setStatus('done')
      setMessage('Sincronización completada')
      const now = new Date().toLocaleString('es-ES')
      localStorage.setItem('octostream_last_sync', now)
      setLastSync(now)
    } catch (e) {
      setStatus('error')
      setMessage(/403/.test(e?.message || '')
        ? 'El otro dispositivo debe aceptar la conexión — pulsa "Aceptar" en su pantalla y reintenta.'
        : 'Error al descargar: ' + e.message)
    }
  }

  // Push local data to remote device
  const handlePush = async () => {
    if (!remoteIp) return
    const url = remoteIp.startsWith('http') ? remoteIp : `http://${remoteIp}:8765`
    setStatus('connecting')
    setMessage('Conectando...')
    const ok = await pingRemote(url)
    if (!ok) {
      setStatus('error')
      setMessage('No se pudo conectar. Verifica la IP y el puerto.')
      return
    }
    setStatus('syncing')
    setMessage('Enviando datos...')
    try {
      const localData = { favorites, watchHistory, watchedEpisodes }
      await httpPostJson(`${url}/sync`, JSON.stringify(localData), {
        'Content-Type': 'application/json',
      }, false, AbortSignal.timeout(10000))
      setStatus('done')
      setMessage('Datos enviados correctamente')
      const now = new Date().toLocaleString('es-ES')
      localStorage.setItem('octostream_last_sync', now)
      setLastSync(now)
    } catch (e) {
      setStatus('error')
      setMessage(/403/.test(e?.message || '')
        ? 'El otro dispositivo debe aceptar la conexión — pulsa "Aceptar" en su pantalla y reintenta.'
        : 'Error al enviar: ' + e.message)
    }
  }

  // Merge remote data into local state (newest wins by watchedAt timestamp)
  const mergeData = (remoteData) => {
    if (!remoteData) return
    // Merge favorites: union by id+type, keep newest
    if (Array.isArray(remoteData.favorites)) {
      const favMap = new Map()
      for (const f of favorites) favMap.set(`${f.id}-${f.type}`, f)
      for (const f of remoteData.favorites) {
        const key = `${f.id}-${f.type}`
        if (!favMap.has(key)) favMap.set(key, f)
      }
      setFavorites([...favMap.values()].slice(0, 500))
    }
    // Merge watch history: union by id+type, keep newest watchedAt
    if (Array.isArray(remoteData.watchHistory)) {
      const histMap = new Map()
      for (const h of watchHistory) histMap.set(`${h.id}-${h.type}`, h)
      for (const h of remoteData.watchHistory) {
        const key = `${h.id}-${h.type}`
        const existing = histMap.get(key)
        if (!existing || (h.watchedAt || 0) > (existing.watchedAt || 0)) {
          histMap.set(key, h)
        }
      }
      setWatchHistory([...histMap.values()].sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 50))
    }
    // Merge watched episodes: union by key (sin keys de prototipo — un peer
    // malicioso podría inyectar __proto__/constructor y polucionar el objeto)
    if (remoteData.watchedEpisodes && typeof remoteData.watchedEpisodes === 'object') {
      const merged = { ...watchedEpisodes }
      let count = Object.keys(merged).length
      for (const [key, val] of Object.entries(remoteData.watchedEpisodes)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        if (!merged[key] && count >= 5000) continue
        if (!merged[key]) count++
        if (!merged[key] || (val.watchedAt || 0) > (merged[key].watchedAt || 0)) {
          merged[key] = val
        }
      }
      setWatchedEpisodes(merged)
    }
  }

  // Handle data received from a remote push
  const handleReceivedData = (dataStr) => {
    try {
      const remoteData = JSON.parse(dataStr)
      mergeData(remoteData)
      setStatus('done')
      setMessage('Datos recibidos del otro dispositivo')
      const now = new Date().toLocaleString('es-ES')
      localStorage.setItem('octostream_last_sync', now)
      setLastSync(now)
    } catch (e) {
      console.error('[Sync] Parse error:', e.message)
    }
  }

  if (!isAndroidNative()) {
    return (
      <div className="p-4 lg:p-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/settings')} className="btn-ghost p-2">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-white">Sincronizar</h1>
        </div>
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
          <Wifi className="text-dark-600" size={64} />
          <p className="text-dark-400 text-lg">Sincronización solo disponible en Android</p>
          <p className="text-dark-500 text-sm">Instala la app en Android para sincronizar entre dispositivos</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/settings')} className="btn-ghost p-2" data-tv-card tabIndex={0}>
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-white">Sincronizar dispositivos</h1>
      </div>

      {/* This device info */}
      <div className="card p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Wifi size={20} className="text-primary-400" />
          Este dispositivo
        </h2>
        {serverUrl ? (
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="flex-1">
              <p className="text-sm text-dark-400 mb-1">IP del dispositivo:</p>
              <p className="text-lg font-mono text-primary-300 bg-dark-800 px-3 py-2 rounded-lg">{serverUrl}</p>
              <p className="text-xs text-dark-500 mt-2">
                Comparte esta IP con el otro dispositivo o escanea el QR
              </p>
            </div>
            {qrDataUrl && (
              <div className="flex-shrink-0">
                <img src={qrDataUrl} alt="QR Code" className="w-40 h-40 rounded-lg bg-dark-800 p-2" />
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <OctoLoader size={24} />
            <p className="text-dark-400">Iniciando servidor...</p>
          </div>
        )}
      </div>

      {/* Remote device connection */}
      <div className="card p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <QrCode size={20} className="text-primary-400" />
          Conectar con otro dispositivo
        </h2>
        <p className="text-sm text-dark-400 mb-3">
          Introduce la IP del otro dispositivo (ej: 192.168.1.100:8765)
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={remoteIp}
            onChange={e => setRemoteIp(e.target.value)}
            placeholder="192.168.1.100:8765"
            className="flex-1 bg-dark-800 text-white px-4 py-3 rounded-lg border border-dark-700 focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="flex gap-3 mt-4">
          <button
            data-tv-card
            tabIndex={0}
            onClick={handlePull}
            disabled={!remoteIp || status === 'connecting' || status === 'syncing'}
            className="btn-primary px-4 py-3 flex items-center gap-2 flex-1 justify-center disabled:opacity-50"
          >
            <Download size={18} />
            Descargar
          </button>
          <button
            data-tv-card
            tabIndex={0}
            onClick={handlePush}
            disabled={!remoteIp || status === 'connecting' || status === 'syncing'}
            className="btn-secondary px-4 py-3 flex items-center gap-2 flex-1 justify-center disabled:opacity-50"
          >
            <Upload size={18} />
            Enviar
          </button>
        </div>
      </div>

      {/* Status */}
      {status === 'connecting' && (
        <div className="flex items-center gap-3 text-primary-400 mb-4">
          <OctoLoader size={20} />
          <p className="text-sm">{message}</p>
        </div>
      )}
      {status === 'syncing' && (
        <div className="flex items-center gap-3 text-primary-400 mb-4">
          <RefreshCw size={20} className="animate-spin" />
          <p className="text-sm">{message}</p>
        </div>
      )}
      {status === 'done' && (
        <div className="flex items-center gap-3 text-green-400 mb-4 bg-green-900/20 border border-green-700/30 rounded-lg p-4">
          <Check size={20} />
          <p className="text-sm text-green-300">{message}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-3 text-red-400 mb-4 bg-red-900/20 border border-red-700/30 rounded-lg p-4">
          <AlertCircle size={20} />
          <p className="text-sm text-red-300">{message}</p>
        </div>
      )}

      {/* Last sync */}
      {lastSync && (
        <p className="text-xs text-dark-500 text-center">
          Última sincronización: {lastSync}
        </p>
      )}

      {/* Paired devices */}
      {pairedDevices.length > 0 && (
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-2">Dispositivos autorizados</h2>
          <p className="text-xs text-dark-500 mb-3">Estas IPs pueden enviarte contenido y sincronizar sin pedir permiso.</p>
          <ul className="space-y-1 mb-4">
            {pairedDevices.map(ip => (
              <li key={ip} className="font-mono text-sm text-primary-300 bg-dark-800 px-3 py-1.5 rounded-lg">{ip}</li>
            ))}
          </ul>
          <button
            data-tv-card
            tabIndex={0}
            onClick={async () => {
              const SyncServer = await getSyncServer()
              if (!SyncServer) return
              await SyncServer.forgetDevices()
              setPairedDevices([])
            }}
            className="btn-secondary px-4 py-2 text-sm"
          >
            Olvidar todos
          </button>
        </div>
      )}

      {/* Info */}
      <div className="mt-6 bg-dark-800/50 rounded-xl p-4 border border-dark-700/50 text-sm text-dark-400 space-y-2">
        <p className="font-medium text-dark-300">Como funciona:</p>
        <p>1. Ambos dispositivos deben estar en la misma red WiFi</p>
        <p className="text-dark-500">La primera vez, el otro dispositivo pedirá aceptar la conexión en pantalla.</p>
        <p>2. En la TV, abre esta página y anota la IP o escanea el QR</p>
        <p>3. En el móvil, entra la IP de la TV y pulsa "Descargar" para recibir su historial</p>
        <p>4. O pulsa "Enviar" para mandar el historial del móvil a la TV</p>
        <p className="text-dark-500 mt-2">Se sincroniza: historial, favoritos y episodios vistos</p>
      </div>
    </div>
  )
}
