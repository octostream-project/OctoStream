// Botón-chip para selectores de pestañas/categorías (el bloque de clases se
// repetía en Home y Favorites). size 'md' para tabs principales, 'sm' para
// categorías secundarias.
export default function Chip({ active, onClick, icon: Icon, children, size = 'md', activeClass = 'bg-primary-600 text-white' }) {
  const base = 'flex items-center gap-2 rounded-lg font-medium transition-colors'
  const pad = size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${pad} ${active ? activeClass : 'bg-dark-800 text-dark-300 hover:bg-dark-700'}`}
    >
      {Icon ? <Icon size={18} /> : null}
      {children}
    </button>
  )
}
