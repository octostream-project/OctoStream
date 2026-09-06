import { useState, useRef, useEffect } from 'react'

export default function LazyImage({ src, alt, className, placeholder = null }) {
  const [loaded, setLoaded] = useState(false)
  const [inView, setInView] = useState(false)
  const imgRef = useRef(null)

  useEffect(() => {
    if (!imgRef.current || !src) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setInView(true)
            observer.disconnect()
          }
        })
      },
      { rootMargin: '200px' }
    )
    observer.observe(imgRef.current)
    return () => observer.disconnect()
  }, [src])

  return (
    <div ref={imgRef} className={`relative ${className}`}>
      {!loaded && (
        <div className="absolute inset-0 bg-dark-700 animate-pulse" />
      )}
      {inView ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'} ${className}`}
        />
      ) : (
        placeholder || <div className="w-full h-full bg-dark-700" />
      )}
    </div>
  )
}
