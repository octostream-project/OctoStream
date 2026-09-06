import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Menu } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Sidebar from './components/Sidebar.jsx'
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
import { useStore } from './store/useStore.js'

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const initPlugins = useStore(s => s.initPlugins)

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
              <Route path="/catalog/:pluginId/:catalogId/:type" element={<Catalog />} />
              <Route path="/details/:type/:id" element={<Details />} />
            </Routes>
          </main>
        </div>
      </div>
    </ErrorBoundary>
  )
}
