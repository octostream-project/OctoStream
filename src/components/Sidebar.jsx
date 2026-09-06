import { NavLink } from 'react-router-dom'
import { Home, Search, Heart, Puzzle, Radio, Film, Tv, Clock, Clapperboard, Link2, Settings as SettingsIcon, Antenna } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { pluginManager } from '../plugins/manager.js'

export default function Sidebar({ open, onClose }) {
  const favorites = useStore(s => s.favorites)
  const watchHistory = useStore(s => s.watchHistory)
  const catalogs = pluginManager.getAllCatalogs()

  const navItems = [
    { to: '/', icon: Home, label: 'Inicio' },
    { to: '/live-tv', icon: Antenna, label: 'TV en vivo' },
    { to: '/search', icon: Search, label: 'Buscar' },
    { to: '/favorites', icon: Heart, label: 'Favoritos', badge: favorites.length },
    { to: '/history', icon: Clock, label: 'Historial', badge: watchHistory.length },
    { to: '/plugins', icon: Puzzle, label: 'Plugins' },
    { to: '/add-stream', icon: Link2, label: 'Añadir Enlace' },
  ]

  const catalogIcons = {
    movie: Film,
    series: Tv,
    live: Radio,
    channel: Radio,
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed lg:sticky top-0 left-0 h-screen w-64 bg-dark-900 border-r border-dark-800 z-40 transition-transform duration-300 flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-5 border-b border-dark-800">
          <Clapperboard className="text-primary-500" size={28} />
          <div>
            <h1 className="text-lg font-bold text-white">Optopus</h1>
            <p className="text-xs text-dark-400">Stream Media Center</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                isActive ? 'sidebar-item-active' : 'sidebar-item'
              }
              onClick={onClose}
            >
              <item.icon size={20} />
              <span className="flex-1">{item.label}</span>
              {item.badge > 0 && (
                <span className="text-xs bg-dark-700 px-2 py-0.5 rounded-full">
                  {item.badge}
                </span>
              )}
            </NavLink>
          ))}

          {catalogs.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-2 text-xs font-semibold text-dark-500 uppercase tracking-wider">
                Catálogos
              </div>
              {catalogs.map(cat => {
                const Icon = catalogIcons[cat.type] || Film
                return (
                  <NavLink
                    key={`${cat.pluginId}-${cat.id}`}
                    to={`/catalog/${cat.pluginId}/${cat.id}/${cat.type}`}
                    className={({ isActive }) =>
                      isActive ? 'sidebar-item-active' : 'sidebar-item'
                    }
                    onClick={onClose}
                  >
                    <Icon size={20} />
                    <span className="flex-1 truncate">{cat.name}</span>
                  </NavLink>
                )
              })}
            </>
          )}

          <div className="pt-2 mt-2 border-t border-dark-800">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive ? 'sidebar-item-active' : 'sidebar-item'
              }
              onClick={onClose}
            >
              <SettingsIcon size={20} />
              <span className="flex-1">Configuración</span>
            </NavLink>
          </div>
        </nav>

        <div className="p-3 border-t border-dark-800 text-xs text-dark-500 text-center">
          v1.0.0 · Multiplataforma
        </div>
      </aside>
    </>
  )
}
