// Wrapper multiplataforma para la auditoría en vivo de canales (sin cross-env):
//   npm run audit:channels
// Equivale a CHANNEL_AUDIT=1 vitest run channels.audit.test.js — imprime la
// tabla catálogo+búsqueda por canal. Reporta, no falla.
import { spawnSync } from 'node:child_process'

process.env.CHANNEL_AUDIT = '1'
const r = spawnSync('npx', ['vitest', 'run', 'channels.audit.test.js'],
  { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
process.exit(r.status ?? 0)
