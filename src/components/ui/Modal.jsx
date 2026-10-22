import { useEffect, useRef } from 'react'

// Modal compartido: overlay uniforme, role=dialog + aria-modal, cierre con
// Escape/Backspace (útil en TV con botón "atrás") y clic en el fondo.
// Antes cada diálogo improvisaba overlay, z-index y tarjeta — 14 variantes.
export default function Modal({
  onClose,
  children,
  className = '',
  z = 'z-[95]',
  closeOnBackdrop = true,
  labelledBy,
}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const prev = document.activeElement
    // Foco inicial en el primer control del diálogo, o el diálogo mismo.
    const target = dialogRef.current?.querySelector('button, input, [tabindex]') || dialogRef.current
    target?.focus?.({ preventScroll: true })
    return () => prev?.focus?.({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.stopPropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      data-tv-modal
      className={`fixed inset-0 ${z} flex items-center justify-center bg-black/70 p-4`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`w-[min(90vw,480px)] rounded-2xl bg-dark-800 border border-dark-700 p-6 shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
