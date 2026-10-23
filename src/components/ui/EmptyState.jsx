import { Clapperboard } from 'lucide-react'

// Estado vacío compartido: icono grande + texto centrado en tarjeta suave.
// El patrón mejor valorado era el de Mi lista — ahora es el de todas.
export default function EmptyState({ icon: Icon = Clapperboard, children, minH = 'min-h-[40vh]', action, onAction, ...rest }) {
  return (
    <div {...rest} className={`flex ${minH} flex-col items-center justify-center gap-4 rounded-2xl border border-dark-800 bg-dark-900/50 px-6 text-center`}>
      <Icon className="text-dark-600" size={56} />
      <div className="max-w-lg text-dark-300">{children}</div>
      {action && onAction && (
        <button onClick={onAction} tabIndex={0} data-tv-card className="btn-secondary px-4 py-2 text-sm">
          {action}
        </button>
      )}
    </div>
  )
}
