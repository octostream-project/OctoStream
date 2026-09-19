#!/usr/bin/env node
// Bumps versionCode/versionName in android/app/build.gradle and version.json,
// and fills apkUrl/sha256/notes for the updater manifest.
//
// Uso:
//   node scripts/bump-version.mjs <versionName> [apkPath] [apkUrl] [notes]
//   node scripts/bump-version.mjs 1.1 build/app-release.apk \
//     https://git.disroot.org/aka.kuro/OctoStream/releases/download/v1.1/octostream-1.1.apk \
//     "Novedades de la versión"
//
// Flujo de release:
//   1. node scripts/bump-version.mjs 1.1
//   2. npm run android:build:release   (genera android/app/build/outputs/apk/release/app-release.apk)
//   3. node scripts/bump-version.mjs 1.1 <apk> <url-del-release-en-disroot>
//   4. git commit + tag + push, y sube el APK a la release en Disroot

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [versionName, apkPath, apkUrl, ...notesParts] = process.argv.slice(2)
if (!versionName) {
  console.error('uso: node scripts/bump-version.mjs <versionName> [apkPath] [apkUrl] [notes]')
  process.exit(1)
}
const notes = notesParts.join(' ')

// versionCode = digits of versionName appended: "1.1" -> 11, "1.2.3" -> 123
const digits = versionName.replace(/\D/g, '')
const versionCode = Number(digits)
if (!versionCode) {
  console.error(`no puedo derivar versionCode de "${versionName}"`)
  process.exit(1)
}

const gradlePath = 'android/app/build.gradle'
if (existsSync(gradlePath)) {
  let g = readFileSync(gradlePath, 'utf8')
  g = g.replace(/versionCode\s*=?\s*\d+/, `versionCode = ${versionCode}`)
       .replace(/versionName\s*=?\s*"[^"]*"/, `versionName = "${versionName}"`)
  writeFileSync(gradlePath, g)
  console.log(`build.gradle → versionCode ${versionCode}, versionName "${versionName}"`)
} else {
  console.warn('android/app/build.gradle no existe (cap add android pendiente) — solo se actualiza version.json')
}

let sha256 = ''
if (apkPath && existsSync(apkPath)) {
  sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex')
} else if (apkPath) {
  console.warn(`apk no encontrado: ${apkPath} — sha256 queda vacío`)
}

const manifest = {
  versionCode,
  versionName,
  minCode: 0,
  apkUrl: apkUrl || '',
  sha256,
  notes,
}
writeFileSync('version.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('version.json →', manifest)
