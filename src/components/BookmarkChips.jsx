import { useMemo, useState } from 'react'
import { Bookmark, Play, X } from 'lucide-react'
import { getBookmarks, removeBookmark, mediaKeyFor } from '../utils/bookmarks.js'

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

// Chips "▶ 32:15" de los marcadores guardados del medio actual (película o
// episodio concreto). onPlayAt(segundos) lanza la reproducción desde ahí.
// refreshToken: pásale selectedStream — al cerrar el player re-lee storage.
export default function BookmarkChips({ meta, onPlayAt, refreshToken = null }) {
  const [version, setVersion] = useState(0)
  const key = mediaKeyFor(meta)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version re-lee tras borrar
  const items = useMemo(() => getBookmarks(key), [key, refreshToken, version])
  if (!key || !items.length) return null

  return (
    <div className="mb-4">
      <p className="text-xs text-dark-400 mb-2 flex items-center gap-1.5">
        <Bookmark size={13} className="text-primary-400" /> Marcadores
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((b, i) => (
          <span
            key={`${b.t}-${b.at}`}
            className="inline-flex items-stretch rounded-lg border border-dark-700 bg-dark-800 overflow-hidden"
          >
            <button
              type="button"
              data-tv-card
              onClick={() => onPlayAt?.(b.t)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-primary-300 hover:text-white hover:bg-dark-700 focus:bg-dark-700 focus:text-white focus:outline-none"
              title={`Reproducir desde ${fmt(b.t)}`}
            >
              <Play size={11} /> {fmt(b.t)}
            </button>
            <button
              type="button"
              aria-label={`Borrar marcador ${fmt(b.t)}`}
              onClick={() => { removeBookmark(key, i); setVersion(v => v + 1) }}
              className="px-1.5 text-dark-500 hover:text-red-400 hover:bg-dark-700 focus:text-red-400 focus:outline-none"
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
