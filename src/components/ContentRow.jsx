import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import ContentCard from './ContentCard.jsx'

export default function ContentRow({ title, items }) {
  const scrollRef = useRef(null)

  const scroll = (dir) => {
    if (scrollRef.current) {
      const amount = scrollRef.current.clientWidth * 0.8
      scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' })
    }
  }

  if (!items || items.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <div className="flex gap-1">
          <button onClick={() => scroll('left')} className="btn-ghost p-1.5">
            <ChevronLeft size={20} />
          </button>
          <button onClick={() => scroll('right')} className="btn-ghost p-1.5">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 scroll-smooth"
        style={{ scrollbarWidth: 'none' }}
      >
        {items.map(item => (
          <div key={`${item.type}-${item.id}`} className="flex-shrink-0 w-36 sm:w-40 md:w-44">
            <ContentCard item={item} />
          </div>
        ))}
      </div>
    </div>
  )
}
