import { useEffect, useMemo, useRef, useState } from 'react'
import { PlaySquare, Film, Tv } from 'lucide-react'
import ContentCard from '../components/ContentCard.jsx'
import MediaGrid from '../components/ui/MediaGrid.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { SkeletonGrid } from '../components/ui/SkeletonCard.jsx'
import { waitForWarp } from '../utils/warpStatus.js'
import { useStore } from '../store/useStore.js'
import { isAllowedInProfile } from '../utils/profiles.js'
import {
  filterStreamingCatalogByGenre,
  getStreamingPlatformCatalogs,
  getStreamingPlatformCatalogContent,
  STREAMING_GENRES,
} from '../plugins/bundled/streamingCatalogs.js'

const HOME_PREFS_KEY = 'octostream_home_layout'
const readPrefs = () => {
  try { return JSON.parse(localStorage.getItem(HOME_PREFS_KEY) || '{}') || {} } catch { return {} }
}
const writePrefs = (prefs) => {
  try { localStorage.setItem(HOME_PREFS_KEY, JSON.stringify(prefs)) } catch { /* lleno */ }
}

// Plataforma de un catálogo: el nombre menos un sufijo de género conocido
// ("Netflix Comedia" → "Netflix"). Si no hay sufijo, el nombre entero.
const GENRE_NAMES = STREAMING_GENRES.map(g => g.name.toLowerCase())
function platformOf(catalog) {
  const name = String(catalog?.name || '').trim()
  const lower = name.toLowerCase()
  for (const g of GENRE_NAMES) {
    for (const suffix of [` ${g}`, ` - ${g}`, ` · ${g}`, `: ${g}`]) {
      if (lower.endsWith(suffix)) return name.slice(0, name.length - suffix.length).trim() || name
    }
  }
  return name
}
// Género implícito de un catálogo ("Netflix Comedia" → 'comedy') para
// etiquetar items que no traen genres en sus metadatos.
function impliedGenreOf(catalog) {
  const lower = String(catalog?.name || '').toLowerCase()
  const hit = STREAMING_GENRES.find(g => lower.endsWith(` ${g.name.toLowerCase()}`)
    || lower.endsWith(`- ${g.name.toLowerCase()}`))
  return hit?.name || null
}

// Sección propia para navegar los catálogos de plataformas (Netflix, HBO…).
// La selección se guarda en octostream_home_layout — la misma clave que usa
// Inicio → Personalizar, así activar aquí también crea las filas en Inicio.
export default function Platforms() {
  const profile = useStore(s => s.profiles.find(p => p.id === s.activeProfileId))
  const [prefs, setPrefs] = useState(readPrefs)
  const [catalogs, setCatalogs] = useState(null) // null = cargando
  const [error, setError] = useState('')
  const [items, setItems] = useState(null) // null = sin selección/cargando
  const [itemsLoading, setItemsLoading] = useState(false)
  const itemsReqRef = useRef(0)

  const page = prefs.platformPage || {}
  const type = page.type === 'series' ? 'series' : 'movie'
  const selectedPlatform = page.platform || null
  const selectedGenre = page.genre || null
  const savePrefs = (next) => { setPrefs(next); writePrefs(next) }
  const savePage = (patch) => savePrefs({ ...prefs, platformPage: { ...page, ...patch } })

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        await waitForWarp()
        const list = await getStreamingPlatformCatalogs()
        if (active) { setCatalogs(list); setError('') }
      } catch (e) {
        if (active) setError('No se pudieron cargar los catálogos de plataformas.')
        console.warn('[Platforms] manifest failed:', e?.message || e)
      }
    })()
    return () => { active = false }
  }, [])

  // Plataformas agrupadas del tipo activo (movie/series).
  const platforms = useMemo(() => {
    const map = new Map()
    for (const c of catalogs || []) {
      if (c.type !== type) continue
      const label = platformOf(c)
      if (!map.has(label)) map.set(label, [])
      map.get(label).push(c)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'))
  }, [catalogs, type])

  const enabledKeys = useMemo(() => new Set(prefs.platforms?.[type] || []), [prefs, type])
  const platformEnabled = (cats) => cats.some(c => enabledKeys.has(c.key))

  // Auto-seleccionar la primera plataforma habilitada si no hay selección.
  useEffect(() => {
    if (!platforms.length || selectedPlatform) return undefined
    const first = platforms.find(([, cats]) => platformEnabled(cats)) || platforms[0]
    queueMicrotask(() => savePage({ platform: first[0] }))
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platforms])

  const togglePlatform = (label, cats) => {
    const keys = new Set(prefs.platforms?.[type] || [])
    if (platformEnabled(cats)) cats.forEach(c => keys.delete(c.key))
    else cats.forEach(c => keys.add(c.key))
    savePrefs({ ...prefs, platforms: { ...(prefs.platforms || {}), [type]: [...keys] } })
  }

  const selectPlatform = (label) => savePage({ platform: label, genre: null })

  // Carga perezosa del contenido de la plataforma seleccionada.
  useEffect(() => {
    if (!selectedPlatform || !platforms.length) return undefined
    const entry = platforms.find(([label]) => label === selectedPlatform)
    if (!entry) return undefined
    const myReq = ++itemsReqRef.current
    const ctrl = new AbortController()
    queueMicrotask(() => { if (myReq === itemsReqRef.current) setItemsLoading(true) })
    ;(async () => {
      const lists = await Promise.allSettled(entry[1].map(c =>
        getStreamingPlatformCatalogContent(c, { limit: 96, signal: ctrl.signal })
          .then(list => list.map(item => ({
            ...item,
            genres: item.genres?.length ? item.genres
              : (impliedGenreOf(c) ? [impliedGenreOf(c)] : []),
          })))))
      if (myReq !== itemsReqRef.current) return
      const byId = new Map()
      for (const r of lists) {
        for (const item of r.status === 'fulfilled' ? r.value : []) {
          if (isAllowedInProfile(item, profile) && !byId.has(item.id)) byId.set(item.id, item)
        }
      }
      setItems([...byId.values()])
      setItemsLoading(false)
    })()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlatform, platforms, type])

  const visible = useMemo(() => {
    if (!items) return []
    return selectedGenre ? filterStreamingCatalogByGenre(items, selectedGenre) : items
  }, [items, selectedGenre])
  const genreChips = useMemo(() => STREAMING_GENRES
    .filter(g => (items || []).some(i => filterStreamingCatalogByGenre([i], g.id).length)), [items])

  return (
    <div className="p-4 lg:p-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-400">Catálogos por servicio</p>
        <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
          <PlaySquare className="text-primary-500" size={30} /> Plataformas
        </h1>
        <p className="text-xs text-dark-400 mt-1">
          Toca una plataforma para explorarla; el ✓ la activa también en Inicio → Personalizar.
        </p>
      </header>

      <div data-tv-row className="flex gap-2 mb-4">
        {[{ id: 'movie', name: 'Películas', icon: Film }, { id: 'series', name: 'Series', icon: Tv }].map(t => {
          const Icon = t.icon
          const active = type === t.id
          return (
            <button key={t.id} type="button" data-tv-card aria-pressed={active}
              onClick={() => savePage({ type: t.id, platform: null, genre: null })}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${active ? 'border-primary-500 bg-primary-600/25 text-white' : 'border-dark-700 bg-dark-800 text-dark-300 hover:text-white'}`}>
              <Icon size={16} /> {t.name}
            </button>
          )
        })}
      </div>

      {catalogs === null ? (
        <SkeletonGrid />
      ) : error ? (
        <EmptyState icon={PlaySquare}>{error}</EmptyState>
      ) : (
        <>
          <div data-tv-row className="flex gap-2 overflow-x-auto scrollbar-hide pb-2 mb-4" style={{ scrollbarWidth: 'none' }}>
            {platforms.map(([label, cats]) => {
              const enabled = platformEnabled(cats)
              const selected = selectedPlatform === label
              return (
                <span key={label} className={`inline-flex shrink-0 items-stretch overflow-hidden rounded-full border transition-colors ${selected ? 'border-primary-500 bg-primary-600/25' : 'border-dark-700 bg-dark-900'}`}>
                  <button type="button" data-tv-card aria-pressed={selected}
                    onClick={() => selectPlatform(label)}
                    className={`px-3 py-1.5 text-xs font-medium ${selected ? 'text-white' : 'text-dark-300 hover:text-white'}`}>
                    {label}
                  </button>
                  <button type="button" data-tv-card aria-pressed={enabled}
                    title={enabled ? 'Quitar de Inicio' : 'Activar en Inicio'}
                    onClick={() => togglePlatform(label, cats)}
                    className={`px-2 text-xs ${enabled ? 'text-emerald-400' : 'text-dark-500 hover:text-white'}`}>
                    {enabled ? '✓' : '+'}
                  </button>
                </span>
              )
            })}
          </div>

          {genreChips.length > 0 && (
            <div data-tv-row className="flex gap-2 overflow-x-auto scrollbar-hide pb-2 mb-4" style={{ scrollbarWidth: 'none' }}>
              {genreChips.map(g => {
                const active = selectedGenre === g.id
                return (
                  <button key={g.id} type="button" data-tv-card aria-pressed={active}
                    onClick={() => savePage({ genre: active ? null : g.id })}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'border-emerald-500 bg-emerald-600/20 text-white' : 'border-dark-700 bg-dark-900 text-dark-300 hover:text-white'}`}>
                    {g.name}
                  </button>
                )
              })}
            </div>
          )}

          {itemsLoading ? (
            <SkeletonGrid />
          ) : visible.length ? (
            <MediaGrid>
              {visible.map(item => <ContentCard key={`${item.type}-${item.id}`} item={item} />)}
            </MediaGrid>
          ) : (
            <EmptyState icon={PlaySquare}>
              {selectedGenre ? `Sin resultados de ${STREAMING_GENRES.find(g => g.id === selectedGenre)?.name} en ${selectedPlatform}` : 'No hay contenido disponible en esta plataforma'}
            </EmptyState>
          )}
        </>
      )}
    </div>
  )
}
