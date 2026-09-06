import { useEffect, useRef, useState } from 'react'

export default function TitleBanner({ title, subtitle, className = '' }) {
  const canvasRef = useRef(null)
  const [dataUrl, setDataUrl] = useState('')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !title) return
    const ctx = canvas.getContext('2d')
    const width = 1200
    const height = 300
    canvas.width = width
    canvas.height = height

    // Transparent background
    ctx.clearRect(0, 0, width, height)

    // Gradient glow behind text
    const gradient = ctx.createLinearGradient(0, height / 2, width, height / 2)
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0)')
    gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.15)')
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 80, width, 140)

    // Draw subtitle
    if (subtitle) {
      ctx.font = '600 24px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(139, 92, 246, 0.9)'
      ctx.fillText(subtitle.toUpperCase(), width / 2, 60)
    }

    // Draw title with stroke
    const maxFontSize = 110
    const minFontSize = 48
    let fontSize = maxFontSize
    ctx.font = `900 ${fontSize}px 'Bebas Neue', Impact, sans-serif`
    let textWidth = ctx.measureText(title).width
    while (textWidth > width - 80 && fontSize > minFontSize) {
      fontSize -= 4
      ctx.font = `900 ${fontSize}px 'Bebas Neue', Impact, sans-serif`
      textWidth = ctx.measureText(title).width
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const y = height / 2 + 20

    // Shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
    ctx.shadowBlur = 30
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 8

    // Stroke
    ctx.lineWidth = Math.max(3, fontSize / 25)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
    ctx.strokeText(title, width / 2, y)

    // Fill
    ctx.fillStyle = '#ffffff'
    ctx.fillText(title, width / 2, y)

    // Reset shadow
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0

    // Decorative line
    const lineY = y + fontSize / 2 + 20
    const lineWidth = Math.min(textWidth * 0.6, 300)
    const lineGrad = ctx.createLinearGradient(width / 2 - lineWidth / 2, lineY, width / 2 + lineWidth / 2, lineY)
    lineGrad.addColorStop(0, 'rgba(139, 92, 246, 0)')
    lineGrad.addColorStop(0.5, 'rgba(139, 92, 246, 1)')
    lineGrad.addColorStop(1, 'rgba(139, 92, 246, 0)')
    ctx.strokeStyle = lineGrad
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(width / 2 - lineWidth / 2, lineY)
    ctx.lineTo(width / 2 + lineWidth / 2, lineY)
    ctx.stroke()

    setDataUrl(canvas.toDataURL('image/png'))
  }, [title, subtitle])

  if (!title) return null

  return (
    <div className={`relative ${className}`}>
      <canvas ref={canvasRef} className="hidden" />
      {dataUrl && (
        <img
          src={dataUrl}
          alt={title}
          className="w-full max-w-4xl mx-auto h-auto object-contain drop-shadow-2xl"
          style={{ maxHeight: '28vh' }}
        />
      )}
    </div>
  )
}
