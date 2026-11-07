import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] || process.cwd())
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = app.version
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match) throw new Error(`Expected numeric Android version, got ${version}`)
const versionCode = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3])
const androidDir = join(root, 'android', 'app')
const gradlePath = join(androidDir, 'build.gradle')
const manifestPath = join(androidDir, 'src', 'main', 'AndroidManifest.xml')
let gradle = readFileSync(gradlePath, 'utf8')

function blockRange(source, name, from = 0) {
  const matchBlock = new RegExp(`\\b${name}\\s*\\{`).exec(source.slice(from))
  if (!matchBlock) throw new Error(`Could not find Gradle block: ${name}`)
  const start = from + matchBlock.index
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { start: open + 1, end: i }
  }
  throw new Error(`Unclosed Gradle block: ${name}`)
}

let defaults = blockRange(gradle, 'defaultConfig')
let defaultBody = gradle.slice(defaults.start, defaults.end)
const replaceOrAdd = (body, key, value) => {
  const pattern = new RegExp(`^\\s*${key}\\s*(?:=\\s*)?[^\\r\\n]+`, 'm')
  return pattern.test(body) ? body.replace(pattern, `        ${key} = ${value}`)
    : `\n        ${key} = ${value}${body}`
}
defaultBody = replaceOrAdd(defaultBody, 'versionCode', versionCode)
defaultBody = replaceOrAdd(defaultBody, 'versionName', `"${version}"`)
const abis = "'arm64-v8a', 'armeabi-v7a', 'x86_64'"
if (/splits\s*\{[\s\S]*?\babi\s*\{/.test(gradle)) {
  defaultBody = defaultBody.replace(/\s*ndk\s*\{\s*abiFilters[^}]*\}/s, '')
  const split = blockRange(gradle, 'splits')
  const splitBody = gradle.slice(split.start, split.end)
  const abi = blockRange(splitBody, 'abi')
  let abiBody = splitBody.slice(abi.start, abi.end)
  if (/^\s*include\s+/m.test(abiBody)) {
    abiBody = abiBody.replace(/^[ \t]*include\s+.+$/m, `            include ${abis}`)
  } else {
    abiBody = `\n            include ${abis}${abiBody}`
  }
  gradle = gradle.slice(0, split.start + abi.start) + abiBody
    + gradle.slice(split.start + abi.end)
} else {
  if (/ndk\s*\{/.test(defaultBody)) {
    defaultBody = defaultBody.replace(/ndk\s*\{[^}]*\}/s, `ndk { abiFilters ${abis} }`)
  } else {
    defaultBody = `\n        ndk { abiFilters ${abis} }${defaultBody}`
  }
}
defaults = blockRange(gradle, 'defaultConfig')
gradle = gradle.slice(0, defaults.start) + defaultBody + gradle.slice(defaults.end)

const buildTypes = blockRange(gradle, 'buildTypes')
const release = blockRange(gradle, 'release', buildTypes.start)
let releaseBody = gradle.slice(release.start, release.end)
if (/^[ \t]*debuggable[ \t]+/m.test(releaseBody)) {
  releaseBody = releaseBody.replace(/^[ \t]*debuggable[ \t]+\w+[ \t]*;?[ \t]*\}/m,
    '            debuggable false\n        }')
  releaseBody = releaseBody.replace(/^[ \t]*debuggable[ \t]+\w+[ \t]*;?[ \t]*(?=\r?$)/m,
    '            debuggable false')
} else {
  releaseBody = `\n            debuggable false\n${releaseBody}`
}
if (!releaseBody.endsWith('\n')) releaseBody += '\n'
gradle = gradle.slice(0, release.start) + releaseBody + gradle.slice(release.end)
writeFileSync(gradlePath, gradle)

let manifest = readFileSync(manifestPath, 'utf8')
manifest = manifest.replace(/<application\b([^>]*)>/, (_tag, rawAttributes) => {
  let attributes = rawAttributes
  const desired = {
    'android:allowBackup': 'false',
    'android:enableOnBackInvokedCallback': 'true',
    'android:largeHeap': 'true',
    'android:extractNativeLibs': 'true',
    'android:usesCleartextTraffic': 'true',
  }
  for (const [name, value] of Object.entries(desired)) {
    const attr = new RegExp(`\\s${name.replace(':', '\\:')}="[^"]*"`)
    attributes = attr.test(attributes)
      ? attributes.replace(attr, ` ${name}="${value}"`)
      : `${attributes} ${name}="${value}"`
  }
  return `<application${attributes}>`
})
writeFileSync(manifestPath, manifest)

function findMainActivity(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findMainActivity(path)
      if (found) return found
    } else if (entry.name === 'MainActivity.java') return path
  }
  return null
}

const activityPath = findMainActivity(join(androidDir, 'src', 'main', 'java'))
if (!activityPath) throw new Error('Could not find generated MainActivity.java')
let activity = readFileSync(activityPath, 'utf8')
if (!activity.includes('import android.view.WindowManager;')) {
  activity = activity.replace(/^(package [^;]+;\s*)/m, '$1\nimport android.view.WindowManager;')
}
if (!activity.includes('FLAG_KEEP_SCREEN_ON')) {
  const method = /public\s+void\s+onCreate\s*\([^)]*\)\s*\{/.exec(activity)
  if (method) {
    const bodyStart = activity.indexOf('{', method.index) + 1
    const superCall = /super\.onCreate\([^)]*\)\s*;/.exec(activity.slice(bodyStart))
    if (!superCall) throw new Error('MainActivity.onCreate must call super.onCreate')
    const insertAt = bodyStart + superCall.index + superCall[0].length
    activity = activity.slice(0, insertAt)
      + '\n        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);'
      + activity.slice(insertAt)
  } else {
    const close = activity.lastIndexOf('}')
    activity = activity.slice(0, close)
      + '\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n'
      + '        super.onCreate(savedInstanceState);\n'
      + '        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n'
      + '    }\n'
      + activity.slice(close)
  }
}
writeFileSync(activityPath, activity)

console.log(`Prepared Android project: ${version} (${versionCode}), release non-debuggable`)
