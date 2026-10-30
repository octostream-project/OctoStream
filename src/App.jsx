import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { Menu } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Sidebar from './components/Sidebar.jsx'
import BottomNav from './components/BottomNav.jsx'
import Screensaver from './components/Screensaver.jsx'
import RemotePlayReceiver from './components/RemotePlayReceiver.jsx'
import UpdateChecker from './components/UpdateChecker.jsx'
import LogoLoader from './components/LogoLoader.jsx'
import { ToastHost } from './components/ui/Toast.jsx'
import { useStore } from './store/useStore.js'
import { isAndroidNative, isElectron } from './utils/platform.js'
import { initTvNavigation, refocusAfterPageChange, isPlayerOpen, getPlayerClosedAt } from './utils/tvNavigation.js'
import { CloudProxy } from './utils/cloudProxy.js'
import { refreshWarpStatus, resetWarpReady, subscribeWarpStatus } from './utils/warpStatus.js'
import { startLoadPlan } from './utils/loadPlan.js'
import { AppUpdater } from './utils/appUpdater.js'
import { getTorrentEngine } from './utils/torrentEngine.js'
import { promptStorageAccessOnce } from './utils/storageAccessOnboarding.js'
import { toast } from './components/ui/Toast.jsx'

// Lazy-loaded pages: each route becomes its own chunk.
const Home = lazy(() => import('./pages/Home.jsx'))
const Search = lazy(() => import('./pages/Search.jsx'))
const YouTube = lazy(() => import('./pages/YouTube.jsx'))
const Details = lazy(() => import('./pages/Details.jsx'))
const Catalog = lazy(() => import('./pages/Catalog.jsx'))
const Favorites = lazy(() => import('./pages/Favorites.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const Plugins = lazy(() => import('./pages/Plugins.jsx'))
const AddStream = lazy(() => import('./pages/AddStream.jsx'))
const Settings = lazy(() => import('./pages/Settings.jsx'))
const CastReceiver = lazy(() => import('./pages/CastReceiver.jsx'))
const LiveTV = lazy(() => import('./pages/LiveTV.jsx'))
const Sports = lazy(() => import('./pages/Sports.jsx'))
const Calendar = lazy(() => import('./pages/Calendar.jsx'))
const Sync = lazy(() => import('./pages/Sync.jsx'))

const SCREENSAVER_ENABLED_KEY = 'octostream_screensaver_enabled'
const SCREENSAVER_TIMEOUT_KEY = 'octostream_screensaver_timeout'

function useIdleScreensaver() {
  const [active, setActive] = useState(false)
  const timerRef = useRef(null)
  const location = useLocation()

  // localStorage es síncrono; leer una vez por montaje en vez de por render
  const { enabled, timeoutMs } = useMemo(() => {
    const en = localStorage.getItem(SCREENSAVER_ENABLED_KEY) !== 'false'
    const mins = parseInt(localStorage.getItem(SCREENSAVER_TIMEOUT_KEY) || '5', 10)
    return { enabled: en, timeoutMs: Math.max(1, mins) * 60 * 1000 }
  }, [])

  const resetTimerRef = useRef(() => {})
  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!enabled) return
    timerRef.current = setTimeout(() => {
      // No activar durante la reproducción: el player nativo es un diálogo
      // que no cambia la ruta, así que el guard por pathname no lo ve.
      const playing = isPlayerOpen() || document.querySelector('[data-player-overlay]')
      if (playing) { resetTimerRef.current(); return }
      setActive(true)
    }, timeoutMs)
  }, [enabled, timeoutMs])
  useEffect(() => { resetTimerRef.current = resetTimer }, [resetTimer])

  useEffect(() => {
    if (!enabled) return
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel', 'click']
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()
    return () => {
      events.forEach(e => window.removeEventListener(e, resetTimer))
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [resetTimer, enabled])

  // Don't trigger screensaver while playing video (details page or cast) —
  // patrón "ajustar estado en render" (igual que routesMounted abajo).
  const [prevPath, setPrevPath] = useState(location.pathname)
  if (prevPath !== location.pathname) {
    setPrevPath(location.pathname)
    const onPlayerPage = location.pathname.startsWith('/details/') || location.pathname === '/cast'
    if (active && onPlayerPage) setActive(false)
  }

  const dismiss = useCallback(() => setActive(false), [])
  return { active, dismiss }
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Arranque en frío: con túnel en autoconnect la UI arranca YA bloqueada
  // hasta el primer chequeo de estado — si no, Home monta y las <img> de
  // TMDB salen por la IP real antes del CONNECTED (fuga).
  const [warpBlocking, setWarpBlocking] = useState(() => isAndroidNative())
  const [warpSkipped, setWarpSkipped] = useState(false)
  const [exitPromptAt, setExitPromptAt] = useState(0)
  const exitBackAtRef = useRef(0)
  const initPlugins = useStore(s => s.initPlugins)
  const location = useLocation()
  const navigate = useNavigate()
  const { active: screensaverActive, dismiss: dismissScreensaver } = useIdleScreensaver()
  const locationPathRef = useRef(location.pathname)
  const locationKeyRef = useRef(location.key)

  useEffect(() => {
    locationPathRef.current = location.pathname
    locationKeyRef.current = location.key
  }, [location])

  useEffect(() => {
    initPlugins()
    // Navegación tipo TV (D-pad): en Android con mando y en escritorio con
    // las flechas del teclado — mismo comportamiento en ambas plataformas.
    if (isAndroidNative() || isElectron()) {
      initTvNavigation()
    }
    // WARP siempre activado: auto-connect en cada arranque, sin opción de
    // apagarlo — toda la app sale por el túnel (doble salto Cloudflare→
    // Cloudflare en aether, o la IP del VPS en modo remoto-SSH).
    const startWarp = async () => {
      CloudProxy.getStatus().then(s => {
        console.log('[App] WARP status:', s.connected)
        if (!s.connected) {
          console.log('[App] WARP auto-connecting...')
          // Reintentos como en onResume: el primer intento puede fallar
          // justo tras el arranque (radio aún despertando). Sin reintentos
          // un solo fallo dejaba el overlay "Conectando WARP" para siempre.
          const connectWithRetry = async () => {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const r = await CloudProxy.connect()
                await refreshWarpStatus()
                console.log('[App] WARP auto-connect:', r.status)
                return
              } catch (e) {
                console.warn(`[App] WARP auto-connect attempt ${attempt} failed:`, e?.message)
                if (attempt < 3) await new Promise(r => setTimeout(r, 4000))
              }
            }
            await refreshWarpStatus()
          }
          connectWithRetry()
        } else {
          refreshWarpStatus()
        }
      }).catch(() => {})
    }
    startWarp()

    // Plan de carga en background (TMDB → anime → deportes): precalienta las
    // cachés en orden para que cada sección abra al instante. Espera a WARP
    // internamente — no compite con el primer pintado ni filtra la IP.
    startLoadPlan()
  }, [initPlugins])

  useEffect(() => {
    if (!isAndroidNative()) return
    let cancelled = false
    let awaitingSettings = false
    let listener
    const sub = CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive || !awaitingSettings || cancelled) return
      awaitingSettings = false
      try {
        const engine = await getTorrentEngine()
        const access = await engine?.getStorageAccess?.()
        if (cancelled) return
        toast(access?.granted
          ? 'Acceso al almacenamiento concedido'
          : 'Puedes conceder acceso desde Descargas o elegir una carpeta con el selector del sistema')
      } catch { /* El boton de Descargas sigue disponible. */ }
    }).then(h => { if (cancelled) h.remove(); else listener = h }).catch(() => {})
    const timer = setTimeout(async () => {
      try {
        const result = await promptStorageAccessOnce({
          getVersion: () => AppUpdater.getAppVersion(),
          getEngine: getTorrentEngine,
          storage: localStorage,
        })
        if (!cancelled && result === 'opened') awaitingSettings = true
        if (!cancelled && result === 'unavailable') {
          toast.error('No se pudo abrir el acceso al almacenamiento; puedes usar el selector de Descargas')
        }
      } catch (e) {
        console.warn('[App] Storage access prompt:', e?.message)
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
      sub.then(() => listener?.remove()).catch(() => {})
    }
  }, [])

  // Keep WARP connected while Android backgrounds the app. Reconnect on
  // resume only if the tunnel or network was actually lost.
  useEffect(() => {
    if (!isAndroidNative()) return
    let paused = false
    let lifecycleToken = 0
    let retryTimer = null

    const onPause = () => {
      paused = true
      lifecycleToken++
      console.log('[App] App paused (background)')
    }

    const onResume = async () => {
      paused = false
      const token = ++lifecycleToken
      console.log('[App] App resumed (foreground)')
      // Recalentar las cachés si el plan lleva >10 min sin correr (las de
      // deportes caducan en minutos). No-op si está corriendo o es reciente.
      startLoadPlan()
      // WARP siempre-activo: al volver a foreground se reconecta si cayó —
      // solo el "Continuar sin WARP" de sesión se respeta hasta aquí.
      setWarpSkipped(false)

      try {
        // Do not flash the blocking overlay while WARP is already connected.
        const status = await CloudProxy.getStatus()
        if (token !== lifecycleToken || paused) return
        if (status.connected) {
          await refreshWarpStatus()
          if (token === lifecycleToken) setWarpBlocking(false)
          return
        }

        // Keep all requests blocked while the proxy is stopped or reconnecting.
        setWarpBlocking(true)
        console.log('[App] Reconnecting WARP (foreground, proxy dead → alive)')
        // Retry the handshake a few times: Aether can fail transiently right
        // after resume (radio still waking up). Without retries the blocking
        // overlay would stay up forever after a single failed connect.
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (token !== lifecycleToken || paused) return
          try {
            await CloudProxy.connect()
            break
          } catch (e) {
            console.warn(`[App] WARP reconnect attempt ${attempt} failed:`, e?.message)
            if (attempt === 4) throw e
            await new Promise(r => setTimeout(r, 4000))
          }
        }
        if (token !== lifecycleToken || paused) return
        await refreshWarpStatus()
        if (token === lifecycleToken) {
          setWarpBlocking(false)
          console.log('[App] WARP reconnected')
        }
      } catch (e) {
        // A failed reconnect must remain blocked; allowing the UI through here
        // would make requests bypass WARP and leak the real IP. Schedule one
        // more retry later so a dead tunnel doesn't freeze the app forever.
        if (token === lifecycleToken && !paused) {
          setWarpBlocking(true)
          console.warn('[App] WARP reconnect failed:', e?.message)
          // Timer referenciado: sin él disparaba onResume con closures
          // obsoletas incluso tras el desmontaje del efecto.
          clearTimeout(retryTimer)
          retryTimer = setTimeout(() => { retryTimer = null; if (!paused) onResume() }, 15000)
        }
      }
    }

    const pauseListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onResume()
      else onPause()
    })

    return () => {
      clearTimeout(retryTimer)
      pauseListener.then(listener => listener.remove()).catch(() => {})
    }
  }, [])

  // Registrar un único listener de Android. El path actual se lee desde un
  // ref para no acumular listeners en cada cambio de ruta.
  useEffect(() => {
    if (!isAndroidNative()) return
    let listener
    let cancelled = false
    CapacitorApp.addListener('backButton', () => {
      console.log('[App] backButton event, playerOverlay=', !!document.querySelector('[data-player-overlay]'), 'isPlayerOpen=', isPlayerOpen())
      // Si el player nativo (ExoPlayer) se acaba de cerrar, el ACTION_UP
      // "leaked" de esa misma pulsación de Back llega al BridgeActivity y
      // dispara este evento. Sin este guard, navegaríamos hacia atrás y
      // reabriríamos el canal en un bucle. Ignoramos cualquier backButton
      // que llegue en el segundo siguiente al cierre del player nativo.
      const closedAt = getPlayerClosedAt()
      const sinceClose = Date.now() - closedAt
      if (closedAt > 0 && sinceClose < 1000) {
        console.log('[App] backButton ignored: native player closed', sinceClose, 'ms ago')
        return
      }
      if (document.querySelector('[data-player-overlay]')) {
        // El overlay de React del player está en el DOM — su keydown
        // handler lo cierra.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Back', bubbles: true }))
      } else if (isPlayerOpen()) {
        // Native ExoPlayer dialog is active. It owns the Back key and closes
        // itself via dispatchKeyEvent/onKeyDown. Do NOT dispatch a synthetic
        // Back here: it races with the native 'closed' event and can reopen
        // the channel. The native plugin suppresses the leaked ACTION_UP,
        // and React's onClose (from the native 'closed' event) unmounts the
        // player. Nothing else to do.
        return
      } else {
        // Doble atrás para salir en CUALQUIER página: la ventana de salida se
        // comprueba ANTES de despachar el Back a la página. Si se despachara
        // primero, una vista interna (episodio, picker, menú móvil) podría
        // consumir la 2ª pulsación y la salida nunca llegaría — por eso solo
        // funcionaba en inicio, donde nada consume el Back.
        const now = Date.now()
        if (exitBackAtRef.current && now - exitBackAtRef.current < 2500) {
          exitBackAtRef.current = 0
          CapacitorApp.exitApp()
          return
        }
        exitBackAtRef.current = now
        // Timestamp: cada pulsación re-dispara el efecto del toast y reinicia
        // su temporizador (antes el timer vivía en este efecto y moría al
        // re-ejecutarse tras navigate(-1) → el aviso no desaparecía jamás).
        setExitPromptAt(now)

        // Las páginas internas (modal de actor, temporada y episodio) reciben
        // primero el Back y lo consumen sin cambiar la ruta.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Back', bubbles: true }))

        // El listener de Details marca el evento como consumido cuando hay una
        // vista interna abierta. Esperamos al siguiente tick para no navegar
        // fuera de la ficha antes de que pueda cerrarla.
        setTimeout(() => {
          const consumedEl = document.querySelector('[data-back-consumed="true"]')
          consumedEl?.removeAttribute('data-back-consumed')
          if (consumedEl) return // la página cerró una vista interna

          if (locationPathRef.current !== '/') {
            if (locationKeyRef.current !== 'default') {
              navigate(-1)
            } else {
              // 'replace' para no apilar otra entrada '/' — si no, el
              // siguiente atrás en inicio rebotaría a esta misma página.
              navigate('/', { replace: true })
            }
          }
        }, 0)
      }
    }).then(handle => {
      if (cancelled) handle.remove()
      else listener = handle
    }).catch(() => {})
    return () => {
      cancelled = true
      listener?.remove()
    }
  }, [navigate])

  // El toast "pulsa atrás otra vez" se oculta a los 2.5s. Vive en un efecto
  // propio porque el listener de arriba se re-ejecuta en cada navegación
  // (navigate cambia de identidad) y su cleanup mataba el temporizador.
  useEffect(() => {
    if (!exitPromptAt) return
    const t = setTimeout(() => setExitPromptAt(0), 2500)
    return () => clearTimeout(t)
  }, [exitPromptAt])

  // Refocus on page change (TV navigation)
  useEffect(() => {
    if (isAndroidNative() || isElectron()) {
      refocusAfterPageChange()
    }
  }, [location.pathname])

  const android = isAndroidNative()
  // La app de escritorio usa el mismo layout que Android (barra de iconos
  // superior, sin sidebar): misma ejecución y apariencia en todas las apps.
  const appShell = android || isElectron()

  // Subscribe to WARP status to show blocking overlay when connecting.
  // The overlay blocks ALL UI interaction while WARP is down, preventing
  // the user from navigating to pages that would load images/requests
  // that could leak the real IP.
  useEffect(() => {
    if (!android) return
    const unsub = subscribeWarpStatus(connected => {
      // WARP es siempre-activo: con el túnel caído el overlay bloquea toda
      // la UI salvo que el usuario haya pulsado "Continuar sin WARP" en
      // esta sesión (se resetea al volver a foreground).
      setWarpBlocking(!connected && !warpSkipped)
    })
    return unsub
  }, [android, warpSkipped])

  // Escape del overlay: si WARP no conecta en 25s (ISP bloquea Cloudflare,
  // aether muerto, etc.) se muestran opciones — sin esto la app quedaba
  // brickeada en "Conectando WARP" para siempre ante cualquier fallo.
  const [warpStuck, setWarpStuck] = useState(false)
  const [warpError, setWarpError] = useState('')
  const [warpRetrying, setWarpRetrying] = useState(false)
  const [prevBlocking, setPrevBlocking] = useState(false)
  if (warpBlocking !== prevBlocking) {
    setPrevBlocking(warpBlocking)
    if (!warpBlocking) { setWarpStuck(false); setWarpError('') }
  }
  // Los códigos SSH_HOST_KEY_* se traducen: la huella del VPS se confirma
  // desde Ajustes → Red → servidor remoto.
  const warpErrText = (m) => {
    const s = String(m || '')
    if (s.includes('SSH_HOST_KEY_CHANGED')) return 'La clave SSH del VPS cambió — confírmala en Ajustes → Red'
    if (s.includes('SSH_HOST_KEY_UNKNOWN')) return 'Confirma la huella SSH del VPS en Ajustes → Red'
    return s
  }
  useEffect(() => {
    if (!warpBlocking) return
    const t = setTimeout(async () => {
      setWarpStuck(true)
      try {
        const s = await CloudProxy.getStatus()
        if (s?.error) setWarpError(warpErrText(s.error))
      } catch { /* estado del proxy no disponible */ }
    }, 25000)
    return () => clearTimeout(t)
  }, [warpBlocking])

  const retryWarp = async () => {
    setWarpRetrying(true)
    setWarpError('')
    try {
      await CloudProxy.connect()
      await refreshWarpStatus()
    } catch (e) {
      setWarpError(warpErrText(e?.message || String(e)))
      setWarpStuck(true)
    }
    setWarpRetrying(false)
  }

  const skipWarp = async () => {
    // El usuario elige seguir sin WARP solo en ESTA sesión: limpia el proxy
    // y cierra el overlay. En el próximo arranque vuelve a conectar solo
    // (WARP es siempre activado — no hay apagado persistente).
    setWarpSkipped(true)
    try { await CloudProxy.disconnect() } catch { /* best-effort */ }
    resetWarpReady()
    setWarpBlocking(false)
  }

  // Las rutas NO se montan hasta el primer desbloqueo del túnel: montar
  // Home antes del CONNECTED dispara <img> de TMDB y peticiones de
  // catálogo por la IP física — esa era la fuga. Una vez montadas se
  // conservan (si el túnel cae a mitad de sesión el overlay bloquea la
  // interacción pero la página conserva su estado).
  // "Continuar sin WARP" solo libera ESTA sesión — el próximo arranque o
  // vuelta a foreground vuelve a intentar el túnel (siempre-activo).
  const [routesMounted, setRoutesMounted] = useState(() => !warpBlocking)
  if (!routesMounted && !warpBlocking) setRoutesMounted(true)

  return (
    <ErrorBoundary>
      <div className={android ? 'flex flex-col h-screen bg-dark-950' : 'flex min-h-screen bg-dark-950'}>
        {/* WARP connecting overlay: blocks ALL interaction while WARP is down */}
        {warpBlocking && android && (
          <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center px-8" data-warp-overlay>
            <img
              src="/logo-symbol.png"
              alt="OctoStream"
              className="w-20 h-20 object-contain mb-6 animate-warp-pulse"
              draggable={false}
            />
            <h2 className="text-white text-xl font-bold mb-2">Conectando WARP</h2>
            <p className="text-white/60 text-sm">Protegiendo tu conexión…</p>
            {warpStuck && (
              <div className="mt-8 flex flex-col items-center gap-3 max-w-xs text-center">
                {warpError && <p className="text-red-400/80 text-xs break-words">{warpError}</p>}
                <p className="text-white/50 text-xs">La conexión está tardando más de lo normal.</p>
                <div className="flex gap-3 mt-1">
                  <button
                    onClick={retryWarp}
                    disabled={warpRetrying}
                    className="px-5 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-semibold disabled:opacity-50"
                  >
                    {warpRetrying ? 'Conectando…' : 'Reintentar'}
                  </button>
                  <button
                    onClick={skipWarp}
                    className="px-5 py-2.5 rounded-xl bg-dark-700 border border-white/15 text-white/80 text-sm"
                  >
                    Continuar sin WARP
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Doble Back para salir: pill estilo toast de Android */}
        {exitPromptAt > 0 && (
          <div className="fixed inset-x-0 bottom-8 z-[110] flex justify-center pointer-events-none" data-exit-toast>
            <div className="bg-dark-800/95 border border-white/10 text-white text-sm px-5 py-2.5 rounded-full shadow-lg flex items-center gap-2">
              <img src="/logo-symbol.png" alt="" className="w-4 h-5 object-contain" draggable={false} />
              Pulsa atrás otra vez para salir
            </div>
          </div>
        )}

        {/* Sidebar solo en la versión web de navegador; las apps usan TopNav */}
        {!appShell && <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />}

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Header con hamburguesa solo en la versión web de navegador */}
          {!appShell && (
            <header className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-dark-900 border-b border-dark-800">
              <button
                onClick={() => setSidebarOpen(true)}
                tabIndex={0}
                className="btn-ghost p-2"
                aria-label="Abrir menú"
              >
                <Menu size={24} />
              </button>
              <img src="/logo-symbol.png" alt="" className="w-6 h-8 object-contain" draggable={false} />
              <span className="text-white font-bold">OctoStream</span>
            </header>
          )}

          {/* Barra de navegación superior en las apps (Android y escritorio) */}
          {appShell && <BottomNav />}

          {/* Main content: scroll interno en las apps, normal en web */}
          <main className={`flex-1 ${appShell ? 'overflow-y-auto' : ''}`}>
            <Suspense fallback={<div className="flex items-center justify-center h-64"><LogoLoader size={64} /></div>}>
              {routesMounted && (
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/search" element={<Search />} />
                <Route path="/youtube" element={<YouTube />} />
                <Route path="/favorites" element={<Favorites />} />
                <Route path="/history" element={<History />} />
                <Route path="/plugins" element={<Plugins />} />
                <Route path="/add-stream" element={<AddStream />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/cast" element={<CastReceiver />} />
                <Route path="/live-tv" element={<LiveTV />} />
                <Route path="/sports" element={<Sports />} />
                <Route path="/calendar" element={<Calendar />} />
                <Route path="/sync" element={<Sync />} />
                <Route path="/catalog/:pluginId/:catalogId/:type" element={<Catalog />} />
                <Route path="/details/:type/:id" element={<Details />} />
              </Routes>
              )}
            </Suspense>
          </main>
        </div>

        {screensaverActive && <Screensaver onDismiss={dismissScreensaver} />}
        {(android || isElectron()) && <RemotePlayReceiver />}
        {(android || isElectron()) && <UpdateChecker />}
        <ToastHost />
      </div>
    </ErrorBoundary>
  )
}
