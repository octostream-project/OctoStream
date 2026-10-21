// Auditoría en vivo de canales plurtasko — SOLO corre con CHANNEL_AUDIT=1
// (workflow semanal channel-audit.yml o `npm run audit:channels` en local).
// Reporta catálogo + búsqueda por canal sin fallar nunca: las webs rotan
// dominio constantemente y un fallo transitorio no debe romper CI.
// La salida queda en el log como tabla para revisar qué canales murieron.
import { describe, it } from 'vitest'
import { CHANNELS } from './index.js'

const RUN = process.env.CHANNEL_AUDIT === '1'
const QUERY = 'matrix'
const TIMEOUT_MS = 25000

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
])

async function probe(ch) {
  const out = { id: ch.id, name: ch.name, catalog: -1, search: -1, err: '' }
  try {
    const catId = ch.catalogs?.[0]?.id
    if (catId && ch.getCatalog) {
      const items = await withTimeout(ch.getCatalog({ id: catId, skip: 0, top: 10 }), TIMEOUT_MS)
      out.catalog = Array.isArray(items) ? items.length : 0
    }
  } catch (e) { out.err = `catalog: ${e?.message || e}` }
  try {
    if (ch.search) {
      const items = await withTimeout(
        ch.search({ query: QUERY, type: ch.types?.[0], originalName: '' }), TIMEOUT_MS)
      out.search = Array.isArray(items) ? items.length : 0
    }
  } catch (e) { out.err = `${out.err} search: ${e?.message || e}`.trim() }
  return out
}

describe.skipIf(!RUN)('auditoría en vivo de canales', () => {
  it('catálogo + búsqueda por canal', async () => {
    const results = await Promise.all(CHANNELS.map(ch =>
      probe(ch).catch(e => ({ id: ch.id, name: ch.name, catalog: -1, search: -1, err: String(e?.message || e) }))))

    console.log('\n===== AUDITORÍA DE CANALES =====')
    let ok = 0
    for (const r of results) {
      const alive = r.catalog > 0 || r.search > 0
      if (alive) ok++
      console.log(`${alive ? 'OK  ' : 'FAIL'} ${String(r.id).padEnd(24)} catalog=${r.catalog} search=${r.search}${r.err ? '  [' + r.err + ']' : ''}`)
    }
    console.log(`${ok}/${results.length} canales con contenido\n`)
  }, 5 * 60 * 1000)
})
