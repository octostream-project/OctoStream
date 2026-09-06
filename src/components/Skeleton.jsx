export default function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} />
}

export function CardSkeleton() {
  return (
    <div className="bg-dark-800/80 backdrop-blur-sm rounded-xl overflow-hidden shadow-lg">
      <div className="skeleton aspect-[2/3] w-full" />
      <div className="p-3 space-y-2">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  )
}

export function RowSkeleton({ count = 6 }) {
  return (
    <div className="mb-8">
      <div className="skeleton h-7 w-48 mb-3" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex-shrink-0 w-36 sm:w-40 md:w-44">
            <CardSkeleton />
          </div>
        ))}
      </div>
    </div>
  )
}
