#!/usr/bin/env node
// Empaqueta la app web como .ipk para LG webOS.
//   node scripts/build-webos.mjs           → build + staging
//   node scripts/build-webos.mjs --package → + genera dist-webos/OctoStream_<ver>.ipk
//
// Requiere el CLI de webOS OSE solo para --package:
//   npm i -g @webosose/ares-cli    (o npx -y @webosose/ares-cli package …)
// Instalación en la TV: modo desarrollador + ares-install --device tv <ipk>

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const STAGE = 'dist-webos/stage'
const OUT = 'dist-webos'

if (!existsSync('dist/index.html')) {
  console.log('dist/ no existe — ejecutando vite build…')
  execSync('npx vite build', { stdio: 'inherit' })
}

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
cpSync('dist', STAGE, { recursive: true })

const appinfo = JSON.parse(readFileSync('webos/appinfo.json', 'utf8'))
writeFileSync(`${STAGE}/appinfo.json`, JSON.stringify(appinfo, null, 2))
cpSync('webos/icon.png', `${STAGE}/icon.png`)
cpSync('webos/largeIcon.png', `${STAGE}/largeIcon.png`)
console.log(`staging listo en ${STAGE}`)

if (process.argv.includes('--package')) {
  mkdirSync(OUT, { recursive: true })
  const ipk = `com.octostream.app_${appinfo.version}_all.ipk`
  try {
    execSync(`npx -y -p @webosose/ares-cli ares-package "${STAGE}" -o "${OUT}" --no-minify`, { stdio: 'inherit' })
    console.log(`→ ${OUT}/${ipk}`)
  } catch {
    console.error('ares-package falló — instala el CLI: npm i -g @webosose/ares-cli')
    process.exit(1)
  }
} else {
  console.log('añade --package para generar el .ipk (requiere @webosose/ares-cli)')
}
