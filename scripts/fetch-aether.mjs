#!/usr/bin/env node
// Descarga los binarios de Aether (CluvexStudio/Aether — cliente WARP
// userspace) a build/aether/<platform>-<arch>/ — van como extraResources
// en el paquete Electron y electron/main.cjs los lanza cuando el usuario
// activa WARP (SOCKS5 :1819 + HTTP CONNECT :1820, igual que en Android).
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = 'v2.3.0'
const BASE = `https://github.com/CluvexStudio/Aether/releases/download/${TAG}`
const OUT_DIR = path.join(ROOT, 'build', 'aether')

// sha256 de SHA256SUMS.txt de la release (verificación de integridad).
const TARGETS = {
  'linux-x64': {
    asset: 'aether-linux-x86_64.tar.gz',
    sha256: '77c6ce41695a616660d834b55be235c17e7588a474dfd737b71ca80b685bdc8a',
    exe: 'aether',
  },
  'linux-arm64': {
    asset: 'aether-linux-arm64.tar.gz',
    sha256: '7251cbb90c4a0eccb62412727ebee9f0a7b775d20d26492c082ba5df64f8c21f',
    exe: 'aether',
  },
  'win32-x64': {
    asset: 'aether-windows-x86_64.zip',
    sha256: '0cc32dd2d7573f91d2e55d4f427bfe4c6f6252342494e1b410d61b12d1e4dc79',
    exe: 'aether.exe',
  },
}

const filter = process.argv[2] || 'all'

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

for (const [plat, t] of Object.entries(TARGETS)) {
  if (filter !== 'all' && !plat.startsWith(filter)) continue
  const dir = path.join(OUT_DIR, plat)
  const out = path.join(dir, t.exe)
  if (existsSync(out)) {
    console.log(`✓ ${plat} ya existe — se omite`)
    continue
  }
  mkdirSync(dir, { recursive: true })
  process.stdout.write(`↓ ${t.asset} …`)
  const buf = await fetchBuf(`${BASE}/${t.asset}`)
  const digest = createHash('sha256').update(buf).digest('hex')
  if (digest !== t.sha256) {
    throw new Error(`sha256 mismatch en ${t.asset}: ${digest} != ${t.sha256} — posible descarga corrupta o supply-chain; abortado`)
  }
  // Extraer el binario del tar.gz / zip a un temporal y moverlo.
  const tmp = path.join(os.tmpdir(), `aether-${plat}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const arc = path.join(tmp, t.asset)
  writeFileSync(arc, buf)
  try {
    if (t.asset.endsWith('.zip')) {
      execSync(`unzip -o -j "${arc}" -d "${tmp}/x"`, { stdio: 'pipe' })
    } else {
      execSync(`tar -xzf "${arc}" -C "${tmp}"`, { stdio: 'pipe' })
      // El tar puede tener subdirectorio; localizar el binario.
      execSync(`find "${tmp}" -name "${t.exe}" -type f -exec mv {} "${tmp}/x/" \\; -quit`, { stdio: 'pipe', shell: '/bin/bash' })
      mkdirSync(path.join(tmp, 'x'), { recursive: true })
    }
    // Buscar el ejecutable en lo extraído.
    const found = execSync(`find "${tmp}" -name "${t.exe}" -type f | head -1`, { encoding: 'utf8' }).trim()
    if (!found) throw new Error(`no se encontró ${t.exe} dentro de ${t.asset}`)
    writeFileSync(out, readFileSync(found)) // copy — /tmp puede ser otro FS
    chmodSync(out, 0o755)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(` OK → ${out}`)
}
console.log('aether listo en', OUT_DIR)
