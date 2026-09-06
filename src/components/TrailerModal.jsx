import { X, Film } from 'lucide-react'
import { useTranslation } from '../i18n/index.js'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'

export default function TrailerModal({ title, trailerUrl, onClose }) {
  const { t } = useTranslation()
  if (!trailerUrl) return null

  const isYouTube = trailerUrl.includes('youtube.com') || trailerUrl.includes('youtu.be')
  const rawEmbedUrl = isYouTube
    ? trailerUrl.replace('watch?v=', 'embed/').replace('youtu.be/', 'www.youtube.com/embed/')
    : trailerUrl
  const embedUrl = sanitizeUrl(rawEmbedUrl)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl bg-dark-900 rounded-2xl overflow-hidden border border-dark-700 shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-dark-800">
          <div className="flex items-center gap-2">
            <Film className="text-primary-400" size={20} />
            <h3 className="text-white font-bold truncate">{t('details.trailer')}: {title}</h3>
          </div>
          <button onClick={onClose} className="btn-ghost p-2">
            <X size={24} />
          </button>
        </div>
        <div className="aspect-video bg-black flex items-center justify-center">
          {isYouTube && embedUrl ? (
            <iframe
              src={embedUrl}
              title={`Trailer ${title}`}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          ) : (
            <div className="text-center p-6">
              <p className="text-dark-400">{t('details.no_trailer')}</p>
              <p className="text-dark-500 text-xs mt-2">YouTube</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
