import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Star, Play, Tv } from 'lucide-react'
import { useStore } from '../store/useStore.js'
import { isAllowedInProfile } from '../utils/profiles.js'

// Cache de blobs para pósters de AniList (evitan re-fetch con hotlink-block).
// LRU acotado: sin límite ni revokeObjectURL las URLs blob se acumulaban
// en sesiones largas de zapping por anime.
const POSTER_CACHE_MAX = 100
const posterCache = new Map()

function cachePoster(key, objectUrl) {
  if (posterCache.has(key)) posterCache.delete(key)
  posterCache.set(key, objectUrl)
  while (posterCache.size > POSTER_CACHE_MAX) {
    const [oldKey, oldUrl] = posterCache.entries().next().value
    posterCache.delete(oldKey)
    URL.revokeObjectURL(oldUrl)
  }
}

function Poster({ item }) {
  const [src, setSrc] = useState(item.poster)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSrc(item.poster)
    setFailed(false)
  }, [item.poster])

  const handleError = useCallback(async () => {
    const fallback = item.posterFallback
    if (fallback && src !== fallback) {
      setSrc(fallback)
      return
    }
    if (!item.id?.startsWith('anilist-anime-') || !src) {
      setFailed(true)
      return
    }
    const cached = posterCache.get(src)
    if (cached) {
      setSrc(cached)
      return
    }
    try {
      const response = await fetch(src, {
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      })
      if (!response.ok) throw new Error(String(response.status))
      const objectUrl = URL.createObjectURL(await response.blob())
      cachePoster(src, objectUrl)
      setSrc(objectUrl)
    } catch {
      setFailed(true)
    }
  }, [item.id, item.posterFallback, src])

  if (failed) return <div className="w-full h-full flex items-center justify-center"><Play size={32} className="text-dark-500" /></div>

  return (
    <img
      src={src}
      alt={item.name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={handleError}
      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110 group-focus:scale-110"
    />
  )
}

function ContentCard({ item }) {
  const navigate = useNavigate()
  const profile = useStore(s => s.profiles.find(p => p.id === s.activeProfileId))

  const handleClick = useCallback(() => {
    // YouTube channels are favorited with type 'youtube_channel' and id 'ytchannel:<url>'
    // Navigate to the YouTube page instead of Details (which would hang trying to resolve streams)
    if (item.type === 'youtube_channel' && item.id?.startsWith('ytchannel:')) {
      navigate('/youtube', { state: { channel: { ...item, url: item.id.slice(10) } } })
      return
    }
    // YouTube videos are favorited with type 'youtube' and id 'yt:<watch url>'
    if (item.type === 'youtube' && item.id?.startsWith('yt:')) {
      navigate('/youtube', { state: { video: { url: item.id.slice(3), name: item.name, thumbnailUrl: item.poster } } })
      return
    }
    navigate(`/details/${item.type}/${item.id}`)
  }, [navigate, item])

  if (!isAllowedInProfile(item, profile)) return null

  return (
    <div
      className="card group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-900"
      data-tv-card
      tabIndex={0}
      role="button"
      onClick={handleClick}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleClick()
        }
      }}
    >
      <div className="relative aspect-[2/3] bg-dark-700 overflow-hidden">
        {item.poster ? (
          <Poster item={item} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {item.type === 'youtube_channel' ? (
              <Tv size={32} className="text-primary-400" />
            ) : (
              <Play size={32} className="text-dark-500" />
            )}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-transparent opacity-75 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-300" />
        <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-300">
          <div className="flex items-center justify-center bg-primary-600 rounded-lg py-2 text-sm font-semibold shadow-lg">
            <Play size={16} className="mr-1" /> Ver ahora
          </div>
        </div>
        {item.rating && (
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/70 backdrop-blur px-2 py-1 rounded-lg text-xs">
            <Star size={12} className="text-yellow-400 fill-yellow-400" />
            <span className="text-white font-medium">{item.rating.toFixed(1)}</span>
          </div>
        )}
      </div>
      <div className="p-2.5">
        <h3 className="text-sm font-semibold text-white truncate" title={item.name}>{item.name}</h3>
        {item.nowPlaying ? (
          <p className="text-xs text-primary-400 truncate mt-0.5 flex items-center gap-1" title={item.nowPlaying}>
            <Play size={10} className="flex-shrink-0 fill-primary-400" /> {item.nowPlaying}
          </p>
        ) : (
          <div className="flex items-center justify-between mt-0.5">
            <span className="text-xs text-dark-400">{item.year || ''}</span>
            {item.genres && item.genres.length > 0 && (
              <span className="text-xs text-dark-500 truncate ml-1">{item.genres[0]}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(ContentCard)
