import { useState, useRef } from 'react'
import { useStore } from '../store/useStore.js'
import {
  Puzzle, Check, Download, Trash2, Film, Tv, Radio, Play,
  Globe, Plus, Link, FileJson, AlertCircle, Upload, Cloud,
  Trophy,
} from 'lucide-react'
import OctoLoader from '../components/OctoLoader.jsx'

const iconMap = {
  film: Film,
  tv: Tv,
  radio: Radio,
  play: Play,
  globe: Globe,
  trophy: Trophy,
}

export default function Plugins() {
  const {
    plugins,
    installedPlugins,
    externalPlugins,
    installPlugin,
    uninstallPlugin,
    addExternalPlugin,
    addExternalPluginByUrl,
    removeExternalPlugin,
  } = useStore()

  const [activeTab, setActiveTab] = useState('repository')
  const [manifestUrl, setManifestUrl] = useState('')
  const [jsonInput, setJsonInput] = useState('')
  const [formError, setFormError] = useState(null)
  const [formSuccess, setFormSuccess] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Remote repository state
  const [repoUrl, setRepoUrl] = useState('')
  const [repoItems, setRepoItems] = useState([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoError, setRepoError] = useState(null)
  const fileInputRef = useRef(null)

  const isInstalled = (pluginId) => installedPlugins.some(p => p.id === pluginId)

  const handleInstallExternalByUrl = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    if (!manifestUrl.trim()) return
    setIsSubmitting(true)
    try {
      const plugin = await addExternalPluginByUrl(manifestUrl.trim())
      setFormSuccess(`Plugin "${plugin.manifest.name}" añadido e instalado`)
      setManifestUrl('')
    } catch (err) {
      setFormError(err?.message || 'Error al añadir el plugin')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleInstallExternalByJson = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    if (!jsonInput.trim()) return
    setIsSubmitting(true)
    try {
      const config = JSON.parse(jsonInput)
      const plugin = await addExternalPlugin(config)
      setFormSuccess(`Plugin "${plugin.manifest.name}" añadido e instalado`)
      setJsonInput('')
    } catch (err) {
      setFormError(err?.message || 'JSON inválido')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFormError(null)
    setFormSuccess(null)
    setIsSubmitting(true)
    try {
      const text = await file.text()
      const config = JSON.parse(text)
      const plugin = await addExternalPlugin(config)
      setFormSuccess(`Plugin "${plugin.manifest.name}" añadido e instalado`)
    } catch (err) {
      setFormError(err?.message || 'Archivo JSON inválido')
    } finally {
      setIsSubmitting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleLoadRepository = async (e) => {
    e.preventDefault()
    setRepoError(null)
    if (!repoUrl.trim()) return
    setRepoLoading(true)
    setRepoItems([])
    try {
      const res = await fetch(repoUrl.trim(), {
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items = Array.isArray(data) ? data : (data.addons || data.plugins || [])
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('El repositorio no contiene addons')
      }
      setRepoItems(items)
    } catch (err) {
      setRepoError(err?.message || 'Error al cargar el repositorio')
    } finally {
      setRepoLoading(false)
    }
  }

  const handleInstallFromRepo = async (item) => {
    setFormError(null)
    setFormSuccess(null)
    setIsSubmitting(true)
    try {
      let plugin
      if (item.manifestUrl) {
        plugin = await addExternalPluginByUrl(item.manifestUrl)
      } else {
        plugin = await addExternalPlugin(item)
      }
      setFormSuccess(`Plugin "${plugin.manifest.name}" añadido e instalado`)
    } catch (err) {
      setFormError(err?.message || 'Error al instalar el addon')
    } finally {
      setIsSubmitting(false)
    }
  }

  const pluginCard = (plugin, isExternal = false) => {
    const Icon = iconMap[plugin.manifest.icon] || Puzzle
    const installed = isInstalled(plugin.id)
    return (
      <div
        key={plugin.id}
        className="bg-dark-800 rounded-xl p-5 border border-dark-700 hover:border-primary-500/50 transition-colors"
      >
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 bg-primary-600/20 rounded-lg flex items-center justify-center">
            <Icon className="text-primary-400" size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-white font-bold text-lg">{plugin.manifest.name}</h3>
              <span className="text-xs text-dark-500">v{plugin.manifest.version}</span>
              {isExternal && (
                <span className="text-xs bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded">Externo</span>
              )}
              {!isExternal && (
                <span className="text-xs bg-purple-600/20 text-purple-400 px-2 py-0.5 rounded">Incluido</span>
              )}
            </div>
            <p className="text-dark-400 text-sm mt-1">{plugin.manifest.description}</p>

            {plugin.manifest.types && plugin.manifest.types.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {plugin.manifest.types.map(t => (
                  <span key={t} className="text-xs bg-dark-700 text-dark-300 px-2 py-0.5 rounded">
                    {t}
                  </span>
                ))}
              </div>
            )}

            {plugin.manifest.catalogs && plugin.manifest.catalogs.length > 0 && (
              <p className="text-xs text-dark-500 mt-2">
                {plugin.manifest.catalogs.length} catálogo{plugin.manifest.catalogs.length !== 1 ? 's' : ''} disponible{plugin.manifest.catalogs.length !== 1 ? 's' : ''}
              </p>
            )}

            <div className="mt-4">
              {installed ? (
                <button
                  onClick={() => isExternal ? removeExternalPlugin(plugin.id) : uninstallPlugin(plugin.id)}
                  className="btn-secondary text-sm text-red-400 hover:text-red-300 inline-flex items-center gap-2"
                >
                  <Trash2 size={16} />
                  {isExternal ? 'Eliminar' : 'Desinstalar'}
                </button>
              ) : (
                <button
                  onClick={() => installPlugin(plugin.id)}
                  className="btn-primary text-sm inline-flex items-center gap-2"
                >
                  <Download size={16} />
                  Instalar
                </button>
              )}
            </div>
          </div>
          {installed && (
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center">
                <Check className="text-green-400" size={18} />
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center gap-3 mb-6">
        <Puzzle className="text-primary-500" size={28} />
        <h1 className="text-2xl font-bold text-white">Plugins</h1>
      </div>

      <p className="text-dark-400 text-sm mb-6">
        Los plugins extienden la funcionalidad de OctoStream. Activa los incluidos o añade más abajo.
      </p>

      <div className="flex gap-2 mb-6 border-b border-dark-800">
        <button
          onClick={() => setActiveTab('repository')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'repository'
              ? 'text-primary-400 border-primary-500'
              : 'text-dark-400 border-transparent hover:text-white'
          }`}
        >
          Repositorio
        </button>
        <span className="px-4 py-2 text-sm text-dark-500">
          Solo plugins incluidos en la aplicación
        </span>
      </div>

      {activeTab === 'repository' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {plugins.filter(p => !p.isExternal || p.isBundled).map(plugin => pluginCard(plugin, false))}
        </div>
      )}

      {activeTab === 'external' && (
        <div className="space-y-6">
          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2 flex items-center gap-2">
              <Link size={18} className="text-primary-400" />
              Añadir plugin externo
            </h3>
            <p className="text-dark-400 text-sm mb-4">
              Soporta manifest JSON (terminado en <code>/manifest.json</code>).
            </p>
            <form onSubmit={handleInstallExternalByUrl} className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={manifestUrl}
                onChange={e => setManifestUrl(e.target.value)}
                placeholder="https://ejemplo.com/manifest.json"
                className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary-500"
              />
              <button
                type="submit"
                disabled={isSubmitting || !manifestUrl.trim()}
                className="btn-primary text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Plus size={16} />
                {isSubmitting ? 'Añadiendo...' : 'Añadir e instalar'}
              </button>
            </form>
          </div>

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2 flex items-center gap-2">
              <FileJson size={18} className="text-primary-400" />
              Pegar configuración JSON
            </h3>
            <p className="text-dark-400 text-sm mb-4">
              También puedes pegar el JSON completo del plugin (manifest + api.baseUrl).
            </p>
            <form onSubmit={handleInstallExternalByJson} className="space-y-2">
              <textarea
                value={jsonInput}
                onChange={e => setJsonInput(e.target.value)}
                placeholder='{ &quot;manifest&quot;: { ... }, &quot;baseUrl&quot;: &quot;https://...&quot; }'
                rows={5}
                className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary-500 font-mono"
              />
              <button
                type="submit"
                disabled={isSubmitting || !jsonInput.trim()}
                className="btn-primary text-sm inline-flex items-center gap-2 disabled:opacity-50"
              >
                <Plus size={16} />
                Instalar desde JSON
              </button>
            </form>
          </div>

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2 flex items-center gap-2">
              <Upload size={18} className="text-primary-400" />
              Cargar archivo JSON
            </h3>
            <p className="text-dark-400 text-sm mb-4">
              Selecciona un archivo <code>.json</code> con la configuración del plugin desde tu dispositivo.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileUpload}
              disabled={isSubmitting}
              className="block w-full text-sm text-dark-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-primary-600 file:text-white file:cursor-pointer hover:file:bg-primary-500"
            />
          </div>

          <div className="bg-dark-800/50 rounded-xl p-5 border border-dark-700">
            <h3 className="text-white font-bold mb-2 flex items-center gap-2">
              <Cloud size={18} className="text-primary-400" />
              Repositorio remoto de addons
            </h3>
            <p className="text-dark-400 text-sm mb-4">
              Carga una lista de addons desde una URL (JSON con un array de <code>manifestUrl</code> o configuraciones completas).
            </p>
            <form onSubmit={handleLoadRepository} className="flex flex-col sm:flex-row gap-2 mb-4">
              <input
                type="url"
                value={repoUrl}
                onChange={e => setRepoUrl(e.target.value)}
                placeholder="https://repositorio.example.com/addons.json"
                className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary-500"
              />
              <button
                type="submit"
                disabled={repoLoading || !repoUrl.trim()}
                className="btn-primary text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {repoLoading ? <OctoLoader size={16} /> : <Cloud size={16} />}
                {repoLoading ? 'Cargando...' : 'Cargar lista'}
              </button>
            </form>

            {repoError && (
              <div className="rounded-lg p-3 mb-3 bg-red-900/20 border border-red-800 flex items-start gap-2">
                <AlertCircle className="text-red-400 flex-shrink-0" size={18} />
                <p className="text-sm text-red-200">{repoError}</p>
              </div>
            )}

            {repoItems.length > 0 && (
              <div className="space-y-2">
                {repoItems.map((item, idx) => {
                  const itemId = item.manifest?.id || item.id || `repo-${idx}`
                  const itemName = item.manifest?.name || item.name || item.manifestUrl || 'Addon'
                  const itemDesc = item.manifest?.description || item.description || ''
                  const installed = isInstalled(itemId) || externalPlugins.some(ep => ep.id === itemId)
                  return (
                    <div key={idx} className="flex items-center gap-3 bg-dark-900 rounded-lg p-3 border border-dark-700">
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{itemName}</p>
                        {itemDesc && <p className="text-dark-400 text-xs truncate">{itemDesc}</p>}
                      </div>
                      {installed ? (
                        <span className="text-xs text-green-400 inline-flex items-center gap-1">
                          <Check size={14} /> Instalado
                        </span>
                      ) : (
                        <button
                          onClick={() => handleInstallFromRepo(item)}
                          disabled={isSubmitting}
                          className="btn-primary text-xs inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Download size={14} />
                          Instalar
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {(formError || formSuccess) && (
            <div className={`rounded-xl p-4 flex items-start gap-3 ${formError ? 'bg-red-900/20 border border-red-800' : 'bg-green-900/20 border border-green-800'}`}>
              {formError ? <AlertCircle className="text-red-400 flex-shrink-0" size={20} /> : <Check className="text-green-400 flex-shrink-0" size={20} />}
              <p className={`text-sm ${formError ? 'text-red-200' : 'text-green-200'}`}>{formError || formSuccess}</p>
            </div>
          )}

          {externalPlugins.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {externalPlugins.map(plugin => pluginCard(plugin, true))}
            </div>
          ) : (
            <p className="text-dark-500 text-sm">No tienes plugins externos instalados.</p>
          )}
        </div>
      )}

      <div className="mt-8 bg-dark-800/50 rounded-xl p-5 border border-dark-700">
        <h3 className="text-white font-bold mb-2">Desarrollar plugins</h3>
        <p className="text-dark-400 text-sm">
          <strong>Internos:</strong> añade un archivo en <code className="text-primary-400">src/plugins/builtIn/</code> y regístralo en el índice.
          <br />
          <strong>Externos:</strong> crea un servidor REST con endpoints <code className="text-primary-400">catalog</code>, <code className="text-primary-400">meta</code>, <code className="text-primary-400">streams</code> y <code className="text-primary-400">search</code>.
        </p>
      </div>
    </div>
  )
}
