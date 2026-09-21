#!/usr/bin/env node
// Bumps versionCode/versionName in android/app/build.gradle and version.json,
// and fills apkUrl/sha256/notes for the updater manifest.
//
// Uso:
//   node scripts/bump-version.mjs <versionName> [apkPath] [apkUrl] [notes]
//   node scripts/bump-version.mjs 1.1 build/app-release.apk \
//     https://github.com/octostream-project/OctoStream/releases/download/v1.1/octostream-1.1.apk \
//     "Novedades de la versión"
//
// Flujo de release:
//   1. node scripts/bump-version.mjs 1.1
//   2. npm run android:build:release   (genera android/app/build/outputs/apk/release/app-release.apk)
//   3. node scripts/bump-version.mjs 1.1 <apk> <url-del-release-en-github>
//   4. git commit + tag + push, y sube el APK a la release en GitHub

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

// Splits por ABI: si el dir de salida tiene app-<abi>-release.apk se genera
// apkUrls/sha256s por ABI. apkUrl apunta al build arm64-v8a como fallback
// para updaters antiguos y descargas manuales: los móviles modernos son
// arm64-only y RECHAZAN el APK de 32 bits ("Aplicación no instalada").
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
const splitDir = 'android/app/build/outputs/apk/release'
const apkUrls = {}
const sha256s = {}
for (const abi of ABIS) {
  const p = `${splitDir}/app-${abi}-release.apk`
  if (existsSync(p)) {
    apkUrls[abi] = `https://github.com/octostream-project/OctoStream/releases/download/v${versionName}/octostream-${versionName}-${abi}.apk`
    sha256s[abi] = createHash('sha256').update(readFileSync(p)).digest('hex')
  }
}

const manifest = {
  versionCode,
  versionName,
  minCode: 0,
  apkUrl: apkUrl || apkUrls['arm64-v8a'] || apkUrls['armeabi-v7a'] || '',
  sha256: sha256 || sha256s['arm64-v8a'] || sha256s['armeabi-v7a'] || '',
  notes,
}
if (Object.keys(apkUrls).length) {
  manifest.apkUrls = apkUrls
  manifest.sha256s = sha256s
  console.log('splits detectados:', Object.keys(apkUrls).join(', '))
}
writeFileSync('version.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('version.json →', manifest)
