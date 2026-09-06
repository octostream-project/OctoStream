import { useEffect, useRef, useState } from 'react'
import { Clapperboard } from 'lucide-react'

// Animated screensaver: logo floats around the screen with subtle rotation.
// Dismissed on any user interaction (mousemove, click, keypress, touch).

export default function Screensaver({ onDismiss }) {
  const [pos, setPos] = useState({ x: 50, y: 50 })
  const [rot, setRot] = useState(0)
  const rafRef = useRef(null)
  const startTimeRef = useRef(Date.now())
  const dismissedRef = useRef(false)

  // Floating animation
  useEffect(() => {
    const animate = () => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      // Smooth Lissajous-like movement
      const x = 50 + 35 * Math.sin(elapsed * 0.35)
      const y = 50 + 30 * Math.sin(elapsed * 0.27 + 1.2)
      const rotation = Math.sin(elapsed * 0.2) * 8
      setPos({ x, y })
      setRot(rotation)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // Dismiss on any interaction
  useEffect(() => {
    const dismiss = () => {
      if (dismissedRef.current) return
      dismissedRef.current = true
      onDismiss?.()
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel', 'click']
    events.forEach(e => window.addEventListener(e, dismiss, { once: true, passive: true }))
    return () => {
      events.forEach(e => window.removeEventListener(e, dismiss))
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
      {/* Floating logo */}
      <div
        className="absolute transition-none"
        style={{
          left: `${pos.x}%`,
          top: `${pos.y}%`,
          transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        }}
      >
        <div className="flex flex-col items-center gap-4 opacity-80">
          <Clapperboard
            className="text-primary-500"
            size={120}
            style={{ filter: 'drop-shadow(0 0 30px rgba(245, 158, 11, 0.4))' }}
          />
          <h1 className="text-3xl font-bold text-white tracking-wide">
            Optopus<span className="text-primary-500"> Stream</span>
          </h1>
          <p className="text-dark-500 text-sm">Media Center</p>
        </div>
      </div>

      {/* Hint at bottom */}
      <div className="absolute bottom-8 left-0 right-0 text-center">
        <p className="text-dark-600 text-sm animate-pulse">
          Mueve el ratón o pulsa una tecla para continuar
        </p>
      </div>

      <style>{`
        @keyframes screensaver-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
