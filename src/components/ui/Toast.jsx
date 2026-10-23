import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, X } from 'lucide-react'

// Sistema de toasts global. Antes los errores eran texto rojo inline por
// componente y los éxitos no existían. Uso:
//   import { toast } from '../components/ui/Toast.jsx'
//   toast('Descarga completada') / toast.error('Falló la red')
// <ToastHost /> va montado una vez en App.jsx.
let nextId = 1
const listeners = new Set()

function emit(msg, type = 'info', ms = 4000) {
  const t = { id: nextId++, msg: String(msg), type }
  listeners.forEach(fn => fn(t))
  return t.id
}

export const toast = Object.assign(
  (msg, ms) => emit(msg, 'info', ms),
  {
    error: (msg, ms = 6000) => emit(msg, 'error', ms),
    success: (msg, ms) => emit(msg, 'success', ms),
  }
)

export function ToastHost() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const onToast = (t) => {
      setToasts(prev => [...prev, t])
      const ms = t.type === 'error' ? 6000 : 4000
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), ms)
    }
    listeners.add(onToast)
    return () => listeners.delete(onToast)
  }, [])

  if (!toasts.length) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex flex-col items-center gap-2 px-4 w-full max-w-md pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.type === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 shadow-2xl border text-sm w-full backdrop-blur ${
            t.type === 'error'
              ? 'bg-red-950/90 border-red-800 text-red-200'
              : t.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-800 text-emerald-200'
                : 'bg-dark-800/95 border-dark-600 text-white'
          }`}
        >
          {t.type === 'error' ? <AlertCircle size={18} className="flex-shrink-0" /> : <CheckCircle2 size={18} className="flex-shrink-0" />}
          <span className="flex-1 min-w-0">{t.msg}</span>
          <button
            onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
            className="flex-shrink-0 opacity-60 hover:opacity-100"
            aria-label="Cerrar aviso"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
