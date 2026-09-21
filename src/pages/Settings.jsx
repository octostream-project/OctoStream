import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings as SettingsIcon, Key, Check, ExternalLink, AlertCircle, Film, Captions, Monitor, Play, ArrowUp, ArrowDown, Languages, Download, Globe, Image, RefreshCw, Puzzle, ChevronRight, Magnet } from 'lucide-react'
import { invalidateImageQuality } from '../plugins/builtIn/tmdb.js'
import { getPin as adGetPin, checkPin as adCheckPin } from '../plugins/bundled/alldebrid.js'
import OctoLoader from '../components/OctoLoader.jsx'
import { CloudProxy } from '@octostream/cloud-proxy'
import { refreshWarpStatus } from '../utils/warpStatus.js'
import { getUiScale, setUiScale } from '../utils/uiScale.js'

const LANG_LABELS = {
  ESP: 'Castellano',
  LAT: 'Latino',
  SUB: 'Vose / Subtitulado',
  ENG: 'Inglés',
}

function getDefaultLangPriority() {
  try {
    const saved = JSON.parse(localStorage.getItem('octostream_lang_priority') || '[]')
    if (Array.isArray(saved) && saved.length === 4) return saved
  } catch {}
  return ['ESP', 'LAT', 'SUB', 'ENG']
}

const TABS = [
  { id: 'autoplay', name: 'Autoplay', icon: Play },
  { id: 'apis', name: 'APIs', icon: Key },
  { id: 'debrid', name: 'Debrid', icon: Download },
  { id: 'red', name: 'Red', icon: Globe },
  { id: 'sync', name: 'Sincronizar', icon: RefreshCw },
  { id: 'misc', name: 'Miscelánea', icon: Monitor },
]

export default function Settings() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('autoplay')

  // Móvil: las pestañas horizontales quedan mal en pantallas estrechas —
  // se usa un menú de secciones (lista vertical) con vista de detalle.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  )
  const [mobileMenu, setMobileMenu] = useState(true)
  const [uiScale, setUiScalePct] = useState(() => getUiScale() || 100)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // En móvil, el Back del sistema (gesto/botón) vuelve al menú de secciones
  // en vez de salir de Ajustes.
  useEffect(() => {
    if (!isMobile || mobileMenu) return
    const onBack = event => {
      if (event.key !== 'Back' && event.key !== 'Escape') return
      event.preventDefault()
      setMobileMenu(true)
      document.body.dataset.backConsumed = 'true'
    }
    document.addEventListener('keydown', onBack)
    return () => document.removeEventListener('keydown', onBack)
  }, [isMobile, mobileMenu])

  // API keys
  const [apiKey, setApiKey] = useState(localStorage.getItem('octostream_tmdb_key') || '')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [osApiKey, setOsApiKey] = useState(localStorage.getItem('octostream_opensubs_apikey') || '')
  const [osSaved, setOsSaved] = useState(false)
  const [osError, setOsError] = useState('')

  // AllDebrid API key
  const [adApiKey, setAdApiKey] = useState(localStorage.getItem('octostream_alldebrid_key') || '')
  const [adSaved, setAdSaved] = useState(false)

  // HDFull credentials
  const [hdfullUser, setHdfullUser] = useState(localStorage.getItem('octostream_hdfull_username') || '')
  const [hdfullPass, setHdfullPass] = useState(localStorage.getItem('octostream_hdfull_password') || '')
  const [hdfullSaved, setHdfullSaved] = useState(false)
  const [hdfullTesting, setHdfullTesting] = useState(false)
  const [hdfullTestResult, setHdfullTestResult] = useState('') // 'ok' | 'fail' | ''

  // PIN flow state (AllDebrid)
  const [adPin, setAdPin] = useState(null) // { pin, check, user_url, expires_in }
  const [adPinLoading, setAdPinLoading] = useState(false)
  const [adPinError, setAdPinError] = useState('')
  const adPinTimerRef = useRef(null)
  const adPinPollingRef = useRef(false)

  // Clear PIN polling interval on unmount
  useEffect(() => {
    return () => {
      if (adPinTimerRef.current) clearInterval(adPinTimerRef.current)
    }
  }, [])

  // Screensaver settings
  const [ssEnabled, setSsEnabled] = useState(localStorage.getItem('octostream_screensaver_enabled') !== 'false')
  const [ssTimeout, setSsTimeout] = useState(parseInt(localStorage.getItem('octostream_screensaver_timeout') || '5', 10))

  // WARP VPN state
  const [vpnStatus, setVpnStatus] = useState('disconnected') // disconnected | connecting | connected
  const [vpnError, setVpnError] = useState('')
  const [vpnAutoConnect, setVpnAutoConnect] = useState(localStorage.getItem('octostream_warp_autoconnect') !== 'false')

  const toggleVpn = useCallback(async () => {
    setVpnError('')
    if (vpnStatus === 'connected' || vpnStatus === 'connecting') {
      try {
        await CloudProxy.disconnect()
        await refreshWarpStatus()
        setVpnStatus('disconnected')
        // Desactivar auto-connect cuando se desconecta manualmente
        localStorage.setItem('octostream_warp_autoconnect', 'false')
        setVpnAutoConnect(false)
      } catch (e) {
        setVpnError('Error al desconectar: ' + (e.message || e))
      }
    } else {
      setVpnStatus('connecting')
      try {
        const result = await CloudProxy.connect()
        await refreshWarpStatus()
        if (result.status === 'connected') {
          setVpnStatus('connected')
          // Activar auto-connect cuando se conecta manualmente
          localStorage.setItem('octostream_warp_autoconnect', 'true')
          setVpnAutoConnect(true)
        } else {
          setVpnStatus('disconnected')
          setVpnError('No se pudo conectar')
        }
      } catch (e) {
        setVpnStatus('disconnected')
        setVpnError('Error: ' + (e.message || e))
      }
    }
  }, [vpnStatus])

  // Toggle auto-connect preference
  const toggleVpnAutoConnect = useCallback(() => {
    setVpnAutoConnect(prev => {
      const next = !prev
      localStorage.setItem('octostream_warp_autoconnect', next ? 'true' : 'false')
      return next
    })
  }, [])

  // Check VPN status on mount (auto-connect is in App.jsx, runs at app start)
  useEffect(() => {
    CloudProxy.getStatus().then(s => {
      if (s.connected) setVpnStatus('connected')
      else if (localStorage.getItem('octostream_warp_autoconnect') !== 'false') setVpnStatus('connecting')
    }).catch(() => {})
  }, [])
  const [imgQuality, setImgQuality] = useState(localStorage.getItem('octostream_image_quality') || 'medium')
  const [ssSaved, setSsSaved] = useState(false)

  // Autoplay settings
  const [autoplayEnabled, setAutoplayEnabled] = useState(localStorage.getItem('octostream_autoplay') !== 'false')
  // Auto next episode: si está activo, al terminar un episodio se reproduce
  // automáticamente el siguiente. Si está desactivado, el usuario debe elegir
  // manualmente. Se guarda en localStorage y se lee desde VideoPlayer/Details.
  const [autoNextEp, setAutoNextEp] = useState(localStorage.getItem('octostream_auto_next_ep') !== 'false')

  // Language priority settings
  const [langPriority, setLangPriority] = useState(getDefaultLangPriority())

  // Búsquedas torrent (DonTorrent, GranTorrent, SubTorrents). Apagado = los
  // sitios torrent no se consultan ni emiten streams.
  const [torrentSearch, setTorrentSearch] = useState(localStorage.getItem('octostream_torrent_search') !== 'false')

  const handleScreensaverSave = () => {
    localStorage.setItem('octostream_screensaver_enabled', ssEnabled ? 'true' : 'false')
    localStorage.setItem('octostream_screensaver_timeout', String(ssTimeout))
    setSsSaved(true)
    setTimeout(() => setSsSaved(false), 2000)
  }

  const handleSave = async () => {
    setError('')
    const key = apiKey.trim()
    if (!key) {
      localStorage.removeItem('octostream_tmdb_key')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return
    }

    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/configuration?api_key=${key}`,
        { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined }
      )
      if (!res.ok) {
        setError('API key inválida. Verifica tu clave en themoviedb.org')
        return
      }
      localStorage.setItem('octostream_tmdb_key', key)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('No se pudo verificar la API key. Revisa tu conexión.')
    }
  }

  const handleOsSave = () => {
    setOsError('')
    const key = osApiKey.trim()
    if (!key) {
      localStorage.removeItem('octostream_opensubs_apikey')
      setOsSaved(true)
      setTimeout(() => setOsSaved(false), 2000)
      return
    }
    localStorage.setItem('octostream_opensubs_apikey', key)
    setOsSaved(true)
    setTimeout(() => setOsSaved(false), 2000)
  }

  const handleHdfullSave = () => {
    const u = hdfullUser.trim()
    const p = hdfullPass.trim()
    if (!u || !p) {
      localStorage.removeItem('octostream_hdfull_username')
      localStorage.removeItem('octostream_hdfull_password')
    } else {
      localStorage.setItem('octostream_hdfull_username', u)
      localStorage.setItem('octostream_hdfull_password', p)
    }
    setHdfullSaved(true)
    setTimeout(() => setHdfullSaved(false), 2000)
  }

  const handleHdfullTest = async () => {
    setHdfullTesting(true)
    setHdfullTestResult('')
    try {
      // Guardar temporalmente para que el canal lea las credenciales actualizadas
      const u = hdfullUser.trim()
      const p = hdfullPass.trim()
      if (u) localStorage.setItem('octostream_hdfull_username', u)
      if (p) localStorage.setItem('octostream_hdfull_password', p)
      const { hdfull } = await import('../plugins/bundled/plurtasko/channels/hdfull.js')
      const items = await hdfull.getCatalog({ id: 'hdfull-movies', skip: 0, top: 1 })
      setHdfullTestResult(items.length > 0 ? 'ok' : 'fail')
    } catch (e) {
      setHdfullTestResult('fail')
      console.warn('[Settings] HDFull test failed:', e?.message || e)
    } finally {
      setHdfullTesting(false)
    }
  }

  const handleAdSave = () => {
    const key = adApiKey.trim()
    if (!key) {
      localStorage.removeItem('octostream_alldebrid_key')
    } else {
      localStorage.setItem('octostream_alldebrid_key', key)
    }
    setAdSaved(true)
    setTimeout(() => setAdSaved(false), 2000)
  }

  // --- AllDebrid PIN flow ---
  const handleAdPinStart = useCallback(async () => {
    setAdPinError('')
    setAdPinLoading(true)
    setAdPin(null)
    if (adPinTimerRef.current) clearInterval(adPinTimerRef.current)
    try {
      const pin = await adGetPin()
      if (!pin) {
        setAdPinError('No se pudo obtener el código PIN')
        setAdPinLoading(false)
        return
      }
      setAdPin(pin)
      // Poll for activation
      const startTime = Date.now()
      adPinTimerRef.current = setInterval(async () => {
        if (adPinPollingRef.current) return
        if (Date.now() - startTime > pin.expires_in * 1000) {
          clearInterval(adPinTimerRef.current)
          setAdPinError('El código PIN ha expirado')
          setAdPin(null)
          setAdPinLoading(false)
          return
        }
        adPinPollingRef.current = true
        try {
          const result = await adCheckPin(pin.pin, pin.check)
          if (result?.activated && result.apikey) {
            clearInterval(adPinTimerRef.current)
            localStorage.setItem('octostream_alldebrid_key', result.apikey)
            setAdApiKey(result.apikey)
            setAdPin(null)
            setAdPinLoading(false)
            setAdSaved(true)
            setTimeout(() => setAdSaved(false), 2000)
          }
        } catch (e) {
          setAdPinError(e?.message || 'Error al verificar el PIN')
        } finally {
          adPinPollingRef.current = false
        }
      }, 5000)
    } catch (e) {
      setAdPinError(e?.message || 'Error al obtener PIN')
      setAdPinLoading(false)
    }
  }, [])

  const handleAdPinCancel = useCallback(() => {
    if (adPinTimerRef.current) clearInterval(adPinTimerRef.current)
    setAdPin(null)
    setAdPinLoading(false)
  }, [])

  return (
    <div className="p-4 lg:p-6 max-w-2xl settings-page">
      {!isMobile && (
      <div className="flex items-center gap-3 mb-6">
        <SettingsIcon className="text-primary-500" size={28} />
        <h1 className="text-2xl font-bold text-white">Configuración</h1>
      </div>
      )}

      {/* Móvil: menú de secciones a pantalla completa */}
      {isMobile && mobileMenu && (
        <div className="space-y-2">
          {TABS.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setMobileMenu(false) }}
                className="w-full flex items-center gap-3 p-4 bg-dark-800 rounded-xl border border-dark-700 text-left active:bg-dark-700"
              >
                <div className="w-9 h-9 bg-primary-600/20 rounded-lg flex items-center justify-center shrink-0">
                  <Icon className="text-primary-400" size={20} />
                </div>
                <span className="flex-1 text-white font-medium">{tab.name}</span>
                <ChevronRight size={18} className="text-dark-500" />
              </button>
            )
          })}
        </div>
      )}

      {(!isMobile || !mobileMenu) && (
      <div className="settings-body">
      {/* Móvil: solo el nombre de la sección; Back del sistema vuelve al menú */}
      {isMobile && (() => {
        const tab = TABS.find(t => t.id === activeTab)
        return <h2 className="text-base font-semibold text-white mb-3">{tab?.name}</h2>
      })()}
      {/* Tabs — siempre fila horizontal bajo el título (también en TV) */}
      {!isMobile && (
      <div className="settings-tabs flex gap-2 mb-6 border-b border-dark-700 overflow-x-auto whitespace-nowrap" data-tv-row>
        {TABS.map((tab, idx) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              tabIndex={0}
              data-tv-item
              {...(idx === 0 ? { 'data-tv-initial': true } : {})}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 shrink-0 ${
                isActive
                  ? 'text-primary-400 border-primary-500'
                  : 'text-dark-400 border-transparent hover:text-white hover:border-dark-600'
              }`}
            >
              <Icon size={18} />
              {tab.name}
            </button>
          )
        })}
      </div>
      )}

      <div className="settings-content">
      {/* Tab: Autoplay */}
      {activeTab === 'autoplay' && (
        <div className="space-y-6">
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Play className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Reproducción automática</h3>
                <p className="text-dark-400 text-sm">
                  Reproduce automáticamente el siguiente episodio al terminar
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-dark-300">Activar autoplay de episodios</span>
                <button
                  onClick={() => {
                    const newVal = !autoplayEnabled
                    setAutoplayEnabled(newVal)
                    localStorage.setItem('octostream_autoplay', newVal ? 'true' : 'false')
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${autoplayEnabled ? 'bg-primary-600' : 'bg-dark-700'}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${autoplayEnabled ? 'translate-x-6' : ''}`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer pt-3 border-t border-dark-700/50">
                <div>
                  <span className="text-sm text-dark-300 block">Cambio automático de capítulo</span>
                  <span className="text-xs text-dark-500">Al terminar un episodio, reproduce el siguiente automáticamente</span>
                </div>
                <button
                  onClick={() => {
                    const newVal = !autoNextEp
                    setAutoNextEp(newVal)
                    localStorage.setItem('octostream_auto_next_ep', newVal ? 'true' : 'false')
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${autoNextEp ? 'bg-primary-600' : 'bg-dark-700'}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${autoNextEp ? 'translate-x-6' : ''}`}
                  />
                </button>
              </label>
            </div>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Languages className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Prioridad de idioma</h3>
                <p className="text-dark-400 text-sm">
                  Orden en el que se seleccionan los enlaces al reproducir
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {langPriority.map((lang, idx) => (
                <div key={lang} className="flex items-center gap-3 bg-dark-700/50 rounded-lg p-3">
                  <span className="text-xs text-dark-400 font-mono w-6 text-center">{idx + 1}º</span>
                  <span className="flex-1 text-sm text-white font-medium">{LANG_LABELS[lang] || lang}</span>
                  <div className="flex gap-1">
                    <button
                      tabIndex={0}
                      onClick={() => {
                        if (idx === 0) return
                        const newArr = [...langPriority]
                        ;[newArr[idx - 1], newArr[idx]] = [newArr[idx], newArr[idx - 1]]
                        setLangPriority(newArr)
                        localStorage.setItem('octostream_lang_priority', JSON.stringify(newArr))
                      }}
                      disabled={idx === 0}
                      className={`p-1.5 rounded ${idx === 0 ? 'text-dark-600 cursor-not-allowed' : 'text-dark-300 hover:bg-dark-600 hover:text-white'}`}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      tabIndex={0}
                      onClick={() => {
                        if (idx === langPriority.length - 1) return
                        const newArr = [...langPriority]
                        ;[newArr[idx + 1], newArr[idx]] = [newArr[idx], newArr[idx + 1]]
                        setLangPriority(newArr)
                        localStorage.setItem('octostream_lang_priority', JSON.stringify(newArr))
                      }}
                      disabled={idx === langPriority.length - 1}
                      className={`p-1.5 rounded ${idx === langPriority.length - 1 ? 'text-dark-600 cursor-not-allowed' : 'text-dark-300 hover:bg-dark-600 hover:text-white'}`}
                    >
                      <ArrowDown size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-dark-500 text-xs mt-3">
              Al reproducir, se elegirá automáticamente el primer enlace disponible según este orden.
            </p>
          </div>
        </div>
      )}

      {/* Tab: APIs */}
      {activeTab === 'apis' && (
        <div className="space-y-6">
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Film className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">TMDB API Key</h3>
                <p className="text-dark-400 text-sm">
                  Necesaria para el plugin de películas y series con datos reales
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  API Key (v3 auth)
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="Introduce tu TMDB API key"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              {saved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key gratuita?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en themoviedb.org</li>
                <li>Ve a Configuración → API</li>
                <li>Solicita una API key (tipo Developer)</li>
                <li>Copia la "API Key (v3 auth)" y pégala arriba</li>
              </ol>
              <a
                href="https://www.themoviedb.org/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a themoviedb.org
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Captions className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">OpenSubtitles API Key</h3>
                <p className="text-dark-400 text-sm">
                  Necesaria para buscar y cargar subtítulos en el reproductor
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  API Key
                </label>
                <input
                  type="password"
                  value={osApiKey}
                  onChange={e => setOsApiKey(e.target.value)}
                  placeholder="Introduce tu OpenSubtitles API key"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleOsSave()}
                />
              </div>

              {osError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
                  <AlertCircle size={16} />
                  {osError}
                </div>
              )}

              {osSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleOsSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key gratuita?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en opensubtitles.com</li>
                <li>Ve a API consumers → Register</li>
                <li>Copia tu API key</li>
                <li>Pégala arriba</li>
              </ol>
              <a
                href="https://www.opensubtitles.com/consumers"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a opensubtitles.com
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {/* AllDebrid moved to Debrid tab */}

          {/* HDFull credentials */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Key className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">HDFull</h3>
                <p className="text-dark-400 text-sm">
                  Cuenta necesaria para acceder al catálogo de HDFull (películas y series)
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  Usuario
                </label>
                <input
                  type="text"
                  value={hdfullUser}
                  onChange={e => setHdfullUser(e.target.value)}
                  placeholder="Usuario de HDFull"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleHdfullSave()}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck="false"
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  Contraseña
                </label>
                <input
                  type="password"
                  value={hdfullPass}
                  onChange={e => setHdfullPass(e.target.value)}
                  placeholder="Contraseña de HDFull"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleHdfullSave()}
                />
              </div>

              {hdfullSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              {hdfullTestResult === 'ok' && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Login correcto — HDFull responde
                </div>
              )}
              {hdfullTestResult === 'fail' && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
                  <AlertCircle size={16} />
                  No se pudo iniciar sesión. Verifica tus credenciales.
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={handleHdfullSave} className="btn-primary">
                  <Check size={18} />
                  Guardar
                </button>
                <button
                  onClick={handleHdfullTest}
                  disabled={hdfullTesting || !hdfullUser.trim() || !hdfullPass.trim()}
                  className="btn-secondary"
                >
                  {hdfullTesting ? (
                    <><OctoLoader size={16} /> Probando...</>
                  ) : (
                    <><Key size={16} /> Probar login</>
                  )}
                </button>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una cuenta?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en hdfull.today (gratis)</li>
                <li>Inicia sesión y ve a tu perfil</li>
                <li>Copia tu usuario y contraseña</li>
                <li>Pégalos arriba y pulsa "Probar login"</li>
              </ol>
              <a
                href="https://hdfull.today/login"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a hdfull.today
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2">Estado de la configuración</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-dark-400">TMDB API Key</span>
                {localStorage.getItem('octostream_tmdb_key') ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={14} /> Configurada
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-dark-500">
                    <AlertCircle size={14} /> No configurada
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-400">OpenSubtitles API Key</span>
                {localStorage.getItem('octostream_opensubs_apikey') ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={14} /> Configurada
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-dark-500">
                    <AlertCircle size={14} /> No configurada
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-400">HDFull</span>
                {localStorage.getItem('octostream_hdfull_username') ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={14} /> Configurada
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-dark-500">
                    <AlertCircle size={14} /> No configurada
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Debrid */}
      {activeTab === 'debrid' && (
        <div className="space-y-6">
          {/* AllDebrid */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Download className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">AllDebrid API Key</h3>
                <p className="text-dark-400 text-sm">
                  Desbloquea servidores (streamwish, filemoon, vidhide, etc.) y torrents vía AllDebrid
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  API Key
                </label>
                <input
                  type="password"
                  value={adApiKey}
                  onChange={e => setAdApiKey(e.target.value)}
                  placeholder="Introduce tu AllDebrid API key"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleAdSave()}
                />
              </div>

              {adSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleAdSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>
            </div>

            {/* PIN flow */}
            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-3">¿O conecta tu cuenta con un código PIN:</p>
              {!adPin && !adPinLoading && (
                <button onClick={handleAdPinStart} className="btn-secondary">
                  <Key size={16} />
                  Obtener código PIN
                </button>
              )}
              {adPinLoading && !adPin && (
                <div className="flex items-center gap-2 text-dark-400 text-sm">
                  <OctoLoader size={16} />
                  Obteniendo código PIN...
                </div>
              )}
              {adPin && (
                <div className="bg-primary-600/10 border border-primary-600/30 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="text-3xl font-bold text-primary-400 tracking-wider">{adPin.pin}</div>
                    <div className="flex items-center gap-1 text-dark-400 text-sm">
                      <OctoLoader size={14} />
                      Esperando activación...
                    </div>
                  </div>
                  <a
                    href={adPin.user_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary-400 text-sm hover:text-primary-300"
                  >
                    Introduce el PIN en alldebrid.com/pin
                    <ExternalLink size={14} />
                  </a>
                  <button onClick={handleAdPinCancel} className="text-dark-400 text-sm hover:text-red-400">
                    Cancelar
                  </button>
                </div>
              )}
              {adPinError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3 mt-2">
                  <AlertCircle size={16} />
                  {adPinError}
                </div>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en alldebrid.com (servicio de pago, ~3€/mes)</li>
                <li>Ve a Configuración → API</li>
                <li>Copia tu API key</li>
                <li>Pégala arriba</li>
              </ol>
              <a
                href="https://alldebrid.com/apikeys/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a alldebrid.com
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2">Estado de la configuración</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-dark-400">AllDebrid API Key</span>
                {localStorage.getItem('octostream_alldebrid_key') ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={14} /> Configurada
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-dark-500">
                    <AlertCircle size={14} /> No configurada
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Red */}
      {activeTab === 'red' && (
        <div className="space-y-6">
          {/* Cloudflare WARP */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Globe className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Cloudflare WARP</h3>
                <p className="text-dark-400 text-sm">
                  Proxy local (SOCKS5) para desbloquear películas y series bloqueadas por el ISP.
                  No afecta a otras apps ni a TDT Spain.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-dark-300">
                  {vpnStatus === 'connecting' ? 'Conectando...' : vpnStatus === 'connected' ? 'Conectado' : 'Desconectado'}
                </span>
                <button
                  onClick={toggleVpn}
                  disabled={vpnStatus === 'connecting'}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    vpnStatus === 'connected' ? 'bg-green-600' :
                    vpnStatus === 'connecting' ? 'bg-yellow-600' :
                    'bg-dark-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      vpnStatus === 'connected' || vpnStatus === 'connecting' ? 'translate-x-6' : ''
                    }`}
                  />
                </button>
              </label>
              {vpnError && (
                <p className="text-red-400 text-sm">{vpnError}</p>
              )}
              <label className="flex items-center justify-between cursor-pointer pt-2 border-t border-dark-700/50">
                <span className="text-sm text-dark-300">
                  Auto-conectar al iniciar
                </span>
                <button
                  onClick={toggleVpnAutoConnect}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    vpnAutoConnect ? 'bg-green-600' : 'bg-dark-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      vpnAutoConnect ? 'translate-x-6' : ''
                    }`}
                  />
                </button>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Sincronizar */}
      {activeTab === 'sync' && (
        <div className="space-y-6">
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <RefreshCw className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Sincronizar dispositivos</h3>
                <p className="text-sm text-dark-400">Sincroniza historial, favoritos y progreso entre dispositivos en la misma red WiFi</p>
              </div>
            </div>
            <button
              data-tv-card
              tabIndex={0}
              onClick={() => navigate('/sync')}
              className="btn-primary px-4 py-3 flex items-center gap-2"
            >
              <RefreshCw size={18} />
              Abrir sincronización
            </button>
          </div>
        </div>
      )}

      {/* Tab: Miscelánea */}
      {activeTab === 'misc' && (
        <div className="space-y-6">
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Monitor className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Tamaño de interfaz</h3>
                <p className="text-dark-400 text-sm">
                  Agrandar o reducir toda la UI — útil en TVs/boxes donde se ve pequeña
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => setUiScalePct(setUiScale(Math.max(80, uiScale - 10)))}
                className="btn-secondary px-4 py-2 font-bold"
              >−</button>
              <span className="text-white font-mono text-lg w-16 text-center">{uiScale}%</span>
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => setUiScalePct(setUiScale(Math.min(200, uiScale + 10)))}
                className="btn-secondary px-4 py-2 font-bold"
              >+</button>
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => setUiScalePct(setUiScale(0))}
                className="btn-ghost px-3 py-2 text-sm"
              >Auto</button>
            </div>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Puzzle className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Plugins</h3>
                <p className="text-dark-400 text-sm">
                  Gestiona los catálogos y fuentes de contenido instalados
                </p>
              </div>
            </div>
            <button
              data-tv-card
              tabIndex={0}
              onClick={() => navigate('/plugins')}
              className="btn-primary px-4 py-3 flex items-center gap-2"
            >
              <Puzzle size={18} />
              Gestionar plugins
            </button>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Magnet className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Torrents</h3>
                <p className="text-dark-400 text-sm">
                  Búsqueda en sitios torrent (DonTorrent, GranTorrent, SubTorrents)
                </p>
              </div>
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-sm text-dark-300 block">Buscar enlaces torrent</span>
                <span className="text-xs text-dark-500">Si se apaga, los sitios torrent no se consultan ni aparecen sus enlaces</span>
              </div>
              <button
                data-tv-card
                tabIndex={0}
                onClick={() => {
                  const newVal = !torrentSearch
                  setTorrentSearch(newVal)
                  localStorage.setItem('octostream_torrent_search', newVal ? 'true' : 'false')
                }}
                className={`relative w-12 h-6 rounded-full transition-colors ${torrentSearch ? 'bg-primary-600' : 'bg-dark-700'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${torrentSearch ? 'translate-x-6' : ''}`}
                />
              </button>
            </label>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Monitor className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Salvapantallas</h3>
                <p className="text-dark-400 text-sm">
                  Se activa tras un periodo de inactividad mostrando el logo animado
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-dark-300">Activar salvapantallas automático</span>
                <button
                  onClick={() => setSsEnabled(!ssEnabled)}
                  className={`relative w-12 h-6 rounded-full transition-colors ${ssEnabled ? 'bg-primary-600' : 'bg-dark-700'}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${ssEnabled ? 'translate-x-6' : ''}`}
                  />
                </button>
              </label>

              {ssEnabled && (
                <div>
                  <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                    Tiempo de inactividad (minutos)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={ssTimeout}
                    onChange={e => setSsTimeout(Math.max(1, parseInt(e.target.value) || 5))}
                    className="input w-24"
                  />
                </div>
              )}

              {ssSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleScreensaverSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>
            </div>
          </div>

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Image className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Calidad de imágenes</h3>
                <p className="text-dark-400 text-sm">
                  Baja la resolución de pósters y fondos para ahorrar datos y memoria
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              {[['high', 'Alta'], ['medium', 'Media'], ['low', 'Baja']].map(([value, label]) => (
                <button
                  key={value}
                  data-tv-card
                  onClick={() => {
                    setImgQuality(value)
                    localStorage.setItem('octostream_image_quality', value)
                    invalidateImageQuality()
                  }}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    imgQuality === value ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
      </div>
      )}
    </div>
  )
}