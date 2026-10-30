// Integration test against the real AllDebrid API. Runs in CI nightly only
// when the ALLDEBRID_KEY secret is configured — catches API breakages
// (v4→v4.1 endpoint moves, auth changes) before users notice.
//
// Usage: ALLDEBRID_KEY=xxx node scripts/ad-integration-test.mjs

const key = process.env.ALLDEBRID_KEY
if (!key) {
  console.log('SKIP: no ALLDEBRID_KEY')
  process.exit(0)
}

const BASES = ['https://api.alldebrid.com/v4.1', 'https://api.alldebrid.com/v4']
const api = async (base, path, params = {}, method = 'GET') => {
  const q = new URLSearchParams({ agent: 'octostream_ci', apikey: key, ...params })
  const res = await fetch(`${base}${path}?${q}`, { method })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

let fails = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) fails++
}

let user = null
for (const base of BASES) {
  try {
    user = await api(base, '/user')
    if (user?.status === 'success') break
  } catch { /* probar la otra version */ }
}
check('user auth/read-only', user?.status === 'success' && !!user?.data?.user)

// /magnet/instant is read-only; unlike /link/unlock or /magnet/upload it
// cannot consume quota or create account history/queue entries.
let instant = null
for (const base of BASES) {
  try {
    instant = await api(base, '/magnet/instant', {
      'magnets[]': 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10',
    }, 'POST')
    if (instant?.status === 'success') break
  } catch { /* probar la otra version */ }
}
check('magnet/instant read-only endpoint', instant?.status === 'success')

process.exit(fails ? 1 : 0)
