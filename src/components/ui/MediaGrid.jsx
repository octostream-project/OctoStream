// Grid de tarjetas de contenido: la misma cadena de columnas estaba
// copiada en Home, Favorites, Search y Catalog.
const GRID_SIZES = {
  compact: {
    columns: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8',
    min: '6rem',
  },
  normal: {
    columns: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
    min: '9rem',
  },
  large: {
    columns: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
    min: '12rem',
  },
}

export default function MediaGrid({ children, className = '', size = 'normal' }) {
  const config = GRID_SIZES[size] || GRID_SIZES.normal
  return (
    <div
      data-tv-grid
      className={`media-card-grid grid gap-4 ${config.columns} ${className}`}
      style={{ '--media-card-min': config.min }}
    >
      {children}
    </div>
  )
}
