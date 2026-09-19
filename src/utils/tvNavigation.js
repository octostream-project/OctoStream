// Navegación D-pad para Android TV.
//
// Reglas:
// - Izquierda/derecha se mueven dentro de la fila visual actual. Al llegar al
//   borde bloquean, EXCEPTO en contenedores de varias líneas (filas con
//   flex-wrap, grids): ahí derecha pasa a la línea siguiente e izquierda a la
//   anterior, bloqueando solo en los extremos absolutos del contenedor.
// - Arriba/abajo saltan a la fila anterior/siguiente empezando por la
//   izquierda. Dentro de un contenedor multilínea mantienen la columna más
//   cercana. Arriba desde la primera fila va al BottomNav.
// - Los contenedores son elementos con [data-tv-row], [data-tv-grid],
//   [data-tv-list] o [data-tv-nav]. Se detectan sus líneas visuales por la
//   posición vertical real de los items (getBoundingClientRect).

let initialized = false
let currentFocus = null
let playerOpen = false
let mainObserver = null
let scrollListeners = []
let mainScrollEl = null
let mutationTimer = null
let currentLayer = 'content' // 'hero' | 'content' | 'nav'

const FOCUSABLE =
  '[data-tv-card], [data-tv-item], [data-tv-focus], button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const TV_CONTAINER = '[data-tv-row], [data-tv-grid], [data-tv-list]'

let cachedElements = []
let cachedRects = new Map()
let cacheTs = 0
// Elementos que rechazaron el foco en el último intento (disabled, inert,
// contenido no renderizado). Se limpia al refrescar la caché.
const unfocusable = new Set()
let lastKeyTime = 0
let lastNavTime = 0
let userNavigated = false
const KEY_THROTTLE = 40 // ms entre pulsaciones válidas
const NAV_GRACE = 800 // ms durante los cuales no se roba el foco tras navegación
const CACHE_TTL = 250 // ms
const MUTATION_DEBOUNCE = 120 // ms para agrupar ráfagas de mutaciones DOM
const ROW_TOLERANCE = 20 // px de tolerancia para considerar dos tops en la misma línea

// Rect sin la transformación de foco (scale). getBoundingClientRect incluye
// el scale(1.08) del foco y el scale(0.96) de los vecinos, que desplazan
// top/bottom hasta ~30px en tarjetas altas y separan la tarjeta enfocada de
// su fila visual (el foco quedaba atrapado oscilando entre los dos primeros
// items del grid). offsetWidth/offsetHeight devuelven el tamaño de layout
// sin transformar y el centro se conserva (transform-origin: 50% 50%).
function layoutRect(el) {
  const r = el.getBoundingClientRect()
  const w = el.offsetWidth || r.width
  const h = el.offsetHeight || r.height
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  return { top: cy - h / 2, left: cx - w / 2, width: w, height: h, right: cx + w / 2, bottom: cy + h / 2 }
}

function refreshCache() {
  const now = performance.now()
  if (now - cacheTs < CACHE_TTL && cachedElements.length) return
  const root = scope()
  if (!root) return
  unfocusable.clear()
  cachedElements = [...root.querySelectorAll(FOCUSABLE)].filter(el => el.isConnected)
  cachedRects = new Map()
  for (const el of cachedElements) {
    cachedRects.set(el, layoutRect(el))
  }
  cacheTs = now
}

function rect(el) {
  return cachedRects.get(el) || layoutRect(el)
}

function isVisible(el) {
  const r = rect(el)
  return r.width > 0 && r.height > 0
}

function getFocusables() {
  refreshCache()
  return cachedElements.filter(el => isVisible(el) && !unfocusable.has(el))
}

function getMainFocusables() {
  const main = document.querySelector('main')
  if (!main) return getFocusables()
  return [...main.querySelectorAll(FOCUSABLE)].filter(el => isVisible(el) && !unfocusable.has(el))
}

function scope() {
  if (playerOpen) return document.querySelector('[data-player-overlay]') || document.body
  // Los modales son una capa modal: nunca deben competir con el contenido
  // que queda detrás al mover el foco con el D-pad.
  return document.querySelector('[data-tv-modal]') || document.body
}

// ---------- 3D Depth Layers ----------
// Adds .tv-neighbor class to siblings of focused card for parallax effect.
// No negative translateZ on containers (causes clipping in Android WebView).
function updateDepthLayers(focusedEl) {
  document.querySelectorAll('.tv-neighbor').forEach(el => el.classList.remove('tv-neighbor'))

  if (!focusedEl) return

  const row = focusedEl.closest(TV_CONTAINER)
  if (row) {
    const siblings = row.querySelectorAll('[data-tv-card], [data-tv-item], [data-tv-focus]')
    siblings.forEach(el => {
      if (el !== focusedEl) el.classList.add('tv-neighbor')
    })
  }

  const hero = document.querySelector('[data-hero], .hero, [data-tv-hero]')
  const bottomNav = document.querySelector('[data-bottom-nav]')

  if (hero && hero.contains(focusedEl)) {
    currentLayer = 'hero'
  } else if (bottomNav && bottomNav.contains(focusedEl)) {
    currentLayer = 'nav'
  } else {
    currentLayer = 'content'
  }
}

function focus(el, scroll = true) {
  if (!el || !el.isConnected) return false

  if (scroll) {
    el.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })

    const main = document.querySelector('main')
    if (main) {
      const r = el.getBoundingClientRect()
      const c = main.getBoundingClientRect()
      if (r.bottom > c.bottom - 8) {
        main.scrollTop += r.bottom - c.bottom + 16
      } else if (r.top < c.top + 8) {
        main.scrollTop -= c.top - r.top + 16
      }
    }
  }

  el.focus({ preventScroll: true })
  // focus() es un no-op silencioso si el elemento no acepta foco ahora mismo
  // (disabled/inert). Devolver false permite reintentar con otro candidato.
  if (document.activeElement !== el) {
    unfocusable.add(el)
    return false
  }
  currentFocus = el
  updateDepthLayers(el)
  cacheTs = 0
  return true
}

function first(scopeEl) {
  const root = scopeEl || scope()
  if (!root) return
  const items = root === scope() ? getFocusables() : [...root.querySelectorAll(FOCUSABLE)].filter(isVisible)
  if (!items.length) return

  // Al cambiar de página, priorizar el contenido de <main> sobre el nav.
  // El BottomNav/TopNav solo recibe foco si el usuario navega hacia arriba.
  // [data-tv-initial] marca el elemento que debe recibir el foco primero
  // (p. ej. la primera pestaña de Ajustes, no una tarjeta del contenido).
  const mainItems = root === scope() ? getMainFocusables() : []
  const preferred = mainItems.find(el => el.matches('[data-tv-initial]')) ||
    mainItems.find(el => el.matches('[data-tv-card]')) ||
    mainItems.find(el => el.matches('[data-tv-item]')) ||
    mainItems.find(el => el.matches('[data-tv-focus]')) ||
    mainItems[0] ||
    items.find(el => el.matches('[data-tv-card]')) ||
    items[0]
  focus(preferred, false)
}

// ---------- Utilidades geométricas ----------

function centerX(r) { return r.left + r.width / 2 }

function closestByX(items, fromX) {
  let best = null
  let bestDist = Infinity
  for (const el of items) {
    const r = layoutRect(el)
    const d = Math.abs(centerX(r) - fromX)
    if (d < bestDist) { bestDist = d; best = el }
  }
  return best
}

function visibleFocusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => {
    if (unfocusable.has(el)) return false
    const r = layoutRect(el)
    return r.width > 0 && r.height > 0
  })
}

// Agrupa items en líneas visuales según su top real.
// Devuelve filas ordenadas de arriba a abajo; cada fila ordenada de izquierda
// a derecha.
function visualRows(items) {
  const rows = []
  for (const el of items) {
    const r = layoutRect(el)
    let row = null
    for (const candidate of rows) {
      if (Math.abs(candidate.top - r.top) <= ROW_TOLERANCE) { row = candidate; break }
    }
    if (!row) {
      row = { top: r.top, items: [] }
      rows.push(row)
    }
    row.items.push(el)
  }
  rows.sort((a, b) => a.top - b.top)
  for (const row of rows) {
    row.items.sort((a, b) => layoutRect(a).left - layoutRect(b).left)
  }
  return rows
}

// ---------- Navegación dentro de un contenedor ----------
// Devuelve un elemento, o null en el borde del contenedor:
// - null en izquierda/derecha significa "bloquear".
// - null en arriba/abajo significa "salir del contenedor".
function navigateInContainer(from, container, direction) {
  const rows = visualRows(visibleFocusablesIn(container))
  let rowIdx = -1
  let colIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const j = rows[i].items.indexOf(from)
    if (j >= 0) { rowIdx = i; colIdx = j; break }
  }
  if (rowIdx < 0) return null

  const row = rows[rowIdx]
  const multiLine = rows.length > 1
  // Solo envuelve entre líneas si el contenedor es realmente una malla
  // (alguna línea tiene más de un item). Una lista de una columna bloquea.
  const wraps = multiLine && rows.some(r => r.items.length > 1)

  if (direction === 'left') {
    if (colIdx > 0) return row.items[colIdx - 1]
    if (wraps && rowIdx > 0) {
      const prev = rows[rowIdx - 1].items
      return prev[prev.length - 1]
    }
    return null
  }
  if (direction === 'right') {
    if (colIdx < row.items.length - 1) return row.items[colIdx + 1]
    if (wraps && rowIdx < rows.length - 1) return rows[rowIdx + 1].items[0]
    return null
  }
  if (direction === 'up' && rowIdx > 0) {
    return closestByX(rows[rowIdx - 1].items, centerX(layoutRect(from)))
  }
  if (direction === 'down' && rowIdx < rows.length - 1) {
    return closestByX(rows[rowIdx + 1].items, centerX(layoutRect(from)))
  }
  return null
}

// Izquierda/derecha para elementos sueltos (sin contenedor): busca el más
// cercano en la misma línea visual. null = bloquear.
function horizontalSearch(from, items, fromRect, direction) {
  let best = null
  let bestDist = Infinity
  for (const el of items) {
    if (el === from) continue
    const r = layoutRect(el)
    if (Math.abs(r.top - fromRect.top) > Math.max(fromRect.height, r.height) * 0.75) continue
    const dx = direction === 'left' ? fromRect.left - r.right : r.left - fromRect.right
    if (dx < -4) continue
    if (dx < bestDist) { bestDist = dx; best = el }
  }
  return best
}

// Izquierda/derecha al salir de un contenedor de columna: el item más
// cercano en esa dirección priorizando proximidad vertical (el contenido
// vecino a la misma altura, no solo la misma fila exacta).
function horizontalLeave(from, items, fromRect, direction) {
  const fromY = fromRect.top + fromRect.height / 2
  let best = null
  let bestScore = Infinity
  for (const el of items) {
    if (el === from) continue
    const r = layoutRect(el)
    const dx = direction === 'left' ? fromRect.left - r.right : r.left - fromRect.right
    if (dx < -4) continue
    const dy = Math.abs((r.top + r.height / 2) - fromY)
    const score = Math.max(dx, 0) + dy * 2
    if (score < bestScore) { bestScore = score; best = el }
  }
  return best
}

// Un elemento puede estar en el pool aunque no acepte foco en este instante
// (disabled, inert o contenido saltado por content-visibility). focus() sobre
// él es un no-op silencioso y la navegación "se atasca" — se excluyen aquí.
function canTakeFocus(el) {
  return !el.disabled && !el.closest('[inert],[disabled]')
}

// Arriba/abajo al salir del contenedor o para elementos sueltos:
// busca la línea visual más cercana y devuelve su item de más a la izquierda.
// Arriba sin nada encima en main -> BottomNav.
function verticalLeave(from, items, fromRect, direction, bottomNav, main) {
  let best = null
  let bestDist = Infinity
  for (const el of items) {
    if (el === from || !canTakeFocus(el)) continue
    const r = layoutRect(el)
    const dy = direction === 'up' ? fromRect.top - r.bottom : r.top - fromRect.bottom
    if (dy < -4) continue
    if (dy < bestDist) { bestDist = dy; best = el }
  }

  if (best) {
    const br = layoutRect(best)
    // Dentro de la fila de destino, preferir el item más alineado con la
    // posición horizontal actual (no saltar al extremo izquierdo si el
    // usuario venía bajando por la derecha).
    const rowItems = []
    for (const el of items) {
      if (el === from || !canTakeFocus(el)) continue
      const r = layoutRect(el)
      // Misma fila visual que `best` = solapamiento vertical real.
      if (r.top >= br.bottom || r.bottom <= br.top) continue
      rowItems.push(el)
    }
    if (rowItems.length) return closestByX(rowItems, centerX(fromRect))
    return best
  }

  if (direction === 'up' && bottomNav) {
    const navItems = visibleFocusablesIn(bottomNav)
    if (navItems.length) {
      if (main) main.scrollTo({ top: 0, behavior: 'auto' })
      cacheTs = 0
      return closestByX(navItems, centerX(fromRect)) || navItems[0]
    }
  }
  return null
}

// ---------- Navegación principal ----------

function navigate(from, direction) {
  const bottomNav = document.querySelector('[data-bottom-nav]')
  const main = document.querySelector('main')
  const fromInNav = bottomNav && bottomNav.contains(from)
  const fromInMain = main && main.contains(from)

  if (fromInNav) {
    if (direction === 'left' || direction === 'right') {
      return navigateInContainer(from, bottomNav, direction)
    }
    if (direction === 'down' && main) {
      main.scrollTo({ top: 0, behavior: 'auto' })
      cacheTs = 0
      const rows = visualRows(visibleFocusablesIn(main))
      if (rows.length) return rows[0].items[0]
    }
    return null
  }

  if (fromInMain) {
    const items = visibleFocusablesIn(main)
    if (!items.length) return null
    const container = from.closest(TV_CONTAINER)
    const fromRect = layoutRect(from)

    if (direction === 'left' || direction === 'right') {
      if (container) {
        const next = navigateInContainer(from, container, direction)
        if (next) return next
        // Dentro de una región de columna (panel de contenido de Ajustes,
        // data-tv-col), izquierda/derecha en el borde de cualquier fila
        // interna sale a la región vecina (pestañas) en vez de bloquear.
        if (from.closest('[data-tv-col]')) {
          return horizontalSearch(from, items, fromRect, direction)
            || horizontalLeave(from, items, fromRect, direction)
        }
        // Contenedor apilado en vertical (p. ej. pestañas de Ajustes en
        // modo TV): la fila visual tiene 1 solo item, así que izquierda/
        // derecha no tiene nada dentro y debe salir al contenido vecino
        // en vez de bloquear.
        const rows = visualRows(visibleFocusablesIn(container))
        const curRow = rows.find(r => r.items.includes(from))
        if (curRow && curRow.items.length <= 1) {
          return horizontalSearch(from, items, fromRect, direction)
            || horizontalLeave(from, items, fromRect, direction)
        }
        // null aquí bloquea el movimiento (borde de la fila/contenedor)
        return null
      }
      // Elemento suelto: misma fila primero; si no hay nada, el más
      // cercano en esa dirección (p. ej. volver a la columna de pestañas
      // desde un ajuste que no comparte altura exacta con ninguna).
      return horizontalSearch(from, items, fromRect, direction)
        || horizontalLeave(from, items, fromRect, direction)
    }

    if (direction === 'up' || direction === 'down') {
      if (container) {
        const next = navigateInContainer(from, container, direction)
        if (next) return next
      }
      // En el panel de contenido de Ajustes (data-tv-col), arriba/abajo no
      // debe saltar a la barra lateral de pestañas aunque compartan la
      // misma altura visual — se excluyen del cálculo para que "abajo"
      // siga dentro de la columna hasta el final.
      const pool = from.closest('[data-tv-col]')
        ? items.filter(el => !el.closest('[data-tv-sidebar]'))
        : items
      const leave = verticalLeave(from, pool, fromRect, direction, bottomNav, main)
      if (leave) return leave
      // Abajo en el último item de la barra lateral (pestañas de Ajustes)
      // no tiene nada debajo: entrar al contenido de la derecha.
      if (direction === 'down' && from.closest('[data-tv-sidebar]')) {
        return horizontalLeave(from, items, fromRect, 'right')
      }
      return null
    }
  }

  return geometricFallback(from, direction)
}

// Fallback para elementos fuera de main/nav (overlays, etc.)
function geometricFallback(from, direction) {
  const items = getFocusables().filter(el => el !== from)
  if (!items.length) return null
  const fr = rect(from)
  const fx = centerX(fr)
  const fy = fr.top + fr.height / 2
  const horizontal = direction === 'left' || direction === 'right'

  let best = null
  let bestScore = Infinity
  for (const el of items) {
    const r = rect(el)
    const dx = centerX(r) - fx
    const dy = (r.top + r.height / 2) - fy
    const primary = horizontal ? dx : dy
    const cross = horizontal ? dy : dx
    const valid = direction === 'left' ? primary < -8
      : direction === 'right' ? primary > 8
      : direction === 'up' ? primary < -8
      : primary > 8
    if (!valid) continue
    const aligned = Math.abs(cross) <= (horizontal ? Math.max(fr.height, r.height) : Math.max(fr.width, r.width)) * 0.75
    const score = Math.abs(primary) + Math.abs(cross) * (aligned ? 2 : 8)
    if (score < bestScore) { bestScore = score; best = el }
  }
  return best
}

function nearest(direction) {
  const items = getFocusables()
  if (!items.length) return null
  const active = document.activeElement
  const from = (active && isVisible(active) && items.includes(active)) ? active : currentFocus
  if (!from || !items.includes(from)) {
    // Sin origen válido (nodo reemplazado, foco perdido): restaurar al
    // contenido, no al nav. Mismo criterio que first().
    const mainItems = getMainFocusables()
    return mainItems.find(el => el.matches('[data-tv-card]')) || mainItems[0] || items[0]
  }
  return navigate(from, direction)
}

// ---------- Inputs en modo TV ----------
// Al navegar con el D-pad los inputs de texto reciben foco readOnly para que el
// teclado virtual (y el autocompletado) no se abran al pasar por encima.
// El teclado se abre si el foco permanece INPUT_DELAY ms, al pulsar OK, o al
// tocar el input directamente. Al salir del input vuelve a readOnly.

const TEXT_INPUT =
  'input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="tel"], input[type="email"], input[type="password"], input[type="number"], textarea, [contenteditable="true"]'
const INPUT_DELAY = 3000 // ms de foco sostenido antes de abrir el teclado

let inputTimer = null
let reopeningInput = null // guard para el ciclo blur→focus al abrir el teclado
let pointerTarget = null

function isTextInput(el) {
  return !!el?.matches?.(TEXT_INPUT)
}

function isEditing(el) {
  return isTextInput(el) && el.dataset.tvEditing === '1'
}

function armInput(el) {
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null }
  if (!isTextInput(el) || el.disabled || isEditing(el)) return
  el.readOnly = true
  inputTimer = setTimeout(() => {
    inputTimer = null
    if (document.activeElement === el && el.isConnected) enableInputEditing(el)
  }, INPUT_DELAY)
}

function enableInputEditing(el) {
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null }
  if (!isTextInput(el) || el.disabled) return
  el.dataset.tvEditing = '1'
  el.readOnly = false
  // El IME solo se abre al ganar foco editable; como ya lo tenía, hacemos
  // blur→focus. reopeningInput evita que focusout/focusin desarmen el estado.
  reopeningInput = el
  el.blur()
  setTimeout(() => {
    if (el.isConnected) el.focus({ preventScroll: true })
    setTimeout(() => { if (reopeningInput === el) reopeningInput = null }, 60)
  }, 30)
}

function disarmInput(el) {
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null }
  if (isTextInput(el)) {
    delete el.dataset.tvEditing
    el.readOnly = true
  }
}

// ---------- Eventos ----------

const DIRECTIONS = {
  ArrowLeft: 'left', Left: 'left', DpadLeft: 'left', DPadLeft: 'left', DPAD_LEFT: 'left', NavigationLeft: 'left',
  ArrowRight: 'right', Right: 'right', DpadRight: 'right', DPadRight: 'right', DPAD_RIGHT: 'right', NavigationRight: 'right',
  ArrowUp: 'up', Up: 'up', DpadUp: 'up', DPadUp: 'up', DPAD_UP: 'up', NavigationUp: 'up',
  ArrowDown: 'down', Down: 'down', DpadDown: 'down', DPadDown: 'down', DPAD_DOWN: 'down', NavigationDown: 'down',
  37: 'left', 38: 'up', 39: 'right', 40: 'down',
  // Keycodes nativos de Android (KeyEvent): algunos WebView/ROM no traducen
  // el D-pad a Arrow*/key y solo rellenan keyCode.
  21: 'left', 19: 'up', 22: 'right', 20: 'down',
}

// DPAD_CENTER en el WebView de Android puede disparar dos `click` por
// pulsación: uno sobre el elemento enfocado y otro sobre el que recibe el
// foco tras la activación (p. ej. al abrir una vista nueva). Una pulsación
// real no puede producir dos clicks sobre elementos distintos — tragar el
// segundo click si aterriza en otro elemento inmediatamente después.
let lastClickTarget = null
let lastClickTime = 0

function onClickCapture(event) {
  const now = Date.now()
  const stray = lastClickTarget &&
    now - lastClickTime < 600 &&
    event.target !== lastClickTarget &&
    !lastClickTarget.contains?.(event.target) &&
    !event.target.contains?.(lastClickTarget)
  lastClickTarget = event.target
  lastClickTime = now
  if (stray) {
    event.preventDefault()
    event.stopPropagation()
  }
}

function onKeyDown(event) {
  if (playerOpen) return

  const target = event.target
  const modal = target?.closest?.('[data-tv-modal]')

  if (isTextInput(target)) {
    if (isEditing(target)) {
      // Modo edición (teclado abierto): Enter envía el formulario y sale de la
      // edición; las flechas salen de la edición y siguen navegando.
      if (event.key === 'Enter' || event.keyCode === 13) {
        // Deja que el submit nativo del formulario se ejecute primero y
        // después sale del modo edición (el foco puede seguir en el input).
        setTimeout(() => disarmInput(target), 0)
        return
      }
      const dir = DIRECTIONS[event.key] ?? DIRECTIONS[event.keyCode]
      if (dir) {
        disarmInput(target)
        target.blur()
        // continúa abajo → navegación normal
      } else {
        return // resto de teclas van al input
      }
    } else {
      // Modo navegación (readOnly): Enter/OK abre el teclado al instante;
      // el resto de teclas (flechas incluidas) navegan con normalidad.
      if (event.key === 'Enter' || event.keyCode === 13) {
        event.preventDefault()
        enableInputEditing(target)
        return
      }
    }
  } else if (target?.matches?.('input, select')) {
    return // checkboxes, selects, etc. conservan su comportamiento nativo
  }

  const direction = DIRECTIONS[event.key] ?? DIRECTIONS[event.keyCode]
  if (!direction) return

  const now = performance.now()
  if (now - lastKeyTime < KEY_THROTTLE) {
    event.preventDefault()
    return
  }
  lastKeyTime = now
  lastNavTime = now
  userNavigated = true
  event.preventDefault()

  // No invalidar el caché por tecla: layoutRect devuelve rects estables (el
  // scale del foco no los altera) y las mutaciones DOM/scroll ya invalidan.
  // Recalcular rect de todos los focusables en cada pulsación era el mayor
  // coste por tecla en páginas densas (EPG, listas de episodios).

  // Si el candidato elegido rechaza el foco (disabled/inert tras refresco de
  // caché), focus() lo marca en `unfocusable` y devolvemos a intentar con el
  // siguiente candidato en vez de quedarnos atascados.
  let next = nearest(direction)
  let attempts = 0
  while (next && attempts < 4) {
    if (focus(next)) break
    attempts++
    next = nearest(direction)
  }
  if (!next) {
    // Dentro de un modal sin más focusables en esa dirección, desplazar el
    // propio contenido del modal (no la pantalla que queda detrás).
    if (modal && (direction === 'up' || direction === 'down')) {
      scrollModal(modal, direction)
    } else {
      scrollMain(direction)
    }
  }
}

function scrollModal(modal, direction) {
  // El scrollable real suele ser un hijo con overflow-y-auto (data-tv-modal
  // es el overlay). Buscar el primer descendiente que desborda.
  let scroller = null
  for (const el of modal.querySelectorAll('*')) {
    const s = getComputedStyle(el)
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      scroller = el
      break
    }
  }
  (scroller || modal).scrollBy({
    top: direction === 'up' ? -260 : 260,
    behavior: 'smooth',
  })
}

function scrollMain(direction) {
  const main = document.querySelector('main')
  if (!main || (direction !== 'up' && direction !== 'down')) return
  const amount = 300
  main.scrollTo({
    top: main.scrollTop + (direction === 'down' ? amount : -amount),
    behavior: 'smooth'
  })
  cacheTs = 0
}

function onKeyUp() {
  cacheTs = 0
}

function onScroll() {
  cacheTs = 0
}

function onFocusIn(event) {
  const el = event.target
  if (el.matches?.(FOCUSABLE)) currentFocus = el
  if (isTextInput(el)) {
    if (el === reopeningInput) return // focus sintético de enableInputEditing
    if (el === pointerTarget) {
      // Toque/click directo sobre el input → edición inmediata
      pointerTarget = null
      el.dataset.tvEditing = '1'
      el.readOnly = false
    } else {
      armInput(el)
    }
  }
}

function onFocusOut(event) {
  const el = event.target
  if (el === reopeningInput) return // blur sintético de enableInputEditing
  if (isTextInput(el)) disarmInput(el)
}

function onPointerDown(event) {
  lastClickTarget = null // un pointerdown real invalida el par previo
  pointerTarget = isTextInput(event.target) ? event.target : null
}

function onMainMutation() {
  if (playerOpen) return
  cacheTs = 0
  if (mutationTimer) clearTimeout(mutationTimer)
  mutationTimer = setTimeout(() => {
    mutationTimer = null
    if (playerOpen) return
    const active = document.activeElement
    const now = performance.now()
    if (active && active.matches?.(FOCUSABLE) && isVisible(active) && now - lastNavTime < NAV_GRACE) return
    // Si el foco está fuera de <main> (p.ej. en el nav porque el contenido
    // aún no había cargado) y el usuario aún no ha navegado, moverlo al
    // contenido en cuanto aparezca.
    const main = document.querySelector('main')
    const focusOutsideMain = currentFocus && main && !main.contains(currentFocus)
    // isConnected es live: un nodo reemplazado por React ya no cuenta como
    // foco válido aunque siga en cachedElements.
    const stillValid = currentFocus?.isConnected && currentFocus.matches?.(FOCUSABLE) && isVisible(currentFocus)
    if (!stillValid || (focusOutsideMain && !userNavigated)) {
      first()
    }
  }, MUTATION_DEBOUNCE)
}

export function initTvNavigation() {
  if (initialized) return
  initialized = true
  document.documentElement.classList.add('tv-mode')
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('click', onClickCapture, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('pointerdown', onPointerDown, true)

  // Listener de scroll a nivel documento con capture: el evento scroll no
  // hace bubble pero sí captura — así se invalidan los rects cacheados al
  // hacer scroll en CUALQUIER contenedor (main, grids EPG horizontales,
  // listas de sugerencias, etc.). Sin esto, el scroll horizontal del EPG
  // dejaba rects obsoletos y no se podía navegar más a la derecha.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  scrollListeners.push(() => document.removeEventListener('scroll', onScroll, { capture: true }))

  const attachMain = () => {
    mainScrollEl = document.querySelector('main')
    if (mainScrollEl) {
      mainObserver = new MutationObserver(onMainMutation)
      mainObserver.observe(mainScrollEl, { childList: true, subtree: true })
    }
  }
  attachMain()
  if (!mainScrollEl) {
    // Una página lazy puede tardar más de 300ms en montar <main>; un solo
    // reintento dejaba el observer muerto para toda la sesión (sin refoco
    // automático al cargar contenido).
    let tries = 0
    const retry = () => {
      attachMain()
      if (!mainScrollEl && ++tries < 20) setTimeout(retry, 300)
    }
    setTimeout(retry, 300)
  }

  setTimeout(first, 250)
}

export function destroyTvNavigation() {
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('keyup', onKeyUp, true)
  document.removeEventListener('click', onClickCapture, true)
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('focusout', onFocusOut, true)
  document.removeEventListener('pointerdown', onPointerDown, true)
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null }
  for (const remove of scrollListeners) remove()
  scrollListeners = []
  mainObserver?.disconnect()
  mainObserver = null
  if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null }
  mainScrollEl = null
  refocusGeneration++
  initialized = false
}

let refocusGeneration = 0

export function refocusAfterPageChange() {
  currentFocus = null
  userNavigated = false
  cacheTs = 0
  // Token de generación: si la ruta vuelve a cambiar antes de que la cadena
  // de reintentos termine, los timeouts de la ruta anterior se descartan.
  const gen = ++refocusGeneration
  // El contenido de la página puede ser lazy-loaded (React.lazy + Suspense).
  // Reintentamos con backoff hasta que <main> tenga focusables.
  let attempts = 0
  const tryFocus = () => {
    if (gen !== refocusGeneration) return
    attempts++
    const main = document.querySelector('main')
    const mainItems = main ? [...main.querySelectorAll(FOCUSABLE)].filter(isVisible) : []
    if (mainItems.length > 0) {
      first()
    } else if (attempts < 8) {
      // Reintentar: 150, 300, 450, 600, 750, 900, 1050, 1200 ms
      setTimeout(tryFocus, 150)
    }
  }
  setTimeout(tryFocus, 150)
}

export function setPlayerOpen(open) {
  playerOpen = open
  cacheTs = 0
  if (!open) setTimeout(first, 100)
}

// Timestamp del último cierre del player nativo (ExoPlayer). Lo usa App.jsx
// para ignorar el backButton "leaked" que llega justo después de cerrar el
// Dialog nativo con Back.
let playerClosedAt = 0
export function markPlayerClosed() { playerClosedAt = Date.now() }
export function getPlayerClosedAt() { return playerClosedAt }

export function isPlayerOpen() {
  return playerOpen
}
