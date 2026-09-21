import { useEffect, useRef } from 'react'

// Animated screensaver: logo floats around the screen with subtle rotation.
// Dismissed on any user interaction (mousemove, click, keypress, touch).
// La animación es 100% CSS (compositor/GPU): la versión anterior usaba
// requestAnimationFrame + setState, que re-renderizaba el componente a 60fps
// — precisamente cuando la TV está en reposo y conviene ahorrar CPU/batería.

export default function Screensaver({ onDismiss }) {
  const dismissedRef = useRef(false)

  // Dismiss on any interaction. Capture + stopImmediatePropagation +
  // preventDefault: el toque/tecla que despierta NO se propaga a la app
  // (antes el tap en móvil descartaba en touchstart y el click sintetizado
  // abría lo que quedaba debajo del dedo).
  useEffect(() => {
    const dismiss = (e) => {
      e?.preventDefault?.()
      e?.stopImmediatePropagation?.()
      if (dismissedRef.current) return
      dismissedRef.current = true
      onDismiss?.()
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel', 'click']
    events.forEach(e => window.addEventListener(e, dismiss, { once: true, capture: true }))
    return () => {
      events.forEach(e => window.removeEventListener(e, dismiss, { capture: true }))
    }
  }, [onDismiss])

  return (
    <div
      className="fixed inset-0 z-[100] bg-black flex items-center justify-center cursor-pointer"
      style={{ animation: 'screensaver-fade-in 0.6s ease-out' }}
      onClick={() => {
        if (!dismissedRef.current) {
          dismissedRef.current = true
          onDismiss?.()
        }
      }}
    >
      {/* Floating logo: dos ejes con duraciones distintas = trayectoria
          tipo Lissajous sin un solo frame de JS */}
      <div className="absolute" style={{ animation: 'screensaver-drift-x 14s ease-in-out infinite alternate', left: '15%', right: '15%', top: 0, bottom: 0 }}>
        <div className="absolute left-0 right-0" style={{ animation: 'screensaver-drift-y 11s ease-in-out infinite alternate', top: '15%', bottom: '15%' }}>
          <div className="flex flex-col items-center gap-4 opacity-80" style={{ animation: 'screensaver-tilt 9s ease-in-out infinite alternate' }}>
            <img
              src="/logo-full.png"
              alt="OctoStream"
              className="w-64 h-auto"
              style={{ filter: 'drop-shadow(0 0 40px rgba(124, 58, 237, 0.45))' }}
              draggable={false}
            />
          </div>
        </div>
      </div>

      {/* Hint at bottom */}
      <div className="absolute bottom-8 left-0 right-0 text-center">
        <p className="text-dark-600 text-sm animate-pulse">
          Toca la pantalla o pulsa una tecla para continuar
        </p>
      </div>

      <style>{`
        @keyframes screensaver-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes screensaver-drift-x {
          from { transform: translateX(0); }
          to { transform: translateX(100%); }
        }
        @keyframes screensaver-drift-y {
          from { transform: translateY(0); }
          to { transform: translateY(100%); }
        }
        @keyframes screensaver-tilt {
          from { transform: rotate(-8deg); }
          to { transform: rotate(8deg); }
        }
      `}</style>
    </div>
  )
}
