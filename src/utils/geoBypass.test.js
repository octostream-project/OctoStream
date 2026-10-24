// Drift-test: la lista geo-bypass existe en tres runtimes (JS, Java,
// Electron main) que no pueden compartir import. Si alguien añade/quita
// un host en una copia y olvida las demás, este test lo pilla.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { GEO_BYPASS_HOSTS, isGeoBypassHost } from './geoBypass.js'

const root = join(fileURLToPath(import.meta.url), '..', '..', '..')
const JAVA = join(root, 'capacitor-plugins/cloud-proxy/android/src/main/java/com/octostream/cloudproxy/CloudProxyPlugin.java')
const ELECTRON = join(root, 'electron/main.cjs')

const esc = h => h.replace(/\./g, '\\.')
// En el fuente Java el regex es un string literal: los puntos escapados
// llevan doble backslash ("tdtspain\\.com").
const escJava = h => h.replace(/\./g, '\\\\.')

describe('geoBypass — lista canónica sin drift', () => {
  it('todos los hosts están en el regex Java GEO_HOST', () => {
    const src = readFileSync(JAVA, 'utf8')
    const geoBlock = src.slice(src.indexOf('GEO_HOST ='), src.indexOf('isGeoBypassHost(String url)'))
    for (const h of GEO_BYPASS_HOSTS) {
      expect(geoBlock, `falta ${h} en GEO_HOST de CloudProxyPlugin.java`).toContain(escJava(h))
    }
  })

  it('todos los hosts están en los bypass de Electron', () => {
    const src = readFileSync(ELECTRON, 'utf8')
    const aetherBlock = src.slice(0, src.indexOf('aetherState'))
    for (const h of GEO_BYPASS_HOSTS) {
      expect(aetherBlock, `falta ${h} en AETHER_BYPASS_* de main.cjs`).toContain(esc(h))
    }
  })

  it('isGeoBypassHost matchea host y subdominios', () => {
    expect(isGeoBypassHost('https://www.rtve.es/directo/la1')).toBe(true)
    expect(isGeoBypassHost('https://dai.google.com/ssai/x')).toBe(true)
    expect(isGeoBypassHost('https://evilrtve.es/x')).toBe(false)
    expect(isGeoBypassHost('https://google.com/x')).toBe(false)
    expect(isGeoBypassHost('not-a-url')).toBe(false)
  })
})
