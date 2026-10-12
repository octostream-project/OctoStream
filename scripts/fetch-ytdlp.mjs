#!/usr/bin/env node
// Descarga yt-dlp standalone (extractor de YouTube — equivalente desktop de
// NewPipeExtractor en Android) a build/ytdlp/<platform>-<arch>/ → va como
// extraResources y electron/youtube.cjs lo usa para search/resolve/channel.
// Verifica integridad con SHA2-256SUMS de la propia release.
//
// Además instala el plugin yt-dlp-invidious junto a cada binario
// (yt-dlp-plugins/invidious/): yt-dlp lo autodescarga y añade fallback a
// instancias Invidious cuando YouTube responde con el error de bot-check
// ("Sign in to confirm you're not a bot") — frecuente desde IPs de
// datacenter/VPS. No hay releases del plugin → se fija un commit y se
// verifican los sha256 de los archivos .py extraídos.
import { writeFileSync, existsSync, mkdirSync, chmodSync, cpSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'build', 'ytdlp')

const TARGETS = {
  'linux-x64': { asset: 'yt-dlp_linux', exe: 'yt-dlp' },
  'linux-arm64': { asset: 'yt-dlp_linux_aarch64', exe: 'yt-dlp' },
  'win32-x64': { asset: 'yt-dlp.exe', exe: 'yt-dlp.exe' },
}

const INVIDIOUS_COMMIT = '0b44ada58c8c30c8064fae670b299de075a9f8e3' // 0.1.0
const INVIDIOUS_SHA256 = {
  'extractor/invidious.py': '8279a49cae684ff16299d8af427d6cf3594237a3b466b8e95de2f341b6b15406',
  'extractor/youtube_override.py': '500d05008b1075ad60b911083e9d01081bf9d9f0ea68bbb06a52e6f7ce879f88',
}

const filter = process.argv[2] || 'all'

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// Última release — YouTube rompe extractores a menudo; conviene la más nueva.
const rel = await (await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json()
const tag = rel.tag_name
console.log('yt-dlp', tag)
const sums = (await fetchBuf(`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`)).toString()

// Plugin invidious: tarball del commit fijado → extraer yt_dlp_plugins/.
const tmp = path.join(tmpdir(), `yt-dlp-invidious-${INVIDIOUS_COMMIT}`)
if (!existsSync(tmp)) {
  mkdirSync(tmp, { recursive: true })
  const tgz = await fetchBuf(`https://github.com/ryneeverett/yt-dlp-invidious/archive/${INVIDIOUS_COMMIT}.tar.gz`)
  writeFileSync(path.join(tmp, 'src.tar.gz'), tgz)
  execSync(`tar xzf src.tar.gz --strip-components=1 -C ${JSON.stringify(tmp)}`)
  rmSync(path.join(tmp, 'src.tar.gz'))
  // Verificar contenido extraído (los sha del .py son estables aunque GitHub
  // regenere el tarball con metadatos distintos).
  for (const [relPath, expected] of Object.entries(INVIDIOUS_SHA256)) {
    const f = path.join(tmp, 'yt_dlp_plugins', relPath)
    if (!existsSync(f) || sha256(readFileSync(f)) !== expected) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`sha256 mismatch en yt-dlp-invidious ${relPath} — abortado`)
    }
  }
  console.log('yt-dlp-invidious', INVIDIOUS_COMMIT.slice(0, 8), 'verificado')
}

for (const [plat, t] of Object.entries(TARGETS)) {
  if (filter !== 'all' && !plat.startsWith(filter)) continue
  const dir = path.join(OUT_DIR, plat)
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, t.exe)
  if (!existsSync(out)) {
    const expected = sums.match(new RegExp(`^([0-9a-f]{64})\\s+${t.asset}$`, 'm'))?.[1]
    if (!expected) throw new Error(`${t.asset} no aparece en SHA2-256SUMS`)
    process.stdout.write(`↓ ${t.asset} …`)
    const buf = await fetchBuf(`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${t.asset}`)
    if (sha256(buf) !== expected) {
      throw new Error(`sha256 mismatch en ${t.asset} — abortado`)
    }
    writeFileSync(out, buf)
    chmodSync(out, 0o755)
    console.log(` ${(buf.length / 1e6).toFixed(0)} MB → ${out}`)
  } else {
    console.log(`✓ ${plat} ya existe — se omite`)
  }
  // Plugin junto al ejecutable: yt-dlp autodescarga <exe-dir>/yt-dlp-plugins/.
  const plugDest = path.join(dir, 'yt-dlp-plugins', 'invidious')
  if (!existsSync(path.join(plugDest, 'yt_dlp_plugins'))) {
    rmSync(plugDest, { recursive: true, force: true })
    cpSync(path.join(tmp, 'yt_dlp_plugins'), path.join(plugDest, 'yt_dlp_plugins'), { recursive: true })
    console.log(`  + yt-dlp-plugins/invidious → ${plat}`)
  }
}
console.log('yt-dlp listo en', OUT_DIR)
