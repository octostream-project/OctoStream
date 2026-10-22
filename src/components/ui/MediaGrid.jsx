// Grid de tarjetas de contenido: la misma cadena de columnas estaba
// copiada en Home, Favorites, Search y Catalog.
export default function MediaGrid({ children, className = '' }) {
  return (
    <div
      data-tv-grid
      className={`media-card-grid grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 ${className}`}
    >
      {children}
    </div>
  )
}
