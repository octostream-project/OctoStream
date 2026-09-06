import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function ScreenSaver() {
  const navigate = useNavigate()
  const [mouseActive, setMouseActive] = useState(false)

  useEffect(() => {
    let timeout
    const resetTimer = () => {
      setMouseActive(true)
      clearTimeout(timeout)
      timeout = setTimeout(() => setMouseActive(false), 3000)
    }

    window.addEventListener('mousemove', resetTimer)
    window.addEventListener('click', () => navigate(-1))
    window.addEventListener('keydown', () => navigate(-1))
    window.addEventListener('touchstart', () => navigate(-1))

    resetTimer()

    return () => {
      window.removeEventListener('mousemove', resetTimer)
      window.removeEventListener('click', () => navigate(-1))
      window.removeEventListener('keydown', () => navigate(-1))
      window.removeEventListener('touchstart', () => navigate(-1))
      clearTimeout(timeout)
    }
  }, [navigate])

  return (
    <div className="fixed inset-0 z-50 bg-black overflow-hidden cursor-none">
      <div className="absolute inset-0 bg-gradient-to-br from-dark-950 via-black to-dark-900" />

      {/* Floating logos with transparency */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative w-96 h-96 animate-float-slow">
          <img
            src="./logo.png"
            alt="OctoStream"
            className="w-full h-full object-contain opacity-40 drop-shadow-[0_0_60px_rgba(99,102,241,0.3)]"
          />
        </div>
      </div>

      {/* Secondary floating logos with different positions and opacity */}
      <div className="absolute top-20 left-20 w-32 h-32 animate-float opacity-20">
        <img src="./logo.png" alt="" className="w-full h-full object-contain" />
      </div>
      <div className="absolute bottom-32 right-24 w-48 h-48 animate-float-delayed opacity-15">
        <img src="./logo.png" alt="" className="w-full h-full object-contain" />
      </div>
      <div className="absolute top-1/3 right-16 w-24 h-24 animate-float opacity-10">
        <img src="./logo.png" alt="" className="w-full h-full object-contain" />
      </div>
      <div className="absolute bottom-20 left-1/4 w-20 h-20 animate-float-delayed opacity-10">
        <img src="./logo.png" alt="" className="w-full h-full object-contain" />
      </div>

      {/* Hint to exit */}
      <div className={`absolute bottom-8 left-0 right-0 text-center transition-opacity duration-500 ${mouseActive ? 'opacity-100' : 'opacity-0'}`}>
        <p className="text-dark-400 text-sm bg-dark-900/50 inline-block px-4 py-2 rounded-full backdrop-blur-sm">
          Mueve el ratón, haz clic o pulsa cualquier tecla para salir
        </p>
      </div>
    </div>
  )
}
