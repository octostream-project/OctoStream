#!/usr/bin/env node
// Post-build: rebaja el CSS de dist/ a WebViews antiguos (Chrome 66 = Android 9
// TVs). Tailwind 4 genera @layer/color-mix/@property/propiedades lógicas que
// los WebViews viejos descartan enteros → UI sin estilos o mal dimensionada.
//  - lightningcss baja lo computable (oklch→hex, color-mix estático→hex…)
//  - unwrapLayers quita los @layer{} (navegador viejo ignora el bloque entero)
//  - legacyCompat resuelve lo que lightningcss no baja: propiedades lógicas
//    (padding-inline…), :is()/:where(), color-mix con var(), transform
//    individual (translate/rotate/scale), gap en flex, inset.
// Se engancha al script "build"; los scripts android:* llaman a npm run build.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { transform, browserslistToTargets } from 'lightningcss'

const targets = browserslistToTargets(['chrome 66', 'ios_saf 12'])

// Quita "@layer a, b;" (declaración de orden) y desenvuelve "@layer x { … }"
// manteniendo el contenido en orden de aparición (= orden de cascada de
// Tailwind: theme → base → components → utilities → properties).
function unwrapLayers(css) {
  css = css.replace(/@layer[^{};]+;/g, '')
  let out = '', i = 0
  while (i < css.length) {
    const m = css.slice(i).match(/@layer[^{]*\{/)
    if (!m) { out += css.slice(i); break }
    const start = i + m.index
    out += css.slice(i, start)
    let depth = 0, j = start + m[0].length - 1
    const open = j
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') { depth--; if (!depth) break }
    }
    out += css.slice(open + 1, j) // interior del layer, sin el wrapper
    i = j + 1
  }
  return out
}

// ─── Legacy compat ──────────────────────────────────────────────────────────

// Extrae los --color-* hex de los :root (lightningcss emite primero el
// fallback hex y luego lab(); nos quedamos con el hex) para resolver
// color-mix(in <sp>, var(--color-x) P%, transparent) → rgba().
function collectRootColors(css) {
  const colors = {}
  for (const m of css.matchAll(/:root\{([^{}]*)\}/g)) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      colors[d[1]] = d[2]
    }
  }
  return colors
}

function hexToRgb(hex) {
  const h = hex.length === 4
    ? hex.slice(1).split('').map(c => c + c).join('')
    : hex.slice(1, 7)
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// color-mix(in <space>, <color> P%, transparent) → rgba(r,g,b,a). Solo
// resolvemos el patrón transparente típico de Tailwind (bg-black/50 etc.);
// el resto se queda como está (los navegadores nuevos lo calculan).
function resolveColorMix(decl, colors) {
  return decl.replace(
    /color-mix\(in\s+[\w-]+,\s*(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\))\s+([\d.]+)%\s*,\s*transparent\s*\)/g,
    (all, color, pct) => {
      let hex = color.startsWith('#') ? color : colors[color.slice(4, -1)]
      if (!hex) return all
      const [r, g, b] = hexToRgb(hex)
      return `rgba(${r},${g},${b},${(parseFloat(pct) / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')})`
    })
}

// Propiedades lógicas → físicas (la UI es LTR). Se emiten ANTES de la
// declaración original: en navegadores nuevos la lógica la sobreescribe.
const LOGICAL_MAP = [
  [/^padding-inline$/, v => `padding-left:${v};padding-right:${v}`],
  [/^padding-block$/, v => `padding-top:${v};padding-bottom:${v}`],
  [/^padding-inline-start$/, v => `padding-left:${v}`],
  [/^padding-inline-end$/, v => `padding-right:${v}`],
  [/^padding-block-start$/, v => `padding-top:${v}`],
  [/^padding-block-end$/, v => `padding-bottom:${v}`],
  [/^margin-inline$/, v => `margin-left:${v};margin-right:${v}`],
  [/^margin-block$/, v => `margin-top:${v};margin-bottom:${v}`],
  [/^margin-inline-start$/, v => `margin-left:${v}`],
  [/^margin-inline-end$/, v => `margin-right:${v}`],
  [/^margin-block-start$/, v => `margin-top:${v}`],
  [/^margin-block-end$/, v => `margin-bottom:${v}`],
  [/^inset$/, v => `top:${v};right:${v};bottom:${v};left:${v}`],
  [/^inset-inline$/, v => `left:${v};right:${v}`],
  [/^inset-block$/, v => `top:${v};bottom:${v}`],
  [/^inset-inline-start$/, v => `left:${v}`],
  [/^inset-inline-end$/, v => `right:${v}`],
  [/^inset-block-start$/, v => `top:${v}`],
  [/^inset-block-end$/, v => `bottom:${v}`],
  [/^border-inline$/, v => `border-left:${v};border-right:${v}`],
  [/^border-block$/, v => `border-top:${v};border-bottom:${v}`],
  [/^border-inline-start$/, v => `border-left:${v}`],
  [/^border-inline-end$/, v => `border-right:${v}`],
  [/^border-start-start-radius$/, v => `border-top-left-radius:${v}`],
  [/^border-start-end-radius$/, v => `border-top-right-radius:${v}`],
  [/^border-end-start-radius$/, v => `border-bottom-left-radius:${v}`],
  [/^border-end-end-radius$/, v => `border-bottom-right-radius:${v}`],
]

// divide "prop:valor" respetando paréntesis (var(), calc())
function splitDecls(body) {
  const decls = []
  let depth = 0, cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { decls.push(cur); cur = '' }
    else cur += ch
  }
  if (cur.trim()) decls.push(cur)
  return decls
}

// Expande :where()/​:is() en selectores: Chrome 66 no los conoce y descarta
// la regla entera. Producto cartesiano sobre las alternativas, con límite.
function expandSelector(sel, limit = 32) {
  const m = sel.match(/:(where|is)\(/)
  if (!m) return [sel]
  const open = m.index + m[0].length - 1
  let depth = 0, close = -1
  for (let i = open; i < sel.length; i++) {
    if (sel[i] === '(') depth++
    else if (sel[i] === ')') { depth--; if (!depth) { close = i; break } }
  }
  if (close < 0) return [sel]
  // split top-level commas inside the pseudo args
  const inner = sel.slice(open + 1, close)
  const args = []
  depth = 0; let cur = ''
  for (const ch of inner) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { args.push(cur); cur = '' }
    else cur += ch
  }
  args.push(cur)
  const out = []
  for (const a of args) {
    for (const rest of expandSelector(sel.slice(0, m.index) + a + sel.slice(close + 1), limit)) {
      out.push(rest)
      if (out.length >= limit) return out
    }
  }
  return out
}

// Procesa un bloque de declaraciones: logical props, color-mix, transform.
// Devuelve { body, extraRules } — extraRules son selectores derivados
// (fallback de gap en flex envuelto en @supports).
function compatDecls(sel, body, colors, extraRules) {
  const decls = splitDecls(body)
  const hasTransform = decls.some(d => /^\s*transform\s*:/.test(d))
  const hasGap = decls.find(d => /^\s*gap\s*:/.test(d))
  const isFlex = decls.some(d => /display\s*:\s*flex/.test(d))
  const isGrid = decls.some(d => /display\s*:\s*grid/.test(d))
  const isCol = decls.some(d => /flex-direction\s*:\s*column/.test(d))

  // Fallback de gap: Chrome 66 soporta row-gap/column-gap solo en grid; en
  // flex no hay propiedad → márgenes en hijos, todo bajo @supports not (gap).
  // Los selectores responsive (.sm\:gap-4) viven dentro de @media — sus
  // reglas extra quedarían fuera del media → se ignoran.
  const isResponsive = sel.includes('\\:')
  if (hasGap && !isResponsive) {
    const gapVal = hasGap.split(':').slice(1).join(':').trim()
    const imp = /!important/.test(gapVal) ? ' !important' : ''
    if (isGrid) {
      extraRules.push(`${sel}{row-gap:${gapVal}${imp};column-gap:${gapVal}${imp}}`)
    }
    if (isFlex) {
      const prop = isCol ? 'margin-top' : 'margin-left'
      extraRules.push(`${sel}>*+*{${prop}:${gapVal}${imp}}`)
    }
    // Utility suelta .gap-N/.gap-x-N/.gap-y-N sin display en la misma regla:
    // emitir variantes para contenedor flex (row/col) y grid.
    const um = sel.match(/^\.(gap(?:-[xy])?-[\w.]+)$/)
    if (!isFlex && !isGrid && um) {
      const u = um[1]
      if (u.startsWith('gap-x-')) {
        extraRules.push(`.flex.${u}>*+*{margin-left:${gapVal}}`, `.grid.${u}{column-gap:${gapVal}}`)
      } else if (u.startsWith('gap-y-')) {
        extraRules.push(`.flex.${u}>*+*{margin-top:${gapVal}}`, `.grid.${u}{row-gap:${gapVal}}`)
      } else {
        extraRules.push(
          `.flex.${u}>*+*{margin-left:${gapVal}}`,
          `.flex.flex-col.${u}>*+*{margin-left:0;margin-top:${gapVal}}`,
          `.grid.${u}{row-gap:${gapVal};column-gap:${gapVal}}`,
        )
      }
    }
  }

  const tfParts = []
  const out = []
  for (const raw of decls) {
    const pm = raw.match(/^\s*([\w-]+)\s*:\s*(.*)$/)
    if (!pm) { out.push(raw); continue }
    const [, prop, val] = pm
    if (!hasTransform && (prop === 'translate' || prop === 'rotate' || prop === 'scale')) {
      // Props individuales de transform (Chrome 104+) → transform combinado.
      if (prop === 'translate') {
        const [x, y = '0'] = val.replace(/!important/, '').trim().split(/\s+/)
        tfParts.push(`translate(${x},${y})`)
      } else if (prop === 'rotate') {
        tfParts.push(`rotate(${val.replace(/!important/, '').trim()})`)
      } else {
        const v = val.replace(/!important/, '').trim()
        tfParts.push(`scale(${v.split(/\s+/).join(',')})`)
      }
      continue
    }
    const logi = LOGICAL_MAP.find(([re]) => re.test(prop))
    if (logi) {
      out.push(logi[1](val))
      out.push(raw) // la original queda como override en navegadores nuevos
      continue
    }
    const resolved = resolveColorMix(raw, colors)
    out.push(resolved === raw ? raw : `${resolved};${raw}`)
  }
  if (tfParts.length) out.unshift(`transform:${tfParts.join(' ')}`)
  return out.filter(s => s && String(s).trim()).join(';')
}

function compatCss(css) {
  const colors = collectRootColors(css)
  const extraRules = []
  // Reglas internas sin llaves anidadas (el CSS minificado de Tailwind las
  // anida solo dentro de @media/@supports — se procesan igual por regex).
  const result = css.replace(/([^{}@]+)\{([^{}]*)\}/g, (all, sel, body) => {
    const selectors = sel.split(',').flatMap(s => expandSelector(s.trim())).join(',')
    return `${selectors}{${compatDecls(selectors, body, colors, extraRules)}}`
  })
  return result + (extraRules.length ? `@supports not (gap:1rem){${extraRules.join('')}}` : '')
}

let touched = 0
for (const f of readdirSync('dist/assets')) {
  if (!f.endsWith('.css')) continue
  const path = `dist/assets/${f}`
  const { code } = transform({
    filename: f,
    code: readFileSync(path),
    minify: true,
    targets,
    errorRecovery: true,
  })
  writeFileSync(path, compatCss(unwrapLayers(code.toString())))
  touched++
}
console.log(`[compat-css] ${touched} archivo(s) procesados`)
