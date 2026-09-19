import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { Menu } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Sidebar from './components/Sidebar.jsx'
import BottomNav from './components/BottomNav.jsx'
import Screensaver from './components/Screensaver.jsx'
import RemotePlayReceiver from './components/RemotePlayReceiver.jsx'
import { useStore } from './store/useStore.js'
import { isAndroidNative } from './utils/platform.js'
import { initTvNavigation, refocusAfterPageChange, isPlayerOpen, getPlayerClosedAt } from './utils/tvNavigation.js'
import { CloudProxy } from '@octostream/cloud-proxy'
import { refreshWarpStatus, resetWarpReady, subscribeWarpStatus } from './utils/warpStatus.js'

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

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!enabled) return
    timerRef.current = setTimeout(() => {
      // No activar durante la reproducción: el player nativo es un diálogo
      // que no cambia la ruta, así que el guard por pathname no lo ve.
      const playing = isPlayerOpen() || document.querySelector('[data-player-overlay]')
      if (playing) { resetTimer(); return }
      setActive(true)
    }, timeoutMs)
  }, [enabled, timeoutMs])

  useEffect(() => {
    if (!enabled) {
      setActive(false)
      return
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel', 'click']
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()
    return () => {
      events.forEach(e => window.removeEventListener(e, resetTimer))
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [resetTimer, enabled])

  // Don't trigger screensaver while playing video (details page or cast)
  useEffect(() => {
    if (active) {
      const onPlayerPage = location.pathname.startsWith('/details/') || location.pathname === '/cast'
      if (onPlayerPage) setActive(false)
    }
  }, [active, location.pathname])

  const dismiss = useCallback(() => setActive(false), [])
  return { active, dismiss }
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [warpBlocking, setWarpBlocking] = useState(false) // blocks UI while WARP connects
  const [exitPrompt, setExitPrompt] = useState(false)
  const exitBackAtRef = useRef(0)
  const exitPromptTimerRef = useRef(null)
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
    if (isAndroidNative()) {
      initTvNavigation()
    }
    // Auto-connect WARP by default on first launch.
    // If the user disables it in Settings, it stays disabled.
    if (localStorage.getItem('octostream_warp_autoconnect') === null) {
      localStorage.setItem('octostream_warp_autoconnect', 'true')
    }
    const warpAuto = localStorage.getItem('octostream_warp_autoconnect')
    console.log('[App] WARP auto-connect flag:', warpAuto)
    if (warpAuto === 'true') {
      CloudProxy.getStatus().then(s => {
        console.log('[App] WARP status:', s.connected)
        if (!s.connected) {
          console.log('[App] WARP auto-connecting...')
          CloudProxy.connect().then(async r => {
            await refreshWarpStatus()
            console.log('[App] WARP auto-connect:', r.status)
          }).catch(e => console.warn('[App] WARP auto-connect failed:', e?.message))
        } else {
          refreshWarpStatus()
        }
      }).catch(() => {})
    }

  }, [initPlugins])

  // === Battery optimization: pause WARP when app goes to background ===
  // Aether (WARP) uses CPU + network continuously. When the app is in
  // background and not playing video, we disconnect WARP to save battery.
  // When the app returns to foreground, we reconnect if auto-connect is on.
  const warpPauseTimerRef = useRef(null)
  useEffect(() => {
    if (!isAndroidNative()) return
    let paused = false
    let lifecycleToken = 0

    const onPause = () => {
      paused = true
      const token = ++lifecycleToken
      console.log('[App] App paused (background)')
      // Don't pause immediately — user might just be switching apps briefly.
      // Wait 30s before disconnecting WARP (unless video is playing).
      if (warpPauseTimerRef.current) clearTimeout(warpPauseTimerRef.current)
      warpPauseTimerRef.current = setTimeout(async () => {
        warpPauseTimerRef.current = null
        if (!paused || token !== lifecycleToken) return
        try {
          const s = await CloudProxy.getStatus()
          // The app may have resumed while getStatus() was in flight. Never
          // disconnect a foreground session because of stale background work.
          if (!paused || token !== lifecycleToken) return
          // Stop Aether even if its tunnel already failed while the app was
          // backgrounded. getStatus() can be false while libaether.so keeps
          // retrying every few seconds, which wastes CPU and battery.
          console.log('[App] Disconnecting WARP (battery save, keeping dead proxy; connected=' + !!s.connected + ')')
          // Reset ready state so waitForWarp() blocks on next foreground
          resetWarpReady()
          // Keep the proxy pointing at the dead local port so requests fail
          // instead of falling back to the real IP during the sleep period.
          await CloudProxy.disconnectBackground()
        } catch (e) {
          console.warn('[App] Background WARP disconnect failed:', e?.message)
        }
      }, 30000) // 30s delay
    }

    const onResume = async () => {
      paused = false
      const token = ++lifecycleToken
      console.log('[App] App resumed (foreground)')
      // Cancel pending disconnect
      if (warpPauseTimerRef.current) {
        clearTimeout(warpPauseTimerRef.current)
        warpPauseTimerRef.current = null
      }
      if (localStorage.getItem('octostream_warp_autoconnect') === 'false') {
        setWarpBlocking(false)
        // If the app went to background with WARP connected and autoconnect
        // was later disabled, onPause still called disconnectBackground()
        // which keeps the proxy pointing at a dead port. Clear it now so
        // requests go direct instead of failing forever against 127.0.0.1:1820.
        try {
          const s = await CloudProxy.getStatus()
          if (token !== lifecycleToken || paused) return
          if (!s.connected) await CloudProxy.disconnect()
        } catch {}
        return
      }

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
          setTimeout(() => { if (!paused) onResume() }, 15000)
        }
      }
    }

    const pauseListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onResume()
      else onPause()
    })

    return () => {
      if (warpPauseTimerRef.current) clearTimeout(warpPauseTimerRef.current)
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
        // Web (HLS.js / shaka) overlay is in the DOM — let its keydown
        // handler close it.
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
        setExitPrompt(true)
        clearTimeout(exitPromptTimerRef.current)
        exitPromptTimerRef.current = setTimeout(() => setExitPrompt(false), 2500)

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
      clearTimeout(exitPromptTimerRef.current)
    }
  }, [navigate])

  // Refocus on page change (TV navigation)
  useEffect(() => {
    if (isAndroidNative()) {
      refocusAfterPageChange()
    }
  }, [location.pathname])

  const android = isAndroidNative()

  // Subscribe to WARP status to show blocking overlay when connecting.
  // The overlay blocks ALL UI interaction while WARP is down, preventing
  // the user from navigating to pages that would load images/requests
  // that could leak the real IP.
  useEffect(() => {
    if (!android) return
    const unsub = subscribeWarpStatus(connected => {
      const autoConnect = localStorage.getItem('octostream_warp_autoconnect') !== 'false'
      // Only show overlay if auto-connect is on (WARP is expected to be active).
      // If user manually disconnected, they chose to go without WARP —
      // Home/Details waitForWarp will timeout after 15s and proceed
      // (TDT Spain works direct).
      setWarpBlocking(autoConnect && !connected)
    })
    return unsub
  }, [android])

  return (
    <ErrorBoundary>
      <div className={android ? 'flex flex-col h-screen bg-dark-950' : 'flex min-h-screen bg-dark-950'}>
        {/* WARP connecting overlay: blocks ALL interaction while WARP is down */}
        {warpBlocking && android && (
          <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center" data-warp-overlay>
            <img
              src="/logo-symbol.png"
              alt="OctoStream"
              className="w-20 h-20 object-contain mb-6 animate-warp-pulse"
              draggable={false}
            />
            <h2 className="text-white text-xl font-bold mb-2">Conectando WARP</h2>
            <p className="text-white/60 text-sm">Protegiendo tu conexión…</p>
          </div>
        )}

        {/* Doble Back para salir: pill estilo toast de Android */}
        {exitPrompt && (
          <div className="fixed inset-x-0 bottom-8 z-[110] flex justify-center pointer-events-none" data-exit-toast>
            <div className="bg-dark-800/95 border border-white/10 text-white text-sm px-5 py-2.5 rounded-full shadow-lg flex items-center gap-2">
              <img src="/logo-symbol.png" alt="" className="w-4 h-5 object-contain" draggable={false} />
              Pulsa atrás otra vez para salir
            </div>
          </div>
        )}

        {/* Sidebar only on web/Electron; Android uses TopNav */}
        {!android && <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />}

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Header with hamburger only on web/Electron */}
          {!android && (
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

          {/* Top navigation bar only on Android - always visible above content */}
          {android && <BottomNav />}

          {/* Main content: scrollable on Android, normal on web */}
          <main className={`flex-1 ${android ? 'overflow-y-auto' : ''}`}>
            <Suspense fallback={<div className="flex items-center justify-center h-64 text-white/60">Cargando...</div>}>
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
            </Suspense>
          </main>
        </div>

        {screensaverActive && <Screensaver onDismiss={dismissScreensaver} />}
        {android && <RemotePlayReceiver />}
      </div>
    </ErrorBoundary>
  )
}
