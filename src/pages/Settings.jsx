import { useState } from 'react'
import { Settings as SettingsIcon, Key, Check, ExternalLink, AlertCircle, Film, Captions, Monitor } from 'lucide-react'

export default function Settings() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('optopus_tmdb_key') || '')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [osApiKey, setOsApiKey] = useState(localStorage.getItem('optopus_opensubs_apikey') || '')
  const [osSaved, setOsSaved] = useState(false)
  const [osError, setOsError] = useState('')

  // Screensaver settings
  const [ssEnabled, setSsEnabled] = useState(localStorage.getItem('optopus_screensaver_enabled') !== 'false')
  const [ssTimeout, setSsTimeout] = useState(parseInt(localStorage.getItem('optopus_screensaver_timeout') || '5', 10))

  const handleScreensaverSave = () => {
    localStorage.setItem('optopus_screensaver_enabled', ssEnabled ? 'true' : 'false')
    localStorage.setItem('optopus_screensaver_timeout', String(ssTimeout))
    setSsSaved(true)
    setTimeout(() => setSsSaved(false), 2000)
  }

  const [ssSaved, setSsSaved] = useState(false)

  const handleSave = async () => {
    setError('')
    const key = apiKey.trim()
    if (!key) {
      localStorage.removeItem('optopus_tmdb_key')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return
    }

    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/configuration?api_key=${key}`
      )
      if (!res.ok) {
        setError('API key inválida. Verifica tu clave en themoviedb.org')
        return
      }
      localStorage.setItem('optopus_tmdb_key', key)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('No se pudo verificar la API key. Revisa tu conexión.')
    }
  }

  const handleOsSave = () => {
    setOsError('')
    const key = osApiKey.trim()
    if (!key) {
      localStorage.removeItem('optopus_opensubs_apikey')
      setOsSaved(true)
      setTimeout(() => setOsSaved(false), 2000)
      return
    }
    localStorage.setItem('optopus_opensubs_apikey', key)
    setOsSaved(true)
    setTimeout(() => setOsSaved(false), 2000)
  }

  return (
    <div className="p-4 lg:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <SettingsIcon className="text-primary-500" size={28} />
        <h1 className="text-2xl font-bold text-white">Configuración</h1>
      </div>

      <div className="bg-dark-800 rounded-xl p-5 border border-dark-700 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
            <Film className="text-primary-400" size={22} />
          </div>
          <div>
            <h3 className="text-white font-bold">TMDB API Key</h3>
            <p className="text-dark-400 text-sm">
              Necesaria para el plugin de películas y series con datos reales
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
              <Key size={14} />
              API Key (v3 auth)
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Introduce tu TMDB API key"
              className="input w-full"
              onKeyDown={e => e.key === 'Enter' && handleSave()}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {saved && (
            <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
              <Check size={16} />
              Configuración guardada correctamente
            </div>
          )}

          <button onClick={handleSave} className="btn-primary">
            <Check size={18} />
            Guardar
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-dark-700">
          <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key gratuita?</p>
          <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
            <li>Regístrate en themoviedb.org</li>
            <li>Ve a Configuración → API</li>
            <li>Solicita una API key (tipo Developer)</li>
            <li>Copia la "API Key (v3 auth)" y pégala arriba</li>
          </ol>
          <a
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
          >
            Ir a themoviedb.org
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      <div className="bg-dark-800 rounded-xl p-5 border border-dark-700 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
            <Captions className="text-primary-400" size={22} />
          </div>
          <div>
            <h3 className="text-white font-bold">OpenSubtitles API Key</h3>
            <p className="text-dark-400 text-sm">
              Necesaria para buscar y cargar subtítulos en el reproductor
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
              <Key size={14} />
              API Key
            </label>
            <input
              type="password"
              value={osApiKey}
              onChange={e => setOsApiKey(e.target.value)}
              placeholder="Introduce tu OpenSubtitles API key"
              className="input w-full"
              onKeyDown={e => e.key === 'Enter' && handleOsSave()}
            />
          </div>

          {osError && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-lg p-3">
              <AlertCircle size={16} />
              {osError}
            </div>
          )}

          {osSaved && (
            <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
              <Check size={16} />
              Configuración guardada correctamente
            </div>
          )}

          <button onClick={handleOsSave} className="btn-primary">
            <Check size={18} />
            Guardar
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-dark-700">
          <p className="text-dark-400 text-sm mb-2">¿Cómo obtener una API key gratuita?</p>
          <ol className="text-dark-500 text-sm space-y-1 list-decimal list-inside">
            <li>Regístrate en opensubtitles.com</li>
            <li>Ve a API consumers → Register</li>
            <li>Copia tu API key</li>
            <li>Pégala arriba</li>
          </ol>
          <a
            href="https://www.opensubtitles.com/consumers"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary-400 text-sm mt-2 hover:text-primary-300"
          >
            Ir a opensubtitles.com
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      <div className="bg-dark-800 rounded-xl p-5 border border-dark-700 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-primary-600/20 rounded-lg flex items-center justify-center">
            <Monitor className="text-primary-400" size={22} />
          </div>
          <div>
            <h3 className="text-white font-bold">Salvapantallas</h3>
            <p className="text-dark-400 text-sm">
              Se activa tras un periodo de inactividad mostrando el logo animado
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-dark-300">Activar salvapantallas automático</span>
            <button
              onClick={() => setSsEnabled(!ssEnabled)}
              className={`relative w-12 h-6 rounded-full transition-colors ${ssEnabled ? 'bg-primary-600' : 'bg-dark-700'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${ssEnabled ? 'translate-x-6' : ''}`}
              />
            </button>
          </label>

          {ssEnabled && (
            <div>
              <label className="flex items-center gap-2 text-sm text-dark-300 mb-2">
                Tiempo de inactividad (minutos)
              </label>
              <input
                type="number"
                min="1"
                max="60"
                value={ssTimeout}
                onChange={e => setSsTimeout(Math.max(1, parseInt(e.target.value) || 5))}
                className="input w-24"
              />
            </div>
          )}

          {ssSaved && (
            <div className="flex items-center gap-2 text-green-400 text-sm bg-green-500/10 rounded-lg p-3">
              <Check size={16} />
              Configuración guardada correctamente
            </div>
          )}

          <button onClick={handleScreensaverSave} className="btn-primary">
            <Check size={18} />
            Guardar
          </button>
        </div>
      </div>

      <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
        <h3 className="text-white font-bold mb-2">Estado de la configuración</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-dark-400">TMDB API Key</span>
            {localStorage.getItem('optopus_tmdb_key') ? (
              <span className="flex items-center gap-1 text-green-400">
                <Check size={14} /> Configurada
              </span>
            ) : (
              <span className="flex items-center gap-1 text-dark-500">
                <AlertCircle size={14} /> No configurada
              </span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-400">OpenSubtitles API Key</span>
            {localStorage.getItem('optopus_opensubs_apikey') ? (
              <span className="flex items-center gap-1 text-green-400">
                <Check size={14} /> Configurada
              </span>
            ) : (
              <span className="flex items-center gap-1 text-dark-500">
                <AlertCircle size={14} /> No configurada
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
