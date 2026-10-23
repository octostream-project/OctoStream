import { useNavigate } from 'react-router-dom'
import { Wifi, ArrowLeft } from 'lucide-react'
import { isAndroidNative, isElectron } from '../utils/platform.js'
import SyncDevices from '../components/SyncDevices.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'

// Página /sync: envoltorio del panel SyncDevices (también embebido en el tab
// "Sincronizar" de Ajustes — mismo componente, mismos dispositivos).
export default function Sync() {
  const navigate = useNavigate()

  if (!isAndroidNative() && !isElectron()) {
    return (
      <div className="p-4 lg:p-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/settings')} className="btn-ghost p-2">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-white">Sincronizar</h1>
        </div>
        <EmptyState icon={Wifi} minH="min-h-[50vh]">
          Sincronización disponible en la app de Android y de escritorio
          <div className="text-dark-500 text-sm mt-1">Instala la app en Android o en tu PC para sincronizar entre dispositivos</div>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/settings')} className="btn-ghost p-2" data-tv-card tabIndex={0}>
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-white">Sincronizar dispositivos</h1>
      </div>
      <SyncDevices />
    </div>
  )
}
