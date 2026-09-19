import { useState, useRef, useEffect, useCallback } from 'react'

// Montaje progresivo de listas: renderiza `initial` items y va añadiendo
// bloques de `step` cuando el sentinel se acerca al viewport o cuando el foco
// se aproxima al final renderizado. A diferencia de la virtualización clásica
// (que saca elementos del DOM y rompe la navegación D-pad), aquí los items se
// quedan montados una vez visibles, así que siempre son enfocables.
export function useWindowedList(items, initial = 60, step = 60) {
  const [count, setCount] = useState(initial)
  const sentinelRef = useRef(null)
  const itemsRef = useRef(items)
  const total = items?.length || 0
  const hasMore = count < total

  const expand = useCallback(() => {
    setCount(c => Math.min(c + step, total))
  }, [step, total])

  // Resetear la ventana si cambia la lista subyacente
  useEffect(() => {
    if (itemsRef.current !== items) {
      itemsRef.current = items
      setCount(initial)
    }
  }, [items, initial])

  // Expandir cuando el sentinel entra en el viewport (scroll o D-pad)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return undefined
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) expand()
    }, { rootMargin: '600px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, expand])

  // Expandir cuando el foco se acerca al final (el D-pad puede llegar antes
  // de que el sentinel entre en viewport)
  const onFocusNearEnd = useCallback((e) => {
    const idx = Number(e.target?.dataset?.windex)
    if (Number.isFinite(idx) && idx >= count - 5) expand()
  }, [count, expand])

  return {
    visible: (items || []).slice(0, count),
    hasMore,
    count,
    sentinelRef,
    onFocusNearEnd,
  }
}
