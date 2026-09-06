import { useEffect, useState, useRef, useCallback } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Sidebar from './components/Sidebar.jsx'
import Screensaver from './components/Screensaver.jsx'
import Home from './pages/Home.jsx'
import Search from './pages/Search.jsx'
import Details from './pages/Details.jsx'
import Catalog from './pages/Catalog.jsx'
import Favorites from './pages/Favorites.jsx'
import History from './pages/History.jsx'
import Plugins from './pages/Plugins.jsx'
import AddStream from './pages/AddStream.jsx'
import Settings from './pages/Settings.jsx'
import CastReceiver from './pages/CastReceiver.jsx'
import LiveTV from './pages/LiveTV.jsx'
import { useStore } from './store/useStore.js'

const SCREENSAVER_ENABLED_KEY = 'optopus_screensaver_enabled'
const SCREENSAVER_TIMEOUT_KEY = 'optopus_screensaver_timeout'

function useIdleScreensaver() {
  const [active, setActive] = useState(false)
  const timerRef = useRef(null)
  const location = useLocation()

  const enabled = localStorage.getItem(SCREENSAVER_ENABLED_KEY) !== 'false'
  const timeoutMin = parseInt(localStorage.getItem(SCREENSAVER_TIMEOUT_KEY) || '5', 10)
  const timeoutMs = Math.max(1, timeoutMin) * 60 * 1000

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!enabled) return
    timerRef.current = setTimeout(() => setActive(true), timeoutMs)
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
  const initPlugins = useStore(s => s.initPlugins)
  const { active: screensaverActive, dismiss: dismissScreensaver } = useIdleScreensaver()

  useEffect(() => {
    initPlugins()
  }, [initPlugins])

  return (
    <ErrorBoundary>
      <div className="flex min-h-screen bg-dark-950">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="lg:hidden sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-dark-900 border-b border-dark-800">
            <button onClick={() => setSidebarOpen(true)} className="btn-ghost p-2">
              <Menu size={24} />
            </button>
            <span className="text-white font-bold">Optopus Stream</span>
          </header>

          <main className="flex-1">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<Search />} />
              <Route path="/favorites" element={<Favorites />} />
              <Route path="/history" element={<History />} />
              <Route path="/plugins" element={<Plugins />} />
              <Route path="/add-stream" element={<AddStream />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/cast" element={<CastReceiver />} />
              <Route path="/live-tv" element={<LiveTV />} />
              <Route path="/catalog/:pluginId/:catalogId/:type" element={<Catalog />} />
              <Route path="/details/:type/:id" element={<Details />} />
            </Routes>
          </main>
        </div>

        {screensaverActive && <Screensaver onDismiss={dismissScreensaver} />}
      </div>
    </ErrorBoundary>
  )
}
