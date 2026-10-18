#!/usr/bin/env node
// Descarga mpv portable a build/mpv/<platform>-<arch>/ — va como
// extraResources en el paquete Electron y electron/mpv.cjs lo usa como
// reproductor nativo (paridad ExoPlayer) sin instalación del usuario.
//
// - Linux: pkgforge-dev/mpv-AppImage (build anylinux). NO se empaqueta la
//   AppImage (necesitaría libfuse2 en el usuario): se extrae con
//   --appimage-extract y se envía el árbol squashfs — `AppRun` es un
//   launcher sharun estático que resuelve libs relativas sin FUSE.
// - Windows: shinchiro/mpv-winbuild-cmake (los builds "oficiales" de
//   mpv.io). El .7z lleva mpv.exe auto-contenido (+mpv.com, d3dcompiler).
import { existsSync, mkdirSync, chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'build', 'mpv')

const LINUX_TAG = 'v0.41.0%402026-10-07_1791382432'
const LINUX_BASE = `https://github.com/pkgforge-dev/mpv-AppImage/releases/download/${LINUX_TAG}`
const WIN_TAG = '20261018'
const WIN_BASE = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${WIN_TAG}`

// sha256 calculados sobre los assets publicados (verificación de integridad).
const TARGETS = {
  'linux-x64': {
    asset: 'mpv-v0.41.0-anylinux-x86_64.AppImage',
    url: `${LINUX_BASE}/mpv-v0.41.0-anylinux-x86_64.AppImage`,
    sha256: '0b0dcd36ab761b266c96e382c527c668d7cd36a6ced1654ab068fdf92111d70b',
    kind: 'appimage',
  },
  // linux-arm64: la AppImage aarch64 no puede extraerse en un host x64
  // (--appimage-extract ejecuta el runtime ARM; su imagen no es squashfs
  // plano — no hay magic hsqs para unsquashfs). Se añadirá si algún día se
  // construyen paquetes linux-arm64; hoy solo salen x64.
  // 'linux-arm64': { asset: 'mpv-v0.41.0-anylinux-aarch64.AppImage', … }
  'win32-x64': {
    asset: 'mpv-x86_64-20261018-git-01e2533f31.7z',
    url: `${WIN_BASE}/mpv-x86_64-20261018-git-01e2533f31.7z`,
    sha256: 'd7157567a2fd88e46f739d2e8b8e6c02d2ad812db04547b45c59a2800821991f',
    kind: '7z',
    keep: ['mpv.exe', 'mpv.com', 'd3dcompiler_43.dll'],
  },
}

const filter = process.argv[2] || 'all'
// Marcador como hermano del árbol (fuera del dir) — dentro acabaría copiándose
// a resources/mpv/… en los paquetes.
const marker = (dir) => `${dir}.fetch-complete`

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function sevenz() {
  for (const c of ['7z', '7za', '7zz']) {
    try { execSync(`${c} i`, { stdio: 'pipe' }); return c } catch {}
  }
  try { execSync('bsdtar --version', { stdio: 'pipe' }); return 'bsdtar' } catch {}
  throw new Error('hace falta 7z/bsdtar para extraer el mpv de Windows')
}

for (const [plat, t] of Object.entries(TARGETS)) {
  if (filter !== 'all' && !plat.startsWith(filter)) continue
  const dir = path.join(OUT_DIR, plat)
  if (existsSync(marker(dir))) {
    console.log(`✓ ${plat} ya existe — se omite`)
    continue
  }
  mkdirSync(dir, { recursive: true })
  process.stdout.write(`↓ ${t.asset} …`)
  const buf = await fetchBuf(t.url)
  const digest = createHash('sha256').update(buf).digest('hex')
  if (digest !== t.sha256) {
    throw new Error(`sha256 mismatch en ${t.asset}: ${digest} != ${t.sha256} — posible descarga corrupta o supply-chain; abortado`)
  }
  console.log(` ${(buf.length / 1048576).toFixed(1)} MB sha256 OK`)

  const tmp = path.join(os.tmpdir(), `mpv-fetch-${plat}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const arc = path.join(tmp, t.asset)
    writeFileSync(arc, buf)
    if (t.kind === 'appimage') {
      // --appimage-extract NO necesita FUSE (lee la squashfs directamente).
      // OJO: pkgforge extrae a AppDir/ y deja "squashfs-root" como symlink
      // a ella — hay que copiar el directorio real, no el link.
      chmodSync(arc, 0o755)
      execSync(`"${arc}" --appimage-extract`, { cwd: tmp, stdio: 'pipe' })
      const root = existsSync(path.join(tmp, 'AppDir'))
        ? path.join(tmp, 'AppDir')
        : path.join(tmp, 'squashfs-root')
      rmSync(dir, { recursive: true, force: true })
      // verbatimSymlinks: los links internos (shared/lib → ../lib, confs
      // alsa) son relativos y deben conservarse para que sharun los siga.
      cpSync(root, dir, { recursive: true, verbatimSymlinks: true })
      chmodSync(path.join(dir, 'AppRun'), 0o755)
    } else {
      const z = sevenz()
      const xdir = path.join(tmp, 'x')
      mkdirSync(xdir)
      if (z === 'bsdtar') execSync(`bsdtar -xf "${arc}" -C "${xdir}"`, { stdio: 'pipe' })
      else execSync(`${z} x -y -o"${xdir}" "${arc}"`, { stdio: 'pipe' })
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      for (const f of t.keep) {
        const found = execSync(`find "${xdir}" -name "${f}" -type f | head -1`, { encoding: 'utf8' }).trim()
        if (!found) throw new Error(`${f} no encontrado en ${t.asset}`)
        cpSync(found, path.join(dir, f))
      }
    }
    writeFileSync(marker(dir), digest)
    console.log(`✓ ${plat} → ${path.relative(ROOT, dir)}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
