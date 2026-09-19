import { NavLink } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { Home, Search, Heart, Radio, Film, Tv, Clock, Link2, Settings as SettingsIcon, Antenna, Calendar as CalendarIcon, Trophy } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { pluginManager } from '../plugins/manager.js'

export default function Sidebar({ open, onClose }) {
  const favorites = useStore(s => s.favorites)
  const watchHistory = useStore(s => s.watchHistory)
  // Los plugins se cargan lazy: recomputar catálogos cuando la lista cambia
  const installedPlugins = useStore(s => s.installedPlugins)
  // Los catálogos de deportes (FCTV, DLive) tienen su propia sección: no
  // duplicarlos aquí.
  const [catalogs, setCatalogs] = useState([])
  useEffect(() => {
    let cancelled = false
    pluginManager.getAllCatalogs()
      .then(all => { if (!cancelled) setCatalogs(all.filter(c => c.pluginId !== 'fctv' && c.pluginId !== 'dlive')) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [installedPlugins])
  // El calendario solo muestra series TMDB de favoritos/historial: se oculta
  // del nav cuando no hay ninguna.
  const hasSeries = useMemo(() => {
    const isSeries = i => i?.type === 'series' && i.id?.startsWith('tmdb-')
    return favorites.some(isSeries) || watchHistory.some(isSeries)
  }, [favorites, watchHistory])

  const navItems = [
    { to: '/', icon: Home, label: 'Inicio' },
    { to: '/live-tv', icon: Antenna, label: 'TV en vivo' },
    { to: '/sports', icon: Trophy, label: 'Deportes' },
    { to: '/search', icon: Search, label: 'Buscar' },
    { to: '/favorites', icon: Heart, label: 'Favoritos', badge: favorites.length },
    { to: '/history', icon: Clock, label: 'Historial', badge: watchHistory.length },
    { to: '/add-stream', icon: Link2, label: 'Añadir Enlace' },
    ...(hasSeries ? [{ to: '/calendar', icon: CalendarIcon, label: 'Calendario' }] : []),
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
        data-tv-menu
        className={`fixed lg:sticky top-0 left-0 h-screen w-64 bg-dark-900 border-r border-dark-800 z-40 transition-transform duration-300 flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-5 border-b border-dark-800">
          <img src="/logo-symbol.png" alt="" className="w-8 h-11 object-contain" draggable={false} />
          <div>
            <h1 className="text-lg font-bold text-white">OctoStream</h1>
            <p className="text-xs text-dark-400">Media Center</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              tabIndex={0}
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
                    tabIndex={0}
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
              tabIndex={0}
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
