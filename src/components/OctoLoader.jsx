import { useId } from 'react'

// OctoStream branded loader: un "8" (lemniscata) — dos círculos tangentes —
// con serpiente luminosa continua, glow SVG nativo y triángulo play
// inscrito en el lazo INFERIOR (identidad de media-center).
//
// Centros: superior (50,32), inferior (50,68), r=18.
const R = 18
const CY1 = 32, CY2 = 68
const FIG8 =
  `M 50 50 ` +
  `A ${R} ${R} 0 1 1 50 ${50 - (50 - CY1) * 2} ` +   // → (50,14)
  `A ${R} ${R} 0 1 1 50 50 ` +                        // → (50,50)
  `A ${R} ${R} 0 1 1 50 ${50 + (CY2 - 50) * 2} ` +   // → (50,86)
  `A ${R} ${R} 0 1 1 50 50 Z`                          // → (50,50)

// Triángulo play centrado en el lazo INFERIOR (centro 50,68).
const PLAY = 'M 44 61 L 44 75 L 56 68 Z'

export default function OctoLoader({ size = 32, className = '' }) {
  const gid = `octo-grad-${useId().replace(/[:]/g, '')}`
  const glow = `octo-glow-${useId().replace(/[:]/g, '')}`
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="status"
      aria-label="Cargando"
    >
      <defs>
        <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="35%" stopColor="#d946ef" />
          <stop offset="65%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
        {/* Glow reproducible a cualquier tamaño */}
        <filter id={glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.8" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 8 base tenue con respiración */}
      <path
        d={FIG8}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.12"
        strokeWidth="10"
        strokeLinecap="round"
      >
        <animate
          attributeName="stroke-opacity"
          values="0.08;0.20;0.08"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </path>

      {/* Triángulo play en el lazo inferior */}
      <path
        d={PLAY}
        fill={`url(#${gid})`}
        fillOpacity="0.22"
      >
        <animate
          attributeName="fill-opacity"
          values="0.14;0.32;0.14"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </path>

      {/* Serpiente luminosa que recorre el 8 sin saltos */}
      <path
        d={FIG8}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth="7"
        strokeLinecap="round"
        filter={`url(#${glow})`}
        pathLength="100"
        strokeDasharray="28 72"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="0"
          to="-100"
          dur="1.5s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}
