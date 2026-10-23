// Interruptor compartido de Ajustes: antes era el mismo bloque de clases
// copiado 7 veces y sin semántica accesible. role="switch" + aria-checked
// hace que lectores de pantalla y la navegación TV lo anuncien bien.
export default function Toggle({ checked, onChange, disabled = false, label, color = 'primary' }) {
  const onColor = color === 'green' ? 'bg-green-600' : color === 'yellow' ? 'bg-yellow-600' : 'bg-primary-600'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      data-tv-card
      tabIndex={0}
      onClick={() => !disabled && onChange?.(!checked)}
      disabled={disabled}
      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? onColor : 'bg-dark-700'} ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${checked ? 'translate-x-6' : ''}`}
      />
    </button>
  )
}
