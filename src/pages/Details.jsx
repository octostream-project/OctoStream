import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { pluginManager } from '../plugins/manager.js'
import { useStore } from '../store/useStore.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import { sanitizeUrl } from '../utils/sanitizeUrl.js'
import { Loader2, Play, Heart, Star, ArrowLeft, Clock, Server, Users, Film as FilmIcon } from 'lucide-react'

export default function Details() {
  const { type, id } = useParams()
  const navigate = useNavigate()
  const { isFavorite, toggleFavorite, addToHistory } = useStore()
  const [meta, setMeta] = useState(null)
  const [streams, setStreams] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedStream, setSelectedStream] = useState(null)
  const [selectedEpisode, setSelectedEpisode] = useState(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setMeta(null)
      setStreams([])
      setSelectedStream(null)
      setSelectedEpisode(null)

      const m = await pluginManager.getMeta(type, id)
      setMeta(m)

      if (m) {
        const s = await pluginManager.getStreams(type, id, m.name)
        setStreams(s)
      }

      setLoading(false)
    }
    load()
  }, [type, id])

  const handlePlay = (stream) => {
    setSelectedStream(stream)
    if (meta) {
      addToHistory({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-primary-500" size={48} />
      </div>
    )
  }

  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <p className="text-dark-400 text-lg">Contenido no encontrado</p>
        <button onClick={() => navigate('/')} className="btn-primary">Volver al inicio</button>
      </div>
    )
  }

  const fav = isFavorite(meta.id, meta.type)

  return (
    <div className="min-h-screen">
      {selectedStream && (
        <VideoPlayer
          stream={selectedStream}
          title={selectedEpisode ? `${meta.name} - ${selectedEpisode.name}` : meta.name}
          meta={meta}
          onClose={() => setSelectedStream(null)}
        />
      )}

      <div className="relative h-[40vh] sm:h-[50vh] overflow-hidden">
        {meta.backdrop || meta.poster ? (
          <img
            src={meta.backdrop || meta.poster}
            alt={meta.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-dark-800" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-dark-950 via-dark-950/50 to-transparent" />
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-4 btn-ghost bg-black/50 backdrop-blur p-2 rounded-full"
        >
          <ArrowLeft size={24} />
        </button>
      </div>

      <div className="px-4 lg:px-6 -mt-32 relative z-10">
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="flex-shrink-0 w-32 sm:w-48 mx-auto sm:mx-0">
            {meta.poster && (
              <img
                src={meta.poster}
                alt={meta.name}
                className="w-full rounded-xl shadow-2xl border border-dark-700"
              />
            )}
          </div>

          <div className="flex-1 space-y-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{meta.name}</h1>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              {meta.year && <span className="text-dark-300">{meta.year}</span>}
              {meta.rating && (
                <span className="flex items-center gap-1 text-yellow-400">
                  <Star size={14} className="fill-yellow-400" />
                  {meta.rating.toFixed(1)}
                </span>
              )}
              {meta.runtime && (
                <span className="flex items-center gap-1 text-dark-300">
                  <Clock size={14} />
                  {meta.runtime}
                </span>
              )}
              {meta.seasons && (
                <span className="text-dark-300">{meta.seasons} temporada{meta.seasons !== 1 ? 's' : ''}</span>
              )}
            </div>

            {meta.genres && meta.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {meta.genres.map(g => (
                  <span key={g} className="text-xs bg-dark-800 text-dark-300 px-3 py-1 rounded-full">
                    {g}
                  </span>
                ))}
              </div>
            )}

            {meta.description && (
              <p className="text-dark-300 text-sm sm:text-base leading-relaxed max-w-2xl">
                {meta.description}
              </p>
            )}

            <div className="flex items-center gap-3 pt-2">
              {streams.length > 0 && (
                <button
                  onClick={() => handlePlay(streams[0])}
                  className="btn-primary text-lg px-6 py-3"
                >
                  <Play size={22} className="fill-white" />
                  Reproducir
                </button>
              )}
              <button
                onClick={() => toggleFavorite(meta)}
                className={`btn-secondary p-3 ${fav ? 'text-red-400' : ''}`}
              >
                <Heart size={22} className={fav ? 'fill-red-400' : ''} />
              </button>
            </div>
          </div>
        </div>

        {meta.episodes && meta.episodes.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Episodios</h2>
            <div className="space-y-2">
              {meta.episodes.map(ep => (
                <div
                  key={ep.id}
                  className="flex items-center gap-4 bg-dark-800 rounded-lg p-3 hover:bg-dark-700 transition-colors cursor-pointer"
                  onClick={() => {
                    setSelectedEpisode(ep)
                    if (streams.length > 0) handlePlay(streams[0])
                  }}
                >
                  <div className="flex-shrink-0 w-12 h-12 bg-primary-600 rounded-lg flex items-center justify-center font-bold">
                    {ep.episode}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{ep.name}</p>
                    <p className="text-xs text-dark-400">
                      T{ep.season} · E{ep.episode}
                    </p>
                    {ep.description && (
                      <p className="text-xs text-dark-500 truncate mt-1">{ep.description}</p>
                    )}
                  </div>
                  <Play size={20} className="text-dark-400 flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}

        {streams.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Fuentes disponibles</h2>
            <div className="space-y-2">
              {streams.map((stream, i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 bg-dark-800 rounded-lg p-4 hover:bg-dark-700 transition-colors cursor-pointer"
                  onClick={() => handlePlay(stream)}
                >
                  <Server size={20} className="text-primary-500 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-white font-medium">{stream.name}</p>
                    <p className="text-xs text-dark-400">
                      {stream.pluginName} · {stream.streamType?.toUpperCase()}
                    </p>
                  </div>
                  {stream.quality && (
                    <span className="text-xs bg-primary-600 px-2 py-1 rounded">
                      {stream.quality}
                    </span>
                  )}
                  <Play size={20} className="text-dark-400" />
                </div>
              ))}
            </div>
          </div>
        )}

        {streams.length === 0 && !meta.episodes && (
          <div className="mt-8 text-center py-8">
            <p className="text-dark-400">No hay fuentes disponibles para este contenido</p>
          </div>
        )}

        {meta.trailer && sanitizeUrl(meta.trailer) && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Tráiler</h2>
            <div className="aspect-video rounded-xl overflow-hidden bg-black">
              <iframe
                src={sanitizeUrl(meta.trailer)}
                className="w-full h-full"
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups"
              />
            </div>
          </div>
        )}

        {meta.cast && meta.cast.length > 0 && (
          <div className="mt-8">
            <h2 className="flex items-center gap-2 text-xl font-bold text-white mb-4">
              <Users size={20} className="text-primary-500" />
              Reparto
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {meta.cast.map(member => (
                <div key={member.id} className="flex-shrink-0 w-24 text-center">
                  {member.photo ? (
                    <img
                      src={member.photo}
                      alt={member.name}
                      className="w-20 h-20 rounded-full object-cover mx-auto mb-2 border-2 border-dark-700"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-dark-700 mx-auto mb-2 flex items-center justify-center">
                      <Users size={24} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white font-medium truncate">{member.name}</p>
                  <p className="text-xs text-dark-500 truncate">{member.character}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {meta.seasonsList && meta.seasonsList.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Temporadas</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {meta.seasonsList.map(season => (
                <div
                  key={season.id}
                  className="card"
                  onClick={() => navigate(`/details/${meta.type}/${meta.id}`)}
                >
                  {season.poster ? (
                    <img src={season.poster} alt={season.name} className="w-full aspect-[2/3] object-cover" />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-dark-700 flex items-center justify-center">
                      <FilmIcon size={32} className="text-dark-500" />
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-sm text-white font-medium truncate">{season.name}</p>
                    <p className="text-xs text-dark-400">{season.episodeCount} episodios</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {meta.similar && meta.similar.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Similar</h2>
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {meta.similar.map(item => (
                <div
                  key={`${item.type}-${item.id}`}
                  className="flex-shrink-0 w-32 sm:w-36 cursor-pointer"
                  onClick={() => navigate(`/details/${item.type}/${item.id}`)}
                >
                  {item.poster ? (
                    <img src={item.poster} alt={item.name} className="w-full aspect-[2/3] object-cover rounded-lg" />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-dark-700 rounded-lg flex items-center justify-center">
                      <FilmIcon size={24} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white mt-2 truncate">{item.name}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {meta.recommendations && meta.recommendations.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-bold text-white mb-4">Recomendaciones</h2>
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {meta.recommendations.map(item => (
                <div
                  key={`${item.type}-${item.id}`}
                  className="flex-shrink-0 w-32 sm:w-36 cursor-pointer"
                  onClick={() => navigate(`/details/${item.type}/${item.id}`)}
                >
                  {item.poster ? (
                    <img src={item.poster} alt={item.name} className="w-full aspect-[2/3] object-cover rounded-lg" />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-dark-700 rounded-lg flex items-center justify-center">
                      <FilmIcon size={24} className="text-dark-500" />
                    </div>
                  )}
                  <p className="text-xs text-white mt-2 truncate">{item.name}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="h-8" />
      </div>
    </div>
  )
}
