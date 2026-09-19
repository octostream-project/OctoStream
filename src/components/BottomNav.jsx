import { memo } from 'react'
import { NavLink } from 'react-router-dom'
import { Home, Search, Heart, Antenna, Clock, Settings as SettingsIcon, Youtube, Calendar as CalendarIcon, Trophy } from 'lucide-react'
import { useStore } from '../store/useStore.js'

function BottomNav() {
  const favoritesCount = useStore(s => s.favorites.length)
  const historyCount = useStore(s => s.watchHistory.length)
  // El calendario solo lista series TMDB: oculto hasta que haya alguna en
  // favoritos o historial.
  const hasSeries = useStore(s =>
    s.favorites.some(i => i?.type === 'series' && i.id?.startsWith('tmdb-')) ||
    s.watchHistory.some(i => i?.type === 'series' && i.id?.startsWith('tmdb-')))

  const items = [
    { to: '/', icon: Home, label: 'Inicio' },
    { to: '/live-tv', icon: Antenna, label: 'TV' },
    { to: '/sports', icon: Trophy, label: 'Deportes' },
    { to: '/search', icon: Search, label: 'Buscar' },
    { to: '/youtube', icon: Youtube, label: 'YouTube' },
    { to: '/favorites', icon: Heart, label: 'Favoritos', badge: favoritesCount },
    { to: '/history', icon: Clock, label: 'Historial', badge: historyCount },
    ...(hasSeries ? [{ to: '/calendar', icon: CalendarIcon, label: 'Calendario' }] : []),
    { to: '/settings', icon: SettingsIcon, label: 'Ajustes' },
  ]

  return (
    <nav
      data-bottom-nav
      data-tv-row
      className="flex-shrink-0 bg-dark-900 border-b border-dark-800 flex items-center justify-around px-1 py-1.5 z-50"
    >
      {items.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          tabIndex={0}
          data-tv-card
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 px-1.5 py-1.5 rounded-lg min-w-0 flex-1 transition-colors touch-manipulation ${
              isActive ? 'text-primary-400 bg-primary-900/20' : 'text-dark-400 active:text-primary-300'
            }`
          }
        >
          <div className="relative">
            <item.icon size={22} />
            {item.badge > 0 && (
              <span className="absolute -top-1.5 -right-2 text-[10px] bg-primary-600 text-white px-1.5 py-0.5 rounded-full leading-none">
                {item.badge}
              </span>
            )}
          </div>
          <span className="text-[10px] truncate w-full text-center leading-tight">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export default memo(BottomNav)
