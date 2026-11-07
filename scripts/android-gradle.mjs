import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const android = join(root, 'android')
const wrapper = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const args = process.argv.slice(2)
if (!args.length) throw new Error('Pass Gradle tasks, e.g. :app:assembleDebug')

const result = spawnSync(wrapper, args, {
  cwd: android,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
