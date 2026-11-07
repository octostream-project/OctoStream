import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./prepare-android.mjs', import.meta.url))
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const [major, minor, patch] = version.split('.').map(Number)
const versionCode = major * 10000 + minor * 100 + patch

function fixture(withSplits) {
  const root = mkdtempSync(join(tmpdir(), 'octostream-android-prepare-'))
  const app = join(root, 'android', 'app')
  const java = join(app, 'src', 'main', 'java', 'com', 'octostream', 'app')
  mkdirSync(java, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(app, 'build.gradle'), `android {
    defaultConfig {
        applicationId "com.octostream.app"
    }
    ${withSplits ? "splits { abi { include 'arm64-v8a' } }" : ''}
    buildTypes {
        release {
            minifyEnabled true
        }
    }
}
`)
  writeFileSync(join(app, 'src', 'main', 'AndroidManifest.xml'),
    '<manifest><application><activity android:name=".MainActivity" /></application></manifest>')
  writeFileSync(join(java, 'MainActivity.java'),
    'package com.octostream.app;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n')
  return { root, app, java }
}

for (const withSplits of [false, true]) {
  const test = fixture(withSplits)
  try {
    execFileSync(process.execPath, [script, test.root], { stdio: 'ignore' })
    execFileSync(process.execPath, [script, test.root], { stdio: 'ignore' })
    const gradle = readFileSync(join(test.app, 'build.gradle'), 'utf8')
    assert.match(gradle, new RegExp(`versionCode = ${versionCode}`))
    assert.match(gradle, new RegExp(`versionName = "${version.replaceAll('.', '\\.')}"`))
    assert.match(gradle, /debuggable false/)
    if (withSplits) {
      assert.match(gradle, /include 'arm64-v8a', 'armeabi-v7a', 'x86_64'/)
      assert.doesNotMatch(gradle, /abiFilters/)
    } else {
      assert.match(gradle, /abiFilters 'arm64-v8a', 'armeabi-v7a', 'x86_64'/)
    }
    const manifest = readFileSync(join(test.app, 'src', 'main', 'AndroidManifest.xml'), 'utf8')
    assert.match(manifest, /android:usesCleartextTraffic="true"/)
    const activity = readFileSync(join(test.java, 'MainActivity.java'), 'utf8')
    assert.equal((activity.match(/FLAG_KEEP_SCREEN_ON/g) || []).length, 1)
  } finally {
    rmSync(test.root, { recursive: true, force: true })
  }
}

console.log('Android project preparation: fresh/split configs and idempotence OK')
