// Lint gate con baseline: el repo arrastra errores legacy, así que el CI
// solo falla cuando aparecen (archivo, regla) NUEVOS respecto a
// lint-baseline.json. Así reglas como no-undef bloquean bugs reales
// (p.ej. la llamada a isTorboxEnabled() huérfana) sin reescribir media app.
//
//   node scripts/lint-check.mjs            → compara contra el baseline
//   node scripts/lint-check.mjs --update   → regenera el baseline (tras
//                                            limpiar errores a propósito)
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const BASELINE = 'lint-baseline.json'
const update = process.argv.includes('--update')

let report
try {
  report = execSync('npx eslint src -f json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (e) {
  // eslint sale !=0 cuando hay findings — el JSON va por stdout igual.
  report = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() || '')
}
let results
try { results = JSON.parse(report) } catch {
  console.error('[lint-check] eslint no devolvió JSON — ¿está instalado?')
  process.exit(1)
}

// Solo errores (severity 2): los warnings no bloquean.
const current = {}
for (const file of results) {
  const rules = new Set(
    file.messages.filter(m => m.severity === 2).map(m => m.ruleId || 'fatal')
  )
  if (rules.size) {
    const rel = file.filePath.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/')
    current[rel] = [...rules].sort()
  }
}

if (update) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n')
  const total = Object.values(current).reduce((n, r) => n + r.length, 0)
  console.log(`[lint-check] baseline regenerado: ${total} errores en ${Object.keys(current).length} archivos`)
  process.exit(0)
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
const nuevos = []
for (const [file, rules] of Object.entries(current)) {
  const known = new Set(baseline[file] || [])
  for (const r of rules) if (!known.has(r)) nuevos.push(`${file}: ${r}`)
}
const resueltos = []
for (const [file, rules] of Object.entries(baseline)) {
  const now = new Set(current[file] || [])
  for (const r of rules) if (!now.has(r)) resueltos.push(`${file}: ${r}`)
}

if (resueltos.length) {
  console.log(`[lint-check] ${resueltos.length} errores legacy resueltos — regenera con --update`)
}
if (nuevos.length) {
  console.error(`[lint-check] ${nuevos.length} errores de lint NUEVOS:`)
  nuevos.forEach(n => console.error(`  ${n}`))
  process.exit(1)
}
const total = Object.values(current).reduce((n, r) => n + r.length, 0)
console.log(`[lint-check] OK — ${total} errores legacy en baseline, 0 nuevos`)
