import { useStore } from '../store/useStore.js'
import { Puzzle, Check, Download, Trash2, Film, Tv, Radio, Play } from 'lucide-react'

const iconMap = {
  film: Film,
  tv: Tv,
  radio: Radio,
  play: Play,
}

export default function Plugins() {
  const { plugins, installedPlugins, installPlugin, uninstallPlugin } = useStore()

  const isInstalled = (pluginId) => installedPlugins.some(p => p.id === pluginId)

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center gap-3 mb-6">
        <Puzzle className="text-primary-500" size={28} />
        <h1 className="text-2xl font-bold text-white">Plugins</h1>
      </div>

      <p className="text-dark-400 text-sm mb-6">
        Los plugins extienden la funcionalidad de Optopus Stream. Instala o desinstálalos según tus necesidades.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {plugins.map(plugin => {
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
                  <div className="flex items-center gap-2">
                    <h3 className="text-white font-bold text-lg">{plugin.manifest.name}</h3>
                    <span className="text-xs text-dark-500">v{plugin.manifest.version}</span>
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
                        onClick={() => uninstallPlugin(plugin.id)}
                        className="btn-secondary text-sm text-red-400 hover:text-red-300"
                      >
                        <Trash2 size={16} />
                        Desinstalar
                      </button>
                    ) : (
                      <button
                        onClick={() => installPlugin(plugin.id)}
                        className="btn-primary text-sm"
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
        })}
      </div>

      <div className="mt-8 bg-dark-800/50 rounded-xl p-5 border border-dark-700">
        <h3 className="text-white font-bold mb-2">Desarrollar plugins personalizados</h3>
        <p className="text-dark-400 text-sm">
          Optopus Stream soporta plugins personalizados. Crea un plugin extendiendo la clase
          <code className="text-primary-400 mx-1">Plugin</code>
          e implementando los métodos
          <code className="text-primary-400 mx-1">getCatalog</code>,
          <code className="text-primary-400 mx-1">getStreams</code>,
          <code className="text-primary-400 mx-1">getMeta</code>
          y
          <code className="text-primary-400 mx-1">search</code>.
        </p>
      </div>
    </div>
  )
}
