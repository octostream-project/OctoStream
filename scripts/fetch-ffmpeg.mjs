#!/usr/bin/env node
// Descarga los binarios estáticos de ffmpeg (eugeneware/ffmpeg-static) a
// build/ffmpeg/<platform>-<arch>/ — van como extraResources en el paquete
// Electron y el proxy /ffmpeg los usa para remultiplexar mkv/avi/ts → fMP4.
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = 'b6.1.1'
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}`
const OUT_DIR = path.join(ROOT, 'build', 'ffmpeg')

// Plataformas a empaquetar. Uso: node scripts/fetch-ffmpeg.mjs [all|linux|win32]
const TARGETS = {
  'linux-x64': 'ffmpeg-linux-x64.gz',
  'win32-x64': 'ffmpeg-win32-x64.gz',
  'linux-arm64': 'ffmpeg-linux-arm64.gz',
}

const filter = process.argv[2] || 'all'

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

for (const [plat, asset] of Object.entries(TARGETS)) {
  if (filter !== 'all' && !plat.startsWith(filter)) continue
  const isWin = plat.startsWith('win32')
  const dir = path.join(OUT_DIR, plat)
  const out = path.join(dir, isWin ? 'ffmpeg.exe' : 'ffmpeg')
  if (existsSync(out)) {
    console.log(`✓ ${plat} ya existe — se omite`)
    continue
  }
  mkdirSync(dir, { recursive: true })
  process.stdout.write(`↓ ${asset} …`)
  const gz = await fetchBuf(`${BASE}/${asset}`)
  const bin = gunzipSync(gz)
  writeFileSync(out, bin)
  if (!isWin) chmodSync(out, 0o755)
  console.log(` ${(bin.length / 1e6).toFixed(0)} MB → ${out}`)
}
console.log('ffmpeg listo en', OUT_DIR)
