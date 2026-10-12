// Bundlea electron/torrent.cjs + webtorrent en un único archivo ESM
// self-contained (electron/torrent.bundle.mjs) para el asar — la app
// empaquetada no incluye node_modules, así que hay que inlinear el motor.
// Los módulos nativos opcionales (utp, wrtc, fs-ext…) se stubbean a un
// módulo vacío: webtorrent los require()/import() en try/catch o con
// detección de feature, y funciona sin ellos (sin WebRTC ni uTP).
import { rolldown } from 'rolldown'
import { builtinModules } from 'node:module'

const OPTIONAL_NATIVE = new Set([
  'utp-native', 'node-datachannel', 'bufferutil', 'utf-8-validate',
  'fs-native-extensions', 'wrtc', 'webrtc-polyfill', 'electron',
])
const STUB_ID = '\0octostream:empty-stub'

const stubOptionalNatives = {
  name: 'octostream-stub-optional-natives',
  resolveId(source) {
    if (OPTIONAL_NATIVE.has(source) || source.startsWith('node-datachannel')) {
      return `${STUB_ID}:${source}`
    }
    return null
  },
  load(id) {
    if (!id.startsWith(STUB_ID)) return null
    const src = id.slice(STUB_ID.length + 1)
    if (src === 'webrtc-polyfill') {
      // simple-peer importa las clases RTC estáticamente; undefined = off.
      return `export default {}
export const RTCPeerConnection = undefined
export const RTCSessionDescription = undefined
export const RTCIceCandidate = undefined
`
    }
    if (src === 'utp-native') {
      // Módulo CJS vacío de verdad: webtorrent comprueba
      // Object.keys(utp).length>0 para UTP_SUPPORT → export {} → {}
      return 'export {}\n'
    }
    // Stub vacío con default para imports default estáticos.
    return 'export default {}\n'
  },
}

const bundle = await rolldown({
  input: 'electron/torrent.cjs',
  platform: 'node',
  external: [
    /^node:/,
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`),
  ],
  plugins: [stubOptionalNatives],
  onLog(level, log) {
    if (level === 'warn') console.warn('[rolldown]', log.message)
  },
})
await bundle.write({
  file: 'electron/torrent.bundle.mjs',
  format: 'esm',
  sourcemap: false,
  minify: false,
  codeSplitting: false,
})
await bundle.close()
console.log('torrent.bundle.mjs generado')
