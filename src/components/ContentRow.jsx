import { memo } from 'react'
import ContentCard from './ContentCard.jsx'

function ContentRow({ title, items }) {
  if (!items || items.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center mb-3 px-1">
        <h2 className="text-xl font-bold text-white">{title}</h2>
      </div>
      <div
        data-tv-row
        className="flex gap-4 overflow-x-auto scrollbar-hide pb-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {items.map(item => (
          <div key={`${item.type}-${item.id}`} className="content-card-slot flex-shrink-0 w-36 sm:w-40 md:w-44">
            <ContentCard item={item} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(ContentRow)
