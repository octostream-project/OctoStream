import { useState, useRef } from 'react'
import VideoPlayer from '../components/VideoPlayer.jsx'
import { embedStreamPlugin } from '../plugins/builtIn/index.js'
import { Play, Link2, Plus, Trash2, Clapperboard } from 'lucide-react'

const STORAGE_KEY = 'optopus_custom_streams'

function loadCustomStreams() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveCustomStreams(streams) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(streams))
}

export default function AddStream() {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [playing, setPlaying] = useState(null)
  const [customStreams, setCustomStreams] = useState(loadCustomStreams)
  const urlRef = useRef(null)

  const handlePlay = (streamUrl, streamName) => {
    const resolved = embedStreamPlugin.resolveEmbed(streamUrl)
    setPlaying({
      url: resolved,
      streamType: 'embed',
      name: streamName || 'Reproductor Embed',
      quality: 'Auto',
    })
  }

  const handleAdd = () => {
    if (!url.trim()) return
    const stream = {
      id: `custom-${Date.now()}`,
      url: url.trim(),
      name: name.trim() || url.trim().substring(0, 40),
      addedAt: Date.now(),
    }
    const updated = [stream, ...customStreams]
    setCustomStreams(updated)
    saveCustomStreams(updated)
    setUrl('')
    setName('')
  }

  const handleDelete = (id) => {
    const updated = customStreams.filter(s => s.id !== id)
    setCustomStreams(updated)
    saveCustomStreams(updated)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setUrl(text.trim())
        urlRef.current?.focus()
      }
    } catch {
      // clipboard not available
    }
  }

  return (
    <div className="p-4 lg:p-6">
      {playing && (
        <VideoPlayer
          stream={playing}
          title={playing.name}
          onClose={() => setPlaying(null)}
        />
      )}

      <div className="flex items-center gap-3 mb-6">
        <Link2 className="text-primary-500" size={28} />
        <h1 className="text-2xl font-bold text-white">Añadir Enlace</h1>
      </div>

      <p className="text-dark-400 text-sm mb-6">
        Pega cualquier URL de video embed (YouTube, Vimeo, Dailymotion, Streamable, o cualquier iframe) y reprodúcela al instante.
      </p>

      <div className="bg-dark-800 rounded-xl p-5 border border-dark-700 mb-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-dark-300 mb-2">Nombre (opcional)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ej: Mi película favorita"
              className="input w-full"
            />
          </div>

          <div>
            <label className="block text-sm text-dark-300 mb-2">URL del video</label>
            <div className="flex gap-2">
              <input
                ref={urlRef}
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=... o URL embed"
                className="input flex-1"
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <button onClick={handlePaste} className="btn-secondary">
                Pegar
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={!url.trim()} className="btn-primary">
              <Plus size={18} />
              Guardar enlace
            </button>
            {url.trim() && (
              <button
                onClick={() => handlePlay(url.trim(), name.trim() || 'Reproducción directa')}
                className="btn-secondary"
              >
                <Play size={18} />
                Reproducir ahora
              </button>
            )}
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-xl font-bold text-white mb-4">Enlaces guardados</h2>

        {customStreams.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Clapperboard className="text-dark-600" size={48} />
            <p className="text-dark-400">No tienes enlaces guardados</p>
            <p className="text-dark-500 text-sm">Añade una URL arriba para empezar</p>
          </div>
        ) : (
          <div className="space-y-2">
            {customStreams.map(stream => (
              <div
                key={stream.id}
                className="flex items-center gap-4 bg-dark-800 rounded-lg p-4 hover:bg-dark-700 transition-colors group"
              >
                <div className="flex-shrink-0 w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
                  <Link2 className="text-primary-400" size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{stream.name}</p>
                  <p className="text-xs text-dark-500 truncate">{stream.url}</p>
                </div>
                <button
                  onClick={() => handlePlay(stream.url, stream.name)}
                  className="btn-ghost p-2 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Play size={20} />
                </button>
                <button
                  onClick={() => handleDelete(stream.id)}
                  className="btn-ghost p-2 text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
