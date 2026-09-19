// Pulsating logo loader — same animation as the WARP connecting overlay.
// Used for full-screen loading states (Home, Details, LiveTV, etc.).

export default function LogoLoader({ size = 80, className = '' }) {
  return (
    <img
      src="/logo-symbol.png"
      alt=""
      draggable={false}
      style={{ width: size, height: size }}
      className={`object-contain animate-warp-pulse ${className}`}
    />
  )
}
