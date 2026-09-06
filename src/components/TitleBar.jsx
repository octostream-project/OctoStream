import { X, Fullscreen } from 'lucide-react'

export default function TitleBar() {
  const isElectron = typeof window !== 'undefined' && window.octo?.platform === 'electron'

  if (!isElectron) return null

  const handleFullscreen = () => window.octo?.toggleFullscreen?.()
  const handleClose = () => window.octo?.closeApp?.()

  return (
    <div
      className="h-10 bg-dark-900 border-b border-dark-700 flex items-center justify-between select-none"
      style={{ WebkitAppRegion: 'drag' }}
    >
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag' }}>
        <img src="./logo.png" alt="OctoStream" className="w-5 h-5 rounded" />
        <span className="text-sm font-medium text-white">OctoStream</span>
      </div>
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        <button
          onClick={handleFullscreen}
          className="h-full px-4 text-white hover:bg-dark-700 transition-colors flex items-center"
          title="Pantalla completa"
        >
          <Fullscreen size={18} />
        </button>
        <button
          onClick={handleClose}
          className="h-full px-4 text-white hover:bg-red-600 transition-colors flex items-center"
          title="Cerrar"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  )
}
