#!/usr/bin/env node
// Post-build: rebaja el CSS de dist/ a WebViews antiguos (Chrome 66 = Android 9
// TVs). Tailwind 4 genera @layer/color-mix/@property que los WebViews viejos
// descartan enteros → UI sin estilos.
//  - lightningcss baja lo computable (color-mix estático → fallback hex…)
//  - unwrapLayers quita los @layer{} (navegador viejo ignora el bloque entero)
//    respetando el orden de capas que ya viene en el output de Tailwind.
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
  writeFileSync(path, unwrapLayers(code.toString()))
  touched++
}
console.log(`compat-css: ${touched} css transformados (chrome 66)`)
