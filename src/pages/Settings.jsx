import { useState, useRef, useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Settings as SettingsIcon, Key, Check, ExternalLink, AlertCircle, Film, Captions, Monitor, Play, ArrowUp, ArrowDown, Languages, Download, Globe, Image, RefreshCw, Puzzle, ChevronRight, Magnet, List, TrendingUp, Users } from 'lucide-react'
import { invalidateImageQuality } from '../plugins/builtIn/tmdb.js'
import { traktDeviceCode, traktDeviceToken, traktMe, clearTraktTokens, getTraktToken } from '../plugins/builtIn/extProviders.js'
import OctoLoader from '../components/OctoLoader.jsx'
import Toggle from '../components/ui/Toggle.jsx'
import Modal from '../components/ui/Modal.jsx'
import SyncDevices from '../components/SyncDevices.jsx'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import { CloudProxy } from '../utils/cloudProxy.js'
import { getPin as adGetPin, checkPin as adCheckPin, getAccountInfo as adAccountInfo, getLinkHistory as adLinkHistory, getAdKeyLog } from '../plugins/bundled/alldebrid.js'
import { refreshWarpStatus, subscribeWarpStatus, getWarpDetails, warpStrictEnabled, checkIpLeak } from '../utils/warpStatus.js'
import { getUiScale, setUiScale } from '../utils/uiScale.js'
import { checkForUpdate } from '../utils/appUpdater.js'
import { exportSettings, importSettings, BACKUP_CATEGORIES } from '../utils/configBackup.js'
import { setItemSync, removeItemSync } from '../utils/storage.js'
import { invalidateLangPriority } from '../utils/streamMeta.js'
import { getSubStyle, saveSubStyle } from '../utils/subStyle.js'
import ProfileSettings from '../components/ProfileSettings.jsx'

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

function parseRemoteHostInput(value) {
  let host = (value || '').trim()
  let port = null
  if (!host) return { host: '', port }
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
      const url = new URL(host)
      host = url.hostname
      port = url.port ? parseInt(url.port, 10) : null
    } else {
      host = host.slice(host.lastIndexOf('@') + 1).split(/[/?#]/, 1)[0].trim()
      if (host.startsWith('[')) {
        const end = host.indexOf(']')
        const suffix = end > 1 ? host.slice(end + 1) : ''
        if (end > 1) host = host.slice(1, end)
        if (/^:\d{1,5}$/.test(suffix)) port = parseInt(suffix.slice(1), 10)
      } else {
        const hostPort = host.match(/^([^:]+):(\d{1,5})$/)
        if (hostPort) {
          host = hostPort[1]
          port = parseInt(hostPort[2], 10)
        }
      }
    }
  } catch {}
  if (!(port >= 1 && port <= 65535)) port = null
  return { host, port }
}

const TABS = [
  { id: 'autoplay', name: 'Autoplay', icon: Play },
  { id: 'apis', name: 'APIs', icon: Key },
  { id: 'subs', name: 'Subtítulos', icon: Captions },
  { id: 'debrid', name: 'Debrid', icon: Download },
  { id: 'red', name: 'Red', icon: Globe },
  { id: 'sync', name: 'Sincronizar', icon: RefreshCw },
  { id: 'profiles', name: 'Perfiles', icon: Users },
  { id: 'misc', name: 'Miscelánea', icon: Monitor },
]

export default function Settings() {
  const navigate = useNavigate()
  const location = useLocation()
  const [activeTab, setActiveTab] = useState(() => location.state?.settingsTab || 'autoplay')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [backupMsg, setBackupMsg] = useState('')
  const [backupCats, setBackupCats] = useState(() => Object.fromEntries(BACKUP_CATEGORIES.map(c => [c.id, true])))

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
  const [subStyle, setSubStyle] = useState(() => getSubStyle())
  // Subtítulos en español automáticos cuando el audio no es español
  // (pipeline: OpenSubtitles → traducción IA → transcripción — duck.ai,
  // sin clave extra).
  const [autoSubs, setAutoSubs] = useState(localStorage.getItem('octostream_autosubs') !== 'false')
  const updSubStyle = patch => {
    const next = { ...subStyle, ...patch }
    setSubStyle(next)
    saveSubStyle(patch)
  }

  // Catálogos temáticos externos (MDBList / Trakt)
  const [mdbApiKey, setMdbApiKey] = useState(localStorage.getItem('octostream_mdblist_key') || '')
  const [mdbSaved, setMdbSaved] = useState(false)
  const [mdbError, setMdbError] = useState('')
  const [traktKey, setTraktKey] = useState(localStorage.getItem('octostream_trakt_key') || '')
  const [traktSecret, setTraktSecret] = useState(localStorage.getItem('octostream_trakt_secret') || '')
  const [traktLists, setTraktLists] = useState(localStorage.getItem('octostream_trakt_lists') || '')
  const [traktSaved, setTraktSaved] = useState(false)
  const [traktError, setTraktError] = useState('')
  const [traktUser, setTraktUser] = useState(localStorage.getItem('octostream_trakt_user') || '')

  // PIN flow state (Trakt OAuth device)
  const [traktPin, setTraktPin] = useState(null) // { userCode, verificationUrl, expiresIn, deviceCode }
  const [traktPinLoading, setTraktPinLoading] = useState(false)
  const [traktPinError, setTraktPinError] = useState('')
  const traktPinTimerRef = useRef(null)
  const traktPinPollingRef = useRef(false)

  // AllDebrid API key
  const [adApiKey, setAdApiKey] = useState(localStorage.getItem('octostream_alldebrid_key') || '')
  const [adSaved, setAdSaved] = useState(false)
  // Auditoría: cuenta AllDebrid + historial de desbloqueos + propagación.
  const [adAudit, setAdAudit] = useState(null)
  const [adAuditBusy, setAdAuditBusy] = useState(false)
  const loadAdAudit = async () => {
    setAdAuditBusy(true)
    try {
      const [account, history] = await Promise.all([adAccountInfo(), adLinkHistory()])
      setAdAudit({ account, history, propagation: getAdKeyLog() })
    } finally { setAdAuditBusy(false) }
  }
  // PIN flow state (AllDebrid)
  const [adPin, setAdPin] = useState(null)
  const [adPinLoading, setAdPinLoading] = useState(false)
  const [adPinError, setAdPinError] = useState('')
  const adPinTimerRef = useRef(null)
  const adPinPollingRef = useRef(false)
  // HDFull credentials
  const [hdfullUser, setHdfullUser] = useState(localStorage.getItem('octostream_hdfull_username') || '')
  const [hdfullPass, setHdfullPass] = useState(localStorage.getItem('octostream_hdfull_password') || '')
  const [hdfullSaved, setHdfullSaved] = useState(false)
  const [hdfullTesting, setHdfullTesting] = useState(false)
  const [hdfullTestResult, setHdfullTestResult] = useState('') // 'ok' | 'fail' | ''

  // AIOStreams (agregador tipo POV/Stremio: uuid + password por Basic auth)
  const [aioInstance, setAioInstance] = useState(localStorage.getItem('octostream_aiostreams_instance') || 'https://aiostreams.elfhosted.com')
  const [aioUuid, setAioUuid] = useState(localStorage.getItem('octostream_aiostreams_uuid') || '')
  const [aioPass, setAioPass] = useState(localStorage.getItem('octostream_aiostreams_password') || '')
  const [aioSaved, setAioSaved] = useState(false)
  const [aioManifest, setAioManifest] = useState(localStorage.getItem('octostream_aiostreams_manifest') || '')
  const [aioTest, setAioTest] = useState(null) // null | {loading:true} | {ok,results} | {ok:false,error}

  // Clear PIN polling interval on unmount
  useEffect(() => {
    return () => {
      if (traktPinTimerRef.current) clearInterval(traktPinTimerRef.current)
    }
  }, [])

  // Screensaver settings
  const [ssEnabled, setSsEnabled] = useState(localStorage.getItem('octostream_screensaver_enabled') !== 'false')
  const [ssTimeout, setSsTimeout] = useState(parseInt(localStorage.getItem('octostream_screensaver_timeout') || '5', 10))

  // WARP VPN state
  const [vpnStatus, setVpnStatus] = useState('disconnected') // disconnected | connecting | connected
  const [vpnError, setVpnError] = useState('')
  const [warpStrict, setWarpStrict] = useState(warpStrictEnabled())
  // Salida WARP: 'auto' = colo cercano (tu país); 'random' = segundo salto
  // (WARP-en-WARP, otro país cualquiera); o país fijado que el propio
  // aether verifica contra el trace de Cloudflare antes de aceptar el túnel.
  const [warpExitLoc, setWarpExitLoc] = useState(localStorage.getItem('octostream_warp_exit') || 'auto')
  // Salida remota: IP/dominio del VPS al que se llega por túnel SSH.
  // Vacío = WARP local doble-salto de este dispositivo.
  const [warpRemote, setWarpRemote] = useState(localStorage.getItem('octostream_warp_remote') || '')
  // SSH del remoto: con usuario+clave el host se alcanza por túnel SSH al
  // VPS (port-forward al proxy loopback) — funciona fuera de casa, sin
  // Tailscale ni apps extra. Vacío = remoto plano en la misma WiFi.
  const [warpSshUser, setWarpSshUser] = useState(localStorage.getItem('octostream_warp_ssh_user') || '')
  const [warpSshPass, setWarpSshPass] = useState('')
  const [warpSshPort, setWarpSshPort] = useState(localStorage.getItem('octostream_warp_ssh_port') || '22')
  // Host key SSH pendiente de confirmación (TOFU): {fingerprint, changed}.
  const [hostKeyPrompt, setHostKeyPrompt] = useState(null)
  // Huella SSH pendiente: el auto-connect la rechaza sin UI y el aviso
  // mandaba a "Ajustes → Red", pero el diálogo solo se abría si el error
  // saltaba dentro del botón Probar. Al entrar en Red se consulta la
  // pendiente del plugin y el diálogo aparece solo.
  useEffect(() => {
    let dead = false
    CloudProxy.getPendingHostKey?.().then(pk => {
      if (dead || !pk?.fingerprint) return
      // Solo si la pendiente es para el remoto configurado ahora.
      const { host } = parseRemoteHostInput(warpRemote || '')
      if (!pk.host || !host || pk.host === host) {
        setHostKeyPrompt(prev => prev || { fingerprint: pk.fingerprint, changed: !!pk.changed })
      }
    }).catch(() => {})
    return () => { dead = true }
  }, [activeTab])
  const [vpsTest, setVpsTest] = useState(null)
  const [vpsTestBusy, setVpsTestBusy] = useState(false)
  const [leakTest, setLeakTest] = useState(null) // null | {busy:true} | {tunnel, direct}
  const [leakBusy, setLeakBusy] = useState(false)
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

  const handleMdbSave = async () => {
    setMdbError('')
    const key = mdbApiKey.trim()
    if (!key) {
      localStorage.removeItem('octostream_mdblist_key')
      setMdbSaved(true)
      setTimeout(() => setMdbSaved(false), 2000)
      return
    }
    try {
      const res = await fetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined })
      if (!res.ok) {
        setMdbError('API key inválida. Verifica tu clave en mdblist.com')
        return
      }
      localStorage.setItem('octostream_mdblist_key', key)
      setMdbSaved(true)
      setTimeout(() => setMdbSaved(false), 2000)
    } catch {
      setMdbError('No se pudo verificar la API key. Revisa tu conexión.')
    }
  }

  const handleTraktSave = async () => {
    setTraktError('')
    const key = traktKey.trim()
    if (!key) {
      localStorage.removeItem('octostream_trakt_key')
    } else {
      // Trakt valida el Client ID consultando un endpoint público con los headers.
      try {
        const res = await fetch('https://api.trakt.tv/movies/trending?limit=1', {
          headers: { 'trakt-api-version': '2', 'trakt-api-key': key },
          signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
        })
        if (!res.ok) {
          setTraktError('Client ID inválido. Verifícalo en trakt.tv/oauth/applications')
          return
        }
      } catch {
        setTraktError('No se pudo verificar el Client ID. Revisa tu conexión.')
        return
      }
      localStorage.setItem('octostream_trakt_key', key)
    }
    const secret = traktSecret.trim()
    if (secret) localStorage.setItem('octostream_trakt_secret', secret)
    else localStorage.removeItem('octostream_trakt_secret')
    const lists = traktLists.trim()
    if (lists) localStorage.setItem('octostream_trakt_lists', lists)
    else localStorage.removeItem('octostream_trakt_lists')
    setTraktSaved(true)
    setTimeout(() => setTraktSaved(false), 2000)
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
    if (!key) localStorage.removeItem('octostream_alldebrid_key')
    else localStorage.setItem('octostream_alldebrid_key', key)
    setAdSaved(true)
    setTimeout(() => setAdSaved(false), 2000)
  }

  const handleAioSave = () => {
    const inst = aioInstance.trim().replace(/\/+$/, '')
    if (inst) setItemSync('octostream_aiostreams_instance', inst)
    else removeItemSync('octostream_aiostreams_instance')
    if (aioUuid.trim()) setItemSync('octostream_aiostreams_uuid', aioUuid.trim())
    else removeItemSync('octostream_aiostreams_uuid')
    if (aioPass) setItemSync('octostream_aiostreams_password', aioPass)
    else removeItemSync('octostream_aiostreams_password')
    if (aioManifest.trim()) setItemSync('octostream_aiostreams_manifest', aioManifest.trim())
    else removeItemSync('octostream_aiostreams_manifest')
    setAioSaved(true)
    setTimeout(() => setAioSaved(false), 2000)
  }

  const handleAioTest = async () => {
    setAioTest({ loading: true })
    try {
      const { testAiostreamsConnection } = await import('../plugins/bundled/plurtasko/channels/aiostreams.js')
      setAioTest(await testAiostreamsConnection({ instance: aioInstance, uuid: aioUuid, password: aioPass, manifest: aioManifest }))
    } catch (e) {
      setAioTest({ ok: false, error: e?.message || 'Error desconocido' })
    }
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

  useEffect(() => {
    return () => {
      if (adPinTimerRef.current) clearInterval(adPinTimerRef.current)
    }
  }, [])

  // Refleja el estado real del túnel WARP/Aether (también si se conecta o cae
  // desde otra pantalla). No pisa 'connecting' mientras el handshake arranca.
  useEffect(() => {
    return subscribeWarpStatus(connected => {
      setVpnStatus(prev => connected ? 'connected' : prev === 'connecting' ? prev : 'disconnected')
    })
  }, [])

  // Credenciales SSH del VPS: la clave vive cifrada en el plugin nativo
  // (Android Keystore), no en localStorage. Al entrar se precarga para
  // repintar el formulario y migra el valor legacy en claro si quedara.
  useEffect(() => {
    if (!isAndroidNative()) return
    let dead = false
    ;(async () => {
      try {
        const creds = await CloudProxy.getRemoteSsh()
        if (dead) return
        if (creds?.user) setWarpSshUser(creds.user)
        if (creds?.port) setWarpSshPort(String(creds.port))
        const legacy = localStorage.getItem('octostream_warp_ssh_pass')
        if (creds?.pass) {
          setWarpSshPass(creds.pass)
        } else if (legacy) {
          setWarpSshPass(legacy)
          await CloudProxy.setRemoteSsh({
            user: creds?.user || localStorage.getItem('octostream_warp_ssh_user') || '',
            pass: legacy,
            port: creds?.port || parseInt(localStorage.getItem('octostream_warp_ssh_port') || '22', 10),
          })
        }
      } catch {}
      localStorage.removeItem('octostream_warp_ssh_pass')
    })()
    return () => { dead = true }
  }, [])

  // Detalle del túnel para el indicador (transporte, guardián, caídas).
  // Poll cada 10s mientras WARP está activo — es info de diagnóstico,
  // no necesita ser instantáneo.
  const [warpDetails, setWarpDetails] = useState(null)
  useEffect(() => {
    if (vpnStatus === 'disconnected') return // el render ya oculta datos viejos
    let alive = true
    const poll = async () => {
      const d = await getWarpDetails()
      if (alive && d) setWarpDetails(d)
    }
    poll()
    const t = setInterval(poll, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [vpnStatus])

  const toggleVpn = async () => {
    if (vpnStatus === 'connecting') return
    setVpnError('')
    try {
      if (vpnStatus === 'connected') {
        // Desconexión solo de sesión: WARP es siempre-activo y volverá a
        // conectarse solo en el próximo arranque o al volver a foreground.
        await CloudProxy.disconnect()
        await refreshWarpStatus()
        setVpnStatus('disconnected')
      } else {
        setVpnStatus('connecting')
        await CloudProxy.connect({ exitLoc: warpExitLoc })
        // El handshake puede tardar (hasta ~3min en modo doble salto la
        // primera vez): sondea el estado mientras el nativo lo reporta.
        for (let i = 0; i < 60; i++) {
          const st = await CloudProxy.getStatus().catch(() => ({}))
          if (st?.connected) { setVpnStatus('connected'); return }
          if (!st?.connecting && i > 0) break // falló el handshake
          await new Promise(r => setTimeout(r, 1000))
        }
        await refreshWarpStatus().catch(() => false)
        setVpnStatus('disconnected')
        setVpnError('WARP no conectó — comprueba la red e inténtalo de nuevo')
      }
    } catch (e) {
      setVpnError(e?.message || 'Error con WARP')
      setVpnStatus('disconnected')
    }
  }

  const toggleWarpStrict = () => {
    const next = !warpStrict
    setWarpStrict(next)
    localStorage.setItem('octostream_warp_strict', next ? 'true' : 'false')
    CloudProxy.setStrictMode(next).catch(() => {})
  }

  const applyWarpRemote = async (host) => {
    const { host: h, port: embeddedPort } = parseRemoteHostInput(host)
    setWarpRemote(h)
    localStorage.setItem('octostream_warp_remote', h)
    if (embeddedPort) await applyWarpRemoteSsh(warpSshUser, warpSshPass, embeddedPort)
    try { await CloudProxy.setRemoteHost(h) } catch {}
    // Con el túnel vivo el cambio de origen solo aplica reconectando.
    if (vpnStatus === 'connected') {
      try { await CloudProxy.disconnect() } catch {}
      setVpnStatus('disconnected')
      setVpnError(h ? 'Reconecta para usar el WARP remoto' : 'Reconecta para usar el WARP local')
    }
  }

  const applyWarpRemoteSsh = async (u, p, port) => {
    const user = (u || '').trim()
    const pass = p || ''
    const prt = parseInt(port, 10) || 22
    setWarpSshUser(user)
    setWarpSshPass(pass)
    setWarpSshPort(String(prt))
    localStorage.setItem('octostream_warp_ssh_user', user)
    // La clave la persiste el plugin nativo cifrada con Android Keystore —
    // no duplicarla en claro en localStorage.
    localStorage.removeItem('octostream_warp_ssh_pass')
    localStorage.setItem('octostream_warp_ssh_port', String(prt))
    try { await CloudProxy.setRemoteSsh({ user, pass, port: prt }) } catch {}
    if (vpnStatus === 'connected') {
      try { await CloudProxy.disconnect() } catch {}
      setVpnStatus('disconnected')
      setVpnError('Reconecta para aplicar el modo remoto')
    }
  }

  const changeWarpExit = async (id) => {
    setWarpExitLoc(id)
    localStorage.setItem('octostream_warp_exit', id)
    // Con el túnel vivo el cambio solo aplica reconectando — la
    // reconexión pasa por el mismo path que toggleVpn (con el nuevo modo).
    if (vpnStatus === 'connected' && vpnStatus !== 'connecting') {
      setVpnError('')
      try {
        await CloudProxy.disconnect()
        setVpnStatus('connecting')
        await CloudProxy.connect({ exitLoc: id })
        for (let i = 0; i < 60; i++) {
          const st = await CloudProxy.getStatus().catch(() => ({}))
          if (st?.connected) { setVpnStatus('connected'); return }
          if (!st?.connecting && i > 0) break
          await new Promise(r => setTimeout(r, 1000))
        }
        setVpnStatus('disconnected')
        setVpnError('WARP no conectó con esa salida — prueba otra')
      } catch (e) {
        setVpnError(e?.message || 'Error con WARP')
        setVpnStatus('disconnected')
      }
    }
  }

  const runLeakTest = async () => {
    setLeakBusy(true)
    try {
      setLeakTest(await checkIpLeak())
    } catch (e) {
      setLeakTest({ error: e?.message || 'falló la prueba' })
    }
    setLeakBusy(false)
  }

  const testVpsConnection = async () => {
    const { host, port: embeddedPort } = parseRemoteHostInput(warpRemote)
    const user = warpSshUser.trim()
    const pass = warpSshPass
    const port = embeddedPort || parseInt(warpSshPort, 10) || 22
    if (!isAndroidNative()) {
      setVpsTest({ ok: false, message: 'La prueba SSH del VPS está disponible en Android.' })
      return
    }
    if (!host || !user || !pass) {
      setVpsTest({ ok: false, message: 'Introduce la IP o dominio del VPS, el usuario y la contraseña SSH.' })
      return
    }

    setWarpRemote(host)
    setWarpSshPort(String(port))
    setVpsTestBusy(true)
    setVpsTest(null)
    setVpnStatus('connecting')
    try {
      localStorage.setItem('octostream_warp_remote', host)
      localStorage.setItem('octostream_warp_ssh_user', user)
      // La clave la guarda el plugin cifrada — no dejar copia en claro.
      localStorage.removeItem('octostream_warp_ssh_pass')
      localStorage.setItem('octostream_warp_ssh_port', String(port))
      await CloudProxy.setRemoteHost(host)
      await CloudProxy.setRemoteSsh({ user, pass, port })
      await CloudProxy.disconnect()
      await CloudProxy.connect({ exitLoc: warpExitLoc })

      const status = await CloudProxy.getStatus()
      // vps = forward SSH al VPS vivo; el protocolo muestra el aether
      // local (gool/mim) — ambos transportes corren a la vez.
      if (!status?.connected || !status?.vps || status.remote !== host) {
        throw new Error(status?.error || 'El túnel SSH o el proxy SOCKS del VPS no responde.')
      }
      setVpnStatus('connected')
      setWarpDetails(await getWarpDetails())
      setVpsTest({ ok: true, message: 'Conexión SSH correcta; el proxy del VPS responde y alcanza Internet.' })
    } catch (e) {
      setVpnStatus('disconnected')
      // Clave de host nueva/cambiada → pedir confirmación de la huella
      // (TOFU) antes de fijarla; no se confía en silencio.
      const hk = String(e?.message || '').match(/SSH_HOST_KEY_(UNKNOWN|CHANGED):(\S+)/)
      if (hk) {
        setHostKeyPrompt({ fingerprint: hk[2], changed: hk[1] === 'CHANGED' })
      } else {
        setVpsTest({ ok: false, message: e?.message || 'No se pudo conectar con el VPS.' })
      }
    } finally {
      setVpsTestBusy(false)
    }
  }

  // El usuario aceptó la huella mostrada → fijar la host key pendiente y
  // reintentar el túnel (ya no vuelve a preguntar para esta clave).
  const trustPendingHostKey = async () => {
    setHostKeyPrompt(null)
    setVpsTestBusy(true)
    setVpsTest(null)
    setVpnStatus('connecting')
    try {
      await CloudProxy.trustRemoteHost()
      await CloudProxy.disconnect()
      await CloudProxy.connect({ exitLoc: warpExitLoc })
      const status = await CloudProxy.getStatus()
      if (!status?.connected || !status?.vps) {
        throw new Error(status?.error || 'El túnel SSH o el proxy SOCKS del VPS no responde.')
      }
      setVpnStatus('connected')
      setWarpDetails(await getWarpDetails())
      setVpsTest({ ok: true, message: 'Clave del servidor fijada; el proxy del VPS responde y alcanza Internet.' })
    } catch (e) {
      setVpnStatus('disconnected')
      setVpsTest({ ok: false, message: e?.message || 'No se pudo conectar con el VPS.' })
    } finally {
      setVpsTestBusy(false)
    }
  }

  // --- Trakt PIN flow (OAuth device auth) ---
  // Necesita Client ID guardado; el Secret se usa para canjear el código.
  const handleTraktPinStart = useCallback(async () => {
    setTraktPinError('')
    const key = traktKey.trim() || localStorage.getItem('octostream_trakt_key') || ''
    const secret = traktSecret.trim() || localStorage.getItem('octostream_trakt_secret') || ''
    if (!key || !secret) {
      setTraktPinError('Guarda primero el Client ID y el Client Secret')
      return
    }
    localStorage.setItem('octostream_trakt_key', key)
    localStorage.setItem('octostream_trakt_secret', secret)
    setTraktPinLoading(true)
    setTraktPin(null)
    if (traktPinTimerRef.current) clearInterval(traktPinTimerRef.current)
    try {
      const dc = await traktDeviceCode(key)
      setTraktPin(dc)
      const startTime = Date.now()
      traktPinTimerRef.current = setInterval(async () => {
        if (traktPinPollingRef.current) return
        if (Date.now() - startTime > dc.expiresIn * 1000) {
          clearInterval(traktPinTimerRef.current)
          setTraktPinError('El código ha expirado')
          setTraktPin(null)
          setTraktPinLoading(false)
          return
        }
        traktPinPollingRef.current = true
        try {
          const result = await traktDeviceToken(dc.deviceCode, key, secret)
          if (result?.access_token) {
            clearInterval(traktPinTimerRef.current)
            setTraktPin(null)
            setTraktPinLoading(false)
            const me = await traktMe().catch(() => null)
            setTraktUser(me?.username || 'conectado')
          }
        } catch (e) {
          clearInterval(traktPinTimerRef.current)
          setTraktPinError(e?.message || 'Error al verificar el código')
          setTraktPin(null)
          setTraktPinLoading(false)
        } finally {
          traktPinPollingRef.current = false
        }
      }, dc.interval * 1000)
    } catch (e) {
      setTraktPinError(e?.message || 'Error al obtener el código')
      setTraktPinLoading(false)
    }
  }, [traktKey, traktSecret])

  const handleTraktPinCancel = useCallback(() => {
    if (traktPinTimerRef.current) clearInterval(traktPinTimerRef.current)
    setTraktPin(null)
    setTraktPinLoading(false)
  }, [])

  const handleTraktDisconnect = useCallback(() => {
    clearTraktTokens()
    setTraktUser('')
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
                <Toggle
                  checked={autoplayEnabled}
                  label="Activar autoplay de episodios"
                  onChange={newVal => {
                    setAutoplayEnabled(newVal)
                    localStorage.setItem('octostream_autoplay', newVal ? 'true' : 'false')
                  }}
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer pt-3 border-t border-dark-700/50">
                <div>
                  <span className="text-sm text-dark-300 block">Cambio automático de capítulo</span>
                  <span className="text-xs text-dark-500">Al terminar un episodio, reproduce el siguiente automáticamente</span>
                </div>
                <Toggle
                  checked={autoNextEp}
                  label="Cambio automático de capítulo"
                  onChange={newVal => {
                    setAutoNextEp(newVal)
                    localStorage.setItem('octostream_auto_next_ep', newVal ? 'true' : 'false')
                  }}
                />
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
                        invalidateLangPriority()
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
                        invalidateLangPriority()
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

          {/* MDBList API key */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <List className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">MDBList API Key</h3>
                <p className="text-dark-400 text-sm">
                  Habilita catálogos temáticos (plataformas, géneros, listas curadas)
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
                  value={mdbApiKey}
                  onChange={e => setMdbApiKey(e.target.value)}
                  placeholder="Introduce tu MDBList API key"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleMdbSave()}
                />
              </div>

              {mdbError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
                  <AlertCircle size={16} />
                  {mdbError}
                </div>
              )}

              {mdbSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleMdbSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key gratuita?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en mdblist.com</li>
                <li>Ve a Preferences → API Key</li>
                <li>Copia tu API key y pégala arriba</li>
              </ol>
              <a
                href="https://mdblist.com/preferences/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a mdblist.com
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {/* Trakt Client ID */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <TrendingUp className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Trakt Client ID</h3>
                <p className="text-dark-400 text-sm">
                  Habilita tendencias y listas públicas de Trakt.tv
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  Client ID
                </label>
                <input
                  type="password"
                  value={traktKey}
                  onChange={e => setTraktKey(e.target.value)}
                  placeholder="Introduce tu Trakt Client ID"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleTraktSave()}
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <Key size={14} />
                  Client Secret <span className="text-dark-500">(para conectar tu cuenta)</span>
                </label>
                <input
                  type="password"
                  value={traktSecret}
                  onChange={e => setTraktSecret(e.target.value)}
                  placeholder="Introduce tu Trakt Client Secret"
                  className="input w-full"
                  onKeyDown={e => e.key === 'Enter' && handleTraktSave()}
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                  <List size={14} />
                  Listas públicas (opcional)
                </label>
                <input
                  type="text"
                  value={traktLists}
                  onChange={e => setTraktLists(e.target.value)}
                  placeholder="usuario/slug, usuario/slug2:Nombre"
                  className="input w-full"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck="false"
                />
                <p className="text-dark-500 text-xs mt-1">
                  Separadas por coma. Ej: trakt/most-anticipated-movies
                </p>
              </div>

              {traktError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
                  <AlertCircle size={16} />
                  {traktError}
                </div>
              )}

              {traktSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
                  <Check size={16} />
                  Configuración guardada correctamente
                </div>
              )}

              <button onClick={handleTraktSave} className="btn-primary">
                <Check size={18} />
                Guardar
              </button>

              {/* Cuenta Trakt por PIN: watchlist, recomendaciones y listas propias */}
              <div className="pt-4 border-t border-dark-700">
                <p className="text-dark-400 text-sm mb-3">
                  Conecta tu cuenta para ver tu watchlist, recomendaciones y tus listas:
                </p>
                {(traktUser || getTraktToken()) && !traktPin && !traktPinLoading && (
                  <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-lg p-3">
                    <span className="flex items-center gap-2 text-green-400 text-sm">
                      <Check size={16} />
                      Conectado{traktUser ? ` como @${traktUser}` : ''}
                    </span>
                    <button onClick={handleTraktDisconnect} className="text-dark-400 text-sm hover:text-red-400">
                      Desconectar
                    </button>
                  </div>
                )}
                {!traktUser && !getTraktToken() && !traktPin && !traktPinLoading && (
                  <button onClick={handleTraktPinStart} className="btn-secondary">
                    <Key size={16} />
                    Conectar con PIN
                  </button>
                )}
                {traktPinLoading && !traktPin && (
                  <div className="flex items-center gap-2 text-dark-400 text-sm">
                    <OctoLoader size={16} />
                    Obteniendo código...
                  </div>
                )}
                {traktPin && (
                  <div className="bg-primary-600/10 border border-primary-600/30 rounded-lg p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="text-3xl font-bold text-primary-400 tracking-wider">{traktPin.userCode}</div>
                      <div className="flex items-center gap-1 text-dark-400 text-sm">
                        <OctoLoader size={14} />
                        Esperando autorización...
                      </div>
                    </div>
                    <a
                      href={traktPin.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary-400 text-sm hover:text-primary-300"
                    >
                      Introduce el código en trakt.tv/activate
                      <ExternalLink size={14} />
                    </a>
                    <button onClick={handleTraktPinCancel} className="text-dark-400 text-sm hover:text-red-400">
                      Cancelar
                    </button>
                  </div>
                )}
                {traktPinError && (
                  <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3 mt-2">
                    <AlertCircle size={16} />
                    {traktPinError}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo obtener un Client ID gratuito?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>Regístrate en trakt.tv</li>
                <li>Ve a Settings → Your API Applications → New</li>
                <li>Rellena el formulario (redirect URI puede ser cualquier URL)</li>
                <li>Copia el &quot;Client ID&quot; (y el &quot;Client Secret&quot; para conectar tu cuenta)</li>
              </ol>
              <a
                href="https://trakt.tv/oauth/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
              >
                Ir a trakt.tv
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

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
                <span className="text-dark-400">MDBList API Key</span>
                {localStorage.getItem('octostream_mdblist_key') ? (
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
                <span className="text-dark-400">Trakt Client ID</span>
                {localStorage.getItem('octostream_trakt_key') ? (
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
                <span className="text-dark-400">Trakt cuenta</span>
                {localStorage.getItem('octostream_trakt_token') ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <Check size={14} /> Conectada{localStorage.getItem('octostream_trakt_user') ? ` (@${localStorage.getItem('octostream_trakt_user')})` : ''}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-dark-500">
                    <AlertCircle size={14} /> No conectada
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

      {/* Tab: Subtítulos */}
      {activeTab === 'subs' && (
        <div className="space-y-6">
          {/* Subtítulos automáticos en español */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Captions className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Subtítulos automáticos</h3>
                <p className="text-dark-400 text-sm">
                  Si el audio no es español, busca y aplica subs en español al reproducir
                </p>
              </div>
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-dark-300">
                Subtítulos en español automáticos
                <span className="block text-xs text-dark-500">
                  OpenSubtitles → traducción IA → transcripción de audio (duck.ai, sin claves)
                </span>
              </span>
              <Toggle
                checked={autoSubs}
                onChange={newVal => {
                  setAutoSubs(newVal)
                  localStorage.setItem('octostream_autosubs', newVal ? 'true' : 'false')
                }}
                label="Subtítulos automáticos en español"
                color="green"
              />
            </label>
          </div>

          {/* OpenSubtitles API key */}
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

          {/* Estilo de subtítulos: se aplica en caliente al SubtitleView
              nativo (Android) o a mpv (Electron). */}
          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Captions className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Estilo de subtítulos</h3>
                <p className="text-dark-400 text-sm">
                  Tamaño, color, fondo y posición — se aplica en el momento
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-dark-300 text-sm mb-2">Tamaño</p>
                <div className="flex gap-2 flex-wrap">
                  {[[0.75, '75%'], [1.0, '100%'], [1.25, '125%'], [1.5, '150%']].map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => updSubStyle({ scale: v })}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        subStyle.scale === v ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300'
                      }`}
                    >{label}</button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-dark-300 text-sm mb-2">Color del texto</p>
                <div className="flex gap-2 flex-wrap">
                  {[['#FFFFFF', 'Blanco'], ['#FFE135', 'Amarillo'], ['#33FFFF', 'Cian'], ['#7CFC00', 'Verde'], ['#FF9E3D', 'Naranja']].map(([hex, label]) => (
                    <button
                      key={hex}
                      onClick={() => updSubStyle({ color: hex })}
                      className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 ${
                        subStyle.color === hex ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300'
                      }`}
                    >
                      <span className="w-3.5 h-3.5 rounded-full border border-white/40" style={{ backgroundColor: hex }} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-dark-300 text-sm mb-2">Fondo</p>
                <div className="flex gap-2 flex-wrap">
                  {[['#00000000', 'Sin fondo'], ['#80000000', 'Semi'], ['#FF000000', 'Opaco']].map(([hex, label]) => (
                    <button
                      key={hex}
                      onClick={() => updSubStyle({ bg: hex })}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        subStyle.bg === hex ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300'
                      }`}
                    >{label}</button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-dark-300 text-sm mb-2">Posición vertical</p>
                <div className="flex gap-2 flex-wrap">
                  {[[0.02, 'Bajo'], [0.08, 'Medio'], [0.16, 'Alto']].map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => updSubStyle({ bottom: v })}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        subStyle.bottom === v ? 'bg-primary-600 text-white' : 'bg-dark-700 text-dark-300'
                      }`}
                    >{label}</button>
                  ))}
                </div>
              </div>

              {/* Vista previa aproximada del resultado */}
              <div className="bg-black rounded-lg h-20 flex items-end justify-center pb-2 overflow-hidden">
                <span
                  className="px-2 rounded leading-snug text-center"
                  style={{
                    color: subStyle.color,
                    backgroundColor: subStyle.bg,
                    fontSize: `${Math.round(13 * subStyle.scale)}px`,
                    marginBottom: `${Math.round(subStyle.bottom * 100)}px`,
                    textShadow: '0 0 3px #000, 0 0 3px #000',
                  }}
                >Así se verán los subtítulos</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Debrid */}
      {activeTab === 'debrid' && (
        <div className="space-y-6">
          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-white font-bold">AllDebrid API Key</h3>
                <p className="text-dark-400 text-sm mt-1">
                  Desbloquea hosters y torrents al instante (streaming directo, sin esperar descarga)
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <input
                type="password"
                value={adApiKey}
                onChange={e => setAdApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdSave()}
                placeholder="Introduce tu AllDebrid API key"
                className="w-full bg-dark-700 text-white rounded-lg px-4 py-3 border border-dark-600 focus:border-primary-500 focus:outline-none"
              />
              {adSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm">
                  <Check size={16} />
                  Guardado
                </div>
              )}
              <button
                onClick={handleAdSave}
                className="w-full bg-primary-600 hover:bg-primary-500 text-white font-medium rounded-lg px-4 py-3 transition-colors"
              >
                Guardar AllDebrid
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
                <li>Regístrate en alldebrid.com (servicio de pago)</li>
                <li>Ve a alldebrid.com/apikeys</li>
                <li>Copia tu API key y pégala arriba</li>
              </ol>
            </div>
          </div>

          {/* Auditoría de la clave: cuenta, uso reciente y propagación por sync */}
          {localStorage.getItem('octostream_alldebrid_key') && (
            <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold">Cuenta y actividad</h3>
                  <p className="text-dark-400 text-sm mt-1">
                    Quién usa esta clave — si ves desbloqueos que no son tuyos, regenera la API key
                  </p>
                </div>
                <button
                  onClick={loadAdAudit}
                  disabled={adAuditBusy}
                  className="btn-secondary px-3 py-1.5 text-sm flex-shrink-0"
                >
                  {adAuditBusy ? 'Consultando…' : 'Ver actividad'}
                </button>
              </div>
              {adAudit && (
                <div className="space-y-3 text-sm">
                  {adAudit.account ? (
                    <p className="text-dark-300">
                      Cuenta
                      {adAudit.account.isPremium
                        ? <span className="text-emerald-400"> · premium{adAudit.account.premiumUntil
                            ? ` hasta ${new Date((adAudit.account.premiumUntil > 1e12 ? adAudit.account.premiumUntil : adAudit.account.premiumUntil * 1000)).toLocaleDateString()}`
                            : ''}</span>
                        : <span className="text-amber-400"> · sin premium activo</span>}
                    </p>
                  ) : (
                    <p className="text-dark-400">No se pudo leer la cuenta.</p>
                  )}
                  {adAudit.history.length > 0 && (
                    <div>
                      <p className="text-dark-400 text-xs mb-1">Últimos enlaces desbloqueados con la clave:</p>
                      <ul className="space-y-1">
                        {adAudit.history.slice(0, 6).map((h, i) => (
                          <li key={i} className="flex items-center justify-between gap-2 text-xs bg-dark-700/50 rounded px-2 py-1">
                            <span className="text-dark-200 truncate">{h.filename || h.link}</span>
                            <span className="text-dark-500 flex-shrink-0">{h.date ? new Date(h.date > 1e12 ? h.date : h.date * 1000).toLocaleDateString() : ''}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {adAudit.propagation.length > 0 && (
                    <div>
                      <p className="text-dark-400 text-xs mb-1">Clave entregada por sincronización a:</p>
                      <ul className="space-y-1">
                        {adAudit.propagation.slice(0, 5).map((p, i) => (
                          <li key={i} className="text-xs text-dark-300">
                            {p.alias} — <span className="text-dark-500">{new Date(p.ts).toLocaleString()}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-white font-bold">AIOStreams</h3>
                <p className="text-dark-400 text-sm mt-1">
                  Agregador de fuentes (providers + debrid) por IMDb — como el addon POV de Kodi
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-dark-400 text-xs mb-1 block">URL de manifest (recomendado — funciona en elfhosted sin contraseña)</label>
                <input
                  type="text"
                  value={aioManifest}
                  onChange={e => setAioManifest(e.target.value)}
                  placeholder="https://aiostreams.elfhosted.com/stremio/<uuid>/<config>/manifest.json"
                  className="w-full bg-dark-700 text-white rounded-lg px-4 py-3 border border-dark-600 focus:border-primary-500 focus:outline-none"
                />
              </div>
              <div className="border-t border-dark-700 pt-3">
                <label className="text-dark-400 text-xs mb-1 block">Alternativa (solo self-hosted con Search API activada)</label>
                <input
                  type="text"
                  value={aioInstance}
                  onChange={e => setAioInstance(e.target.value)}
                  placeholder="https://aiostreams.elfhosted.com"
                  className="w-full bg-dark-700 text-white rounded-lg px-4 py-3 border border-dark-600 focus:border-primary-500 focus:outline-none mb-2"
                />
                <input
                  type="text"
                  value={aioUuid}
                  onChange={e => setAioUuid(e.target.value)}
                  placeholder="UUID"
                  className="w-full bg-dark-700 text-white rounded-lg px-4 py-3 border border-dark-600 focus:border-primary-500 focus:outline-none mb-2"
                />
                <input
                  type="password"
                  value={aioPass}
                  onChange={e => setAioPass(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAioSave()}
                  placeholder="Contraseña"
                  className="w-full bg-dark-700 text-white rounded-lg px-4 py-3 border border-dark-600 focus:border-primary-500 focus:outline-none"
                />
              </div>
              {aioSaved && (
                <div className="flex items-center gap-2 text-green-400 text-sm">
                  <Check size={16} />
                  Guardado
                </div>
              )}
              <button
                onClick={handleAioSave}
                className="w-full bg-primary-600 hover:bg-primary-500 text-white font-medium rounded-lg px-4 py-3 transition-colors"
              >
                Guardar AIOStreams
              </button>
              <button
                onClick={handleAioTest}
                disabled={aioTest?.loading}
                className="w-full bg-dark-700 hover:bg-dark-600 text-white font-medium rounded-lg px-4 py-3 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {aioTest?.loading ? <OctoLoader size={16} className="text-primary-300" /> : <Check size={16} />}
                {aioTest?.loading ? 'Comprobando…' : 'Probar conexión'}
              </button>
              {aioTest && !aioTest.loading && (
                <div className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${aioTest.ok ? 'text-green-400 bg-green-950/30' : 'text-red-400 bg-red-950/30'}`}>
                  {aioTest.ok ? <Check size={16} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />}
                  <span>
                    {aioTest.ok
                      ? `Conexión correcta — ${aioTest.results} fuente${aioTest.results === 1 ? '' : 's'} encontrada${aioTest.results === 1 ? '' : 's'}${aioTest.hint || ''}`
                      : aioTest.error}
                  </span>
                </div>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-dark-400 text-sm mb-2">¿Cómo configurarlo?</p>
              <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
                <li>
                  Abre{' '}
                  <a href={`${aioInstance.trim() || 'https://aiostreams.elfhosted.com'}/stremio/configure`} target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:text-primary-300">
                    {aioInstance.trim() || 'https://aiostreams.elfhosted.com'}/stremio/configure
                    <ExternalLink size={12} className="inline ml-1" />
                  </a>
                </li>
                <li>Activa los providers que quieras (en español: Torrentio ES, MediaFusion…)</li>
                <li>Crea una contraseña → te dará un UUID y la URL de instalación</li>
                <li>Copia la URL de manifest (termina en <code>/manifest.json</code>) y pégala en el primer campo</li>
                <li>UUID + contraseña solo hacen falta en instancias propias con la Search API activada (elfhosted la tiene desactivada)</li>
              </ol>
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
              <div className="flex items-center justify-between">
                <span className="text-dark-400">AIOStreams (manifest o UUID + contraseña)</span>
                {localStorage.getItem('octostream_aiostreams_manifest') || (localStorage.getItem('octostream_aiostreams_uuid') && localStorage.getItem('octostream_aiostreams_password')) ? (
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
                  Conexión WARP propia o salida remota por VPS.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-dark-300">
                  {vpnStatus === 'connecting' ? 'Conectando...' : vpnStatus === 'connected' ? 'Conectado' : 'Desconectado'}
                </span>
                <Toggle
                  checked={vpnStatus === 'connected' || vpnStatus === 'connecting'}
                  onChange={toggleVpn}
                  disabled={vpnStatus === 'connecting'}
                  label="Cloudflare WARP"
                  color={vpnStatus === 'connecting' ? 'yellow' : 'green'}
                />
              </label>
              {vpnError && (
                <p className="text-red-400 text-sm">{vpnError}</p>
              )}
              {vpnStatus !== 'disconnected' && warpDetails && (
                <p className="text-dark-400 text-xs">
                  {warpDetails.protocol
                    ? `Transporte: ${warpDetails.protocol === 'masque-h2' ? 'MASQUE/HTTP2 (TCP)' : warpDetails.protocol === 'wg' ? 'WireGuard' : warpDetails.protocol === 'gool' ? 'WARP·WARP (doble salto)' : warpDetails.protocol === 'mim' ? 'MASQUE·MASQUE (doble salto)' : warpDetails.protocol === 'remote' ? `WARP remoto (${warpDetails.remote})` : warpDetails.protocol === 'remote-ssh' ? `SSH remoto (${warpDetails.remote})` : 'MASQUE (QUIC)'}`
                    : 'Transporte: —'}
                  {warpDetails.vps ? ` + VPS·debrid (${warpDetails.remote})` : ''}
                  {warpDetails.exitCountry ? ` · salida ${warpDetails.exitCountry}${warpDetails.exitColo ? '/' + warpDetails.exitColo : ''}` : ''}
                  {warpDetails.guard ? ' · guardián activo' : ''}
                  {warpDetails.tunnelFails > 0 ? ` · inestable (${warpDetails.tunnelFails} caídas)` : ''}
                  {warpDetails.reconnects > 0 ? ` · ${warpDetails.reconnects} reconexión${warpDetails.reconnects > 1 ? 'es' : ''}` : ''}
                  {warpDetails.uptimeMs > 0 ? ` · arriba ${Math.round(warpDetails.uptimeMs / 60000)} min` : ''}
                </p>
              )}
              <details className="rounded-lg border border-dark-700 px-3 py-2">
                <summary className="cursor-pointer text-sm text-dark-300">País de salida</summary>
                <div className="pt-2">
                <p className="text-sm text-dark-300">
                  <span className="block text-xs text-dark-500">
                    Doble salto Cloudflare. Automático suele ser la mejor opción.
                  </span>
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {[
                    { id: 'auto', label: 'Automático' },
                    { id: 'random', label: 'Otro país' },
                    { id: 'DE', label: 'Alemania' },
                    { id: 'NL', label: 'Países Bajos' },
                    { id: 'IS', label: 'Islandia' },
                    { id: 'FR', label: 'Francia' },
                    { id: 'GB', label: 'Reino Unido' },
                    { id: 'US', label: 'EE.UU.' },
                    { id: 'CH', label: 'Suiza' },
                  ].map(o => (
                    <button
                      key={o.id}
                      onClick={() => changeWarpExit(o.id)}
                      disabled={vpnStatus === 'connecting'}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${warpExitLoc === o.id ? 'bg-primary-600 text-white' : 'bg-dark-700 hover:bg-dark-600 text-dark-200'}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                </div>
              </details>
              {isAndroidNative() && <div className="pt-2 border-t border-dark-700/50">
                <div>
                  <p className="text-sm text-dark-300">
                    Servidor remoto (VPS)
                    <span className="block text-xs text-dark-500">
                      Déjalo vacío para usar WARP en este dispositivo.
                    </span>
                  </p>
                    <input
                      type="text"
                      value={warpRemote}
                    onChange={e => { setWarpRemote(e.target.value); setVpsTest(null) }}
                    onBlur={e => applyWarpRemote(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && applyWarpRemote(e.target.value)}
                    placeholder="IP o dominio del VPS"
                    className="input w-full mt-1"
                  />
                </div>
                <div className="mt-3">
                  <p className="text-sm text-dark-300">
                    Acceso SSH al VPS
                    <span className="block text-xs text-dark-500">
                      Usuario, contraseña y puerto SSH del VPS.
                    </span>
                  </p>
                  <div className="grid grid-cols-3 gap-2 mt-1">
                    <input
                      type="text"
                      value={warpSshUser}
                      onChange={e => { setWarpSshUser(e.target.value); setVpsTest(null) }}
                      onBlur={e => applyWarpRemoteSsh(e.target.value, warpSshPass, warpSshPort)}
                      placeholder="usuario (octo)"
                      autoComplete="off"
                      className="input w-full"
                    />
                    <input
                      type="password"
                      value={warpSshPass}
                      onChange={e => { setWarpSshPass(e.target.value); setVpsTest(null) }}
                      onBlur={e => applyWarpRemoteSsh(warpSshUser, e.target.value, warpSshPort)}
                      placeholder="contraseña"
                      autoComplete="new-password"
                      className="input w-full"
                    />
                    <input
                      type="text"
                      value={warpSshPort}
                      onChange={e => { setWarpSshPort(e.target.value); setVpsTest(null) }}
                      onBlur={e => applyWarpRemoteSsh(warpSshUser, warpSshPass, e.target.value)}
                      placeholder="22"
                      inputMode="numeric"
                      className="input w-full"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={testVpsConnection}
                    disabled={vpsTestBusy}
                    className="mt-3 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {vpsTestBusy ? 'Probando conexión…' : 'Probar y conectar con el VPS'}
                  </button>
                  {vpsTest && (
                    <p className={`mt-2 text-sm ${vpsTest.ok ? 'text-green-400' : 'text-red-400'}`}>
                      {vpsTest.message}
                    </p>
                  )}
                </div>
              </div>}
              {hostKeyPrompt && (
                <Modal onClose={() => setHostKeyPrompt(null)} labelledBy="ssh-hostkey-title">
                  <h3 id="ssh-hostkey-title" className="text-lg font-semibold text-dark-100 mb-2">
                    {hostKeyPrompt.changed ? 'La clave del servidor cambió' : 'Verificar el servidor VPS'}
                  </h3>
                  <p className="text-sm text-dark-300">
                    {hostKeyPrompt.changed
                      ? 'La clave SSH que presenta el VPS es distinta de la guardada. Si reinstalaste el servidor es normal; si no, puede ser un intento de interceptar la conexión.'
                      : 'Primera conexión con este VPS. Comprueba que la huella coincide con la clave del servidor antes de confiar.'}
                  </p>
                  <p className="mt-3 rounded-lg bg-dark-900 px-3 py-2 font-mono text-xs text-primary-300 break-all select-all">
                    {hostKeyPrompt.fingerprint}
                  </p>
                  <div className="mt-4 flex gap-2 justify-end">
                    <button
                      onClick={() => setHostKeyPrompt(null)}
                      className="rounded-lg bg-dark-700 px-4 py-2 text-sm text-dark-200 hover:bg-dark-600"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={trustPendingHostKey}
                      className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${hostKeyPrompt.changed ? 'bg-red-600 hover:bg-red-500' : 'bg-primary-600 hover:bg-primary-500'}`}
                    >
                      Confiar y conectar
                    </button>
                  </div>
                </Modal>
              )}
              <details className="rounded-lg border border-dark-700 px-3 py-2">
                <summary className="cursor-pointer text-sm text-dark-300">Protección y diagnóstico</summary>
                <div className="space-y-3 pt-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-dark-300">
                  Kill-switch estricto
                  <span className="block text-xs text-dark-500">
                    Si el túnel cae, toda la red se corta en vez de salir por tu IP real
                  </span>
                </span>
                <Toggle
                  checked={warpStrict}
                  onChange={toggleWarpStrict}
                  label="Kill-switch estricto WARP"
                  color="yellow"
                />
              </label>
              {isAndroidNative() && (
                <div className="pt-1">
                  <button
                    onClick={runLeakTest}
                    disabled={leakBusy}
                    className="text-xs bg-dark-700 hover:bg-dark-600 disabled:opacity-50 text-dark-200 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    {leakBusy ? 'Comprobando…' : 'Comprobar fugas de IP'}
                  </button>
                  {leakTest && !leakBusy && (
                    <div className="mt-2 text-xs space-y-1">
                      {leakTest.error ? (
                        <p className="text-red-400">{leakTest.error}</p>
                      ) : (
                        <>
                          <p className="text-dark-300">
                            Por la app (IPv4): {leakTest.tunnel?.ip || '—'}
                            {leakTest.tunnel?.colo ? ` (${leakTest.tunnel.colo})` : ''}
                            {leakTest.tunnel?.warp ? ` · warp=${leakTest.tunnel.warp}` : ''}
                            {leakTest.tunnel?.error ? ` · ${leakTest.tunnel.error}` : ''}
                          </p>
                          {leakTest.direct && (
                            <p className="text-dark-300">
                              Tu red real: {leakTest.direct.ip || '—'}
                              {leakTest.direct.loc ? ` (${leakTest.direct.loc})` : ''}
                            </p>
                          )}
                          {leakTest.tunnel?.ip && leakTest.direct?.ip && (
                            <p className={leakTest.tunnel.ip !== leakTest.direct.ip ? 'text-green-400' : 'text-red-400'}>
                              {leakTest.tunnel.ip !== leakTest.direct.ip
                                ? 'Sin fuga: la app sale por una IP distinta a la tuya'
                                : 'FUGA: el tráfico sale por tu IP real'}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
                </div>
              </details>
            </div>
          </div>

        </div>
      )}

      {/* Tab: Sincronizar — los OctoStream de la red se descubren solos
          (estilo LocalSend); pulsar uno da a elegir Descargar o Enviar. */}
      {activeTab === 'sync' && (
        <div className="space-y-6">
          {(isAndroidNative() || isElectron()) ? (
            <SyncDevices />
          ) : (
            <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                  <RefreshCw className="text-primary-400" size={22} />
                </div>
                <div>
                  <h3 className="text-white font-bold">Sincronizar dispositivos</h3>
                  <p className="text-sm text-dark-400">Disponible en la app de Android y de escritorio (Windows/Linux)</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab: Miscelánea */}
      {activeTab === 'profiles' && <ProfileSettings />}

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

          {isAndroidNative() && (
            <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                  <Download className="text-primary-400" size={22} />
                </div>
                <div>
                  <h3 className="text-white font-bold">Actualizaciones</h3>
                  <p className="text-dark-400 text-sm">
                    La app busca novedades sola cada hora — aquí puedes forzarlo
                  </p>
                </div>
              </div>
              <button
                data-tv-card
                tabIndex={0}
                disabled={checkingUpdate}
                onClick={async () => {
                  setCheckingUpdate(true)
                  setUpdateMsg('')
                  try {
                    const u = await checkForUpdate({ force: true })
                    if (u) window.dispatchEvent(new CustomEvent('octostream:show-update', { detail: u }))
                    else setUpdateMsg('Ya estás en la última versión')
                  } catch {
                    setUpdateMsg('No se pudo comprobar — revisa la conexión')
                  } finally {
                    setCheckingUpdate(false)
                  }
                }}
                className="btn-primary px-4 py-3 flex items-center gap-2"
              >
                <RefreshCw size={18} className={checkingUpdate ? 'animate-spin' : ''} />
                {checkingUpdate ? 'Comprobando…' : 'Buscar actualización'}
              </button>
              {updateMsg && <p className="text-dark-400 text-sm mt-3">{updateMsg}</p>}
            </div>
          )}

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <Download className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Copia de seguridad</h3>
                <p className="text-dark-400 text-sm">
                  Elige qué incluir en el archivo JSON
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {BACKUP_CATEGORIES.map(cat => (
                <label
                  key={cat.id}
                  data-tv-card
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBackupCats(c => ({ ...c, [cat.id]: !c[cat.id] })) } }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer select-none text-sm transition-colors ${backupCats[cat.id] ? 'bg-primary-600/20 border-primary-500 text-white' : 'bg-dark-900 border-dark-700 text-dark-400'}`}
                >
                  <input
                    type="checkbox"
                    tabIndex={-1}
                    checked={backupCats[cat.id]}
                    onChange={() => setBackupCats(c => ({ ...c, [cat.id]: !c[cat.id] }))}
                    className="accent-primary-500"
                  />
                  {cat.label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                data-tv-card
                tabIndex={0}
                onClick={async () => {
                  setBackupMsg('')
                  try {
                    const cats = BACKUP_CATEGORIES.filter(c => backupCats[c.id]).map(c => c.id)
                    if (!cats.length) { setBackupMsg('Marca al menos una sección'); return }
                    const ok = await exportSettings(cats)
                    setBackupMsg(ok ? 'Copia guardada' : '')
                  } catch (e) {
                    setBackupMsg(`No se pudo exportar: ${e?.message || 'error'}`)
                  }
                }}
                className="btn-secondary px-4 py-3 flex items-center gap-2"
              >
                <Download size={18} /> Exportar
              </button>
              <button
                data-tv-card
                tabIndex={0}
                onClick={async () => {
                  setBackupMsg('')
                  try {
                    const cats = BACKUP_CATEGORIES.filter(c => backupCats[c.id]).map(c => c.id)
                    if (!cats.length) { setBackupMsg('Marca al menos una sección'); return }
                    const n = await importSettings(cats)
                    setBackupMsg(n > 0 ? `Restauradas ${n} claves — reinicia la app para aplicarlo todo` : '')
                  } catch (e) {
                    setBackupMsg(e?.message || 'No se pudo importar')
                  }
                }}
                className="btn-secondary px-4 py-3 flex items-center gap-2"
              >
                <RefreshCw size={18} /> Importar
              </button>
            </div>
            {backupMsg && <p className="text-dark-400 text-sm mt-3">{backupMsg}</p>}
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

            <div className="space-y-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-sm text-dark-300 block">Buscar enlaces torrent</span>
                <span className="text-xs text-dark-500">Si se apaga, los sitios torrent no se consultan ni aparecen sus enlaces</span>
              </div>
              <Toggle
                checked={torrentSearch}
                label="Buscar enlaces torrent"
                onChange={newVal => {
                  setTorrentSearch(newVal)
                  localStorage.setItem('octostream_torrent_search', newVal ? 'true' : 'false')
                }}
              />
            </label>

            </div>
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
                <Toggle
                  checked={ssEnabled}
                  onChange={setSsEnabled}
                  label="Activar salvapantallas automático"
                />
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

          <div className="bg-dark-800 rounded-xl p-5 border border-dark-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                <AlertCircle className="text-primary-400" size={22} />
              </div>
              <div>
                <h3 className="text-white font-bold">Aviso legal</h3>
                <p className="text-dark-400 text-sm">
                  Responsabilidad sobre el contenido mostrado
                </p>
              </div>
            </div>

            <p className="text-dark-400 text-sm leading-relaxed">
              OctoStream es un navegador y agregador: <span className="text-dark-300">no aloja, almacena ni distribuye ningún contenido</span>.
              Todo el material se enlaza desde fuentes públicas ya disponibles en Internet, que son
              responsabilidad exclusiva de los sitios de terceros que lo sirven. Si eres titular de
              derechos y quieres retirar un enlace, contacta con la web que aloja el contenido.
            </p>
          </div>
        </div>
      )}
      </div>
      </div>
      )}
    </div>
  )
}