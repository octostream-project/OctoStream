// Skeleton de tarjeta de contenido mientras carga el catálogo: evita el
// salto de "pantalla vacía" del spinner y da sensación de rapidez.
export function SkeletonCard() {
  return (
    <div className="card animate-pulse" aria-hidden="true">
      <div className="aspect-[2/3] bg-dark-700" />
      <div className="p-2 space-y-1.5">
        <div className="h-3 rounded bg-dark-700 w-3/4" />
        <div className="h-2.5 rounded bg-dark-800 w-1/2" />
      </div>
    </div>
  )
}

export function SkeletonGrid({ count = 12, Grid }) {
  const content = Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)
  if (Grid) return <Grid>{content}</Grid>
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{content}</div>
}

// Skeleton de una fila horizontal con título (vista "Todas" de Home).
export function SkeletonRow({ count = 6 }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-5 w-40 rounded bg-dark-700 animate-pulse" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="w-36 shrink-0 animate-pulse">
            <div className="aspect-[2/3] rounded-lg bg-dark-700" />
            <div className="mt-2 h-3 w-3/4 rounded bg-dark-700" />
          </div>
        ))}
      </div>
    </div>
  )
}
