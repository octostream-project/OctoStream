import { useEffect, useRef, useState } from 'react'
import { Tv, Wifi, Copy, Check, X, MonitorSmartphone, ScanSearch, ChevronDown, ChevronUp, ScreenShare } from 'lucide-react'
import CastIcon from './CastIcon.jsx'
import { scanDevices, sendPlay, pingDevice, getLastDevice, getDiscovered } from '../utils/remotePlay.js'
import { isAndroidNative } from '../utils/platform.js'
import { openMiracast, openDlna } from '../utils/exoPlayer.js'

const itemCls =
  'w-full flex items-center gap-3 p-3 rounded-xl hover:bg-dark-700/80 focus:bg-primary-600/40 focus:outline-none focus:ring-2 focus:ring-primary-500 transition-colors text-left'

// Menú "Enviar a" compartido por el player web y el nativo.
// Incluye Chromecast, envío a otro OctoStream en la LAN, abrir en el
// navegador de la TV y copiar la URL del stream.
export default function CastMenu({
  stream, title, mode = 'live', meta, className = '',
  onRequestCast, onRemoteSent, onClose,
  copiedUrl, onCopyUrl, onOpenTvBrowser,
}) {
  const [octoOpen, setOctoOpen] = useState(false)
  const [devices, setDevices] = useState(null) // null = sin escanear
  const [scanning, setScanning] = useState(false)
  const [scanPct, setScanPct] = useState(0)
  const [manualIp, setManualIp] = useState('')
  const [sendState, setSendState] = useState(null) // null | 'sending' | 'sent' | 'error'
  const [sendTarget, setSendTarget] = useState(null)
  const [dlnaState, setDlnaState] = useState(null) // null | 'sending' | 'sent' | 'nodev' | 'error'
  const [miraState, setMiraState] = useState(null) // null | 'scanning' | 'connected' | 'peers' | 'nodev'
  const [lastDevice, setLastDevice] = useState(() => getLastDevice())
  const scanAbort = useRef(false)

  useEffect(() => () => { scanAbort.current = true }, [])

  const payload = () => ({
    url: stream?.url || '',
    title: title || '',
    type: stream?.streamType || 'hls',
    mode,
    imdbId: meta?.imdbId || undefined,
    season: meta?.season || undefined,
    episode: meta?.episode || undefined,
  })

  const handleScan = async () => {
    setScanning(true)
    setDevices([])
    setScanPct(0)
    scanAbort.current = false
    try {
      // UDP broadcast: los que se anuncian aparecen al instante; el barrido
      // del /24 sigue después para versiones viejas sin anuncio.
      const udp = await getDiscovered()
      if (!scanAbort.current && udp.length) setDevices(udp)
      const found = await scanDevices((done, total) => {
        if (!scanAbort.current) setScanPct(Math.round((done / total) * 100))
      })
      if (!scanAbort.current) setDevices(found)
    } finally {
      if (!scanAbort.current) setScanning(false)
    }
  }

  const handleSend = async (device, force = false) => {
    // force: el flujo manual ya puso 'sending' durante el ping previo — sin
    // él el guard cortaba el envío y la IP manual nunca enviaba nada.
    if (!force && sendState === 'sending') return
    setSendState('sending')
    setSendTarget(device)
    try {
      const ok = await sendPlay(device.url || `http://${device.ip}:8765`, payload(), device)
      if (ok === 'pair') { setSendState('pair'); return }
      if (ok === 'denied') { setSendState('denied'); return }
      if (!ok) throw new Error('respuesta inválida')
      setSendState('sent')
      setLastDevice(device)
      onRemoteSent?.(device)
    } catch (e) {
      console.warn('[Cast] envío a OctoStream falló:', e?.message)
      setSendState('error')
    }
  }

  const handleSendManual = async (e) => {
    e?.preventDefault?.()
    const ip = manualIp.trim()
    if (!ip) return
    const url = ip.startsWith('http') ? ip : `http://${ip}:8765`
    setSendState('sending')
    setSendTarget({ ip, url })
    const ping = await pingDevice(url)
    if (!ping) {
      setSendState('error')
      return
    }
    await handleSend({ ip, url, name: ping.alias || ping.model || 'OctoStream', deviceId: ping.deviceId, fingerprint: ping.fingerprint, alias: ping.alias }, true)
  }

  return (
    <div className={`bg-dark-800/95 backdrop-blur-md rounded-2xl p-3 shadow-2xl border border-dark-600 w-80 z-30 ${className}`}>
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <CastIcon size={18} className="text-primary-400" />
          Enviar a
        </h3>
        <button onClick={onClose} className="text-dark-400 hover:text-white focus:text-white focus:outline-none p-1 rounded-lg">
          <X size={18} />
        </button>
      </div>

      <div className="space-y-1">
        <button onClick={() => { onRequestCast?.() }} className={itemCls}>
          <CastIcon size={20} className="text-primary-400 shrink-0" />
          <div>
            <p className="text-white text-sm font-medium">Chromecast / Google TV</p>
            <p className="text-xs text-dark-400">Buscar dispositivos Cast cercanos</p>
          </div>
        </button>

        {isAndroidNative() && (
          <button
            onClick={async () => {
              if (dlnaState === 'sending') return
              setDlnaState('sending')
              try {
                const r = await openDlna(stream?.url, title)
                setDlnaState(r?.sent ? 'sent' : 'nodev')
              } catch { setDlnaState('error') }
            }}
            className={itemCls}
          >
            <Tv size={20} className="text-primary-400 shrink-0" />
            <div>
              <p className="text-white text-sm font-medium">
                {dlnaState === 'sending' ? 'Buscando TV…' : 'Enviar a TV (DLNA)'}
              </p>
              <p className="text-xs text-dark-400">
                {dlnaState === 'sent' ? 'Enviado a la TV'
                  : dlnaState === 'nodev' ? 'No se encontró ninguna TV en la red'
                  : dlnaState === 'error' ? 'La TV rechazó el envío'
                  : 'Smart TV compatible por WiFi'}
              </p>
            </div>
          </button>
        )}

        {isAndroidNative() && (
          <button
            onClick={async () => {
              if (miraState === 'scanning') return
              setMiraState('scanning')
              try {
                const r = await openMiracast()
                if (r?.connected) setMiraState('connected')
                else setMiraState(r?.peers?.length ? 'peers' : 'nodev')
              } catch { setMiraState('nodev') }
            }}
            className={itemCls}
          >
            <ScreenShare size={20} className="text-primary-400 shrink-0" />
            <div>
              <p className="text-white text-sm font-medium">
                {miraState === 'scanning' ? 'Buscando pantallas…' : 'Duplicar pantalla (Miracast)'}
              </p>
              <p className="text-xs text-dark-400">
                {miraState === 'connected' ? 'Conectando con la pantalla…'
                  : miraState === 'peers' ? 'Pantalla detectada — selecciónala en los ajustes'
                  : miraState === 'nodev' ? 'Sin Miracast en la TV — usa DLNA o Chromecast'
                  : 'Busca pantallas WiFi Direct cercanas'}
              </p>
            </div>
          </button>
        )}

        {/* Enviar a otro OctoStream en la misma red */}
        <button onClick={() => setOctoOpen(o => !o)} className={itemCls}>
          <MonitorSmartphone size={20} className="text-primary-400 shrink-0" />
          <div className="flex-1">
            <p className="text-white text-sm font-medium">Otro OctoStream (misma red)</p>
            <p className="text-xs text-dark-400">Reproduce en otra TV/móvil con la app</p>
          </div>
          {octoOpen ? <ChevronUp size={16} className="text-dark-400" /> : <ChevronDown size={16} className="text-dark-400" />}
        </button>

        {octoOpen && (
          <div className="ml-2 pl-3 border-l-2 border-dark-600 space-y-1">
            {sendState === 'sent' && sendTarget && (
              <p className="text-xs text-green-400 px-3 py-1 flex items-center gap-1">
                <Check size={12} /> Enviado a {sendTarget.name || sendTarget.ip}
              </p>
            )}
            {sendState === 'pair' && (
              <p className="text-xs text-amber-400 px-3 py-1">Acepta la solicitud en la pantalla del otro dispositivo y reintenta</p>
            )}
            {sendState === 'denied' && (
              <p className="text-xs text-red-400 px-3 py-1">{sendTarget?.name || 'El dispositivo'} rechazó el emparejamiento</p>
            )}
            {sendState === 'error' && (
              <p className="text-xs text-red-400 px-3 py-1">No se pudo enviar. ¿Está OctoStream abierto en el otro dispositivo?</p>
            )}

            {lastDevice && (
              <button onClick={() => handleSend(lastDevice)} className={itemCls} disabled={sendState === 'sending'}>
                <MonitorSmartphone size={18} className="text-green-400 shrink-0" />
                <div>
                  <p className="text-white text-sm font-medium">{lastDevice.name || 'OctoStream'}</p>
                  <p className="text-xs text-dark-400">{lastDevice.ip} — último usado</p>
                </div>
              </button>
            )}

            {devices?.map(d => (
              <button key={d.ip} onClick={() => handleSend(d)} className={itemCls} disabled={sendState === 'sending'}>
                <MonitorSmartphone size={18} className="text-primary-300 shrink-0" />
                <div>
                  <p className="text-white text-sm font-medium">{d.name}</p>
                  <p className="text-xs text-dark-400">{d.ip}</p>
                </div>
              </button>
            ))}
            {devices?.length === 0 && !scanning && (
              <p className="text-xs text-dark-400 px-3 py-2">No se encontraron dispositivos con OctoStream abierto</p>
            )}

            <button onClick={handleScan} className={itemCls} disabled={scanning}>
              <ScanSearch size={18} className={`text-primary-400 shrink-0 ${scanning ? 'animate-pulse' : ''}`} />
              <p className="text-white text-sm font-medium">
                {scanning ? `Buscando… ${scanPct}%` : 'Buscar dispositivos en la red'}
              </p>
            </button>

            <form onSubmit={handleSendManual} className="flex items-center gap-2 px-1 py-1">
              <input
                type="text"
                value={manualIp}
                onChange={e => setManualIp(e.target.value)}
                placeholder="IP manual (192.168.…)"
                className="flex-1 min-w-0 bg-dark-900 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white placeholder-dark-500 focus:border-primary-500 focus:outline-none"
              />
              <button type="submit" className="btn-primary px-3 py-2 text-xs rounded-lg shrink-0">
                Enviar
              </button>
            </form>
          </div>
        )}

        <button onClick={onOpenTvBrowser} className={itemCls}>
          <Tv size={20} className="text-primary-400 shrink-0" />
          <div>
            <p className="text-white text-sm font-medium">Abrir en navegador de TV</p>
            <p className="text-xs text-dark-400">URL para abrir en la TV directamente</p>
          </div>
        </button>

        <button onClick={onCopyUrl} className={itemCls}>
          {copiedUrl
            ? <Check size={20} className="text-green-400 shrink-0" />
            : <Copy size={20} className="text-primary-400 shrink-0" />}
          <div>
            <p className="text-white text-sm font-medium">{copiedUrl ? 'URL copiada' : 'Copiar URL del stream'}</p>
            <p className="text-xs text-dark-400">Pégala en cualquier reproductor</p>
          </div>
        </button>

        <p className="text-xs text-dark-500 px-3 pt-2 flex items-center gap-1 border-t border-dark-700 mt-2">
          <Wifi size={12} />
          Ambos dispositivos deben estar en la misma red WiFi
        </p>
      </div>
    </div>
  )
}
