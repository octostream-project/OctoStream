// Descarga los binarios openvpn embebidos (libovpnexec.so + libopenvpn.so)
// desde el APK oficial de OpenVPN for Android (F-Droid, GPLv2) y los
// extrae a capacitor-plugins/cloud-proxy/android/src/main/jniLibs/<abi>/.
// Uso: node scripts/fetch-ovpnexec.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APK_URL = 'https://f-droid.org/repo/de.blinkt.openvpn_219.apk'
const DEST = path.join(ROOT, 'capacitor-plugins/cloud-proxy/android/src/main/jniLibs')
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
const LIBS = ['libovpnexec.so', 'libopenvpn.so']

const tmp = path.join('/tmp', 'de.blinkt.openvpn.apk')
if (!fs.existsSync(tmp)) {
  console.log('Descargando', APK_URL)
  const out = fs.createWriteStream(tmp)
  await new Promise((res, rej) => {
    https.get(APK_URL, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) return https.get(r.headers.location, (r2) => r2.pipe(out).on('finish', res))
      r.pipe(out).on('finish', res)
    }).on('error', rej)
  })
}
for (const abi of ABIS) {
  const dir = path.join(DEST, abi)
  fs.mkdirSync(dir, { recursive: true })
  for (const lib of LIBS) {
    execFileSync('unzip', ['-o', '-j', tmp, `lib/${abi}/${lib}`, '-d', dir], { stdio: 'inherit' })
  }
  console.log(abi, '→', fs.readdirSync(dir).filter(f => f.endsWith('.so')).join(', '))
}
console.log('Listo — los .so quedan en jniLibs (se commitean como libaether.so).')
