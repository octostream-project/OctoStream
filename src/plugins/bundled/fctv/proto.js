// Minimal protobuf wire parser for FCTV match lists.
// Parses only the fields we need — not a general-purpose protobuf decoder.

const TD = new TextDecoder('utf-8')
const str = (buf) => TD.decode(buf)

function readVarint(buf, pos) {
  // Use multiplication, not << — JS bitwise ops are 32-bit and overflow on
  // timestamps/ids that exceed 2^31.
  let v = 0, shift = 0
  while (pos < buf.length) {
    const b = buf[pos++]
    v += (b & 0x7f) * 2 ** shift
    shift += 7
    if (!(b & 0x80)) break
  }
  return [v, pos]
}

function readKey(buf, pos) {
  const [key, next] = readVarint(buf, pos)
  return [key >> 3, key & 7, next]
}

function readLen(buf, pos) {
  const [ln, next] = readVarint(buf, pos)
  return [ln, next]
}

// Parse a match entry (field 10.1 in the response wrapper)
function parseMatch(buf) {
  const m = { matchId: 0, sportType: 0, matchDate: 0, league: {}, home: {}, away: {}, stream: null }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 0) {
      const [v, n] = readVarint(buf, pos)
      pos = n
      if (fnum === 1) m.matchId = v
      else if (fnum === 2) m.sportType = v
      else if (fnum === 3) m.matchDate = v // milliseconds
      else if (fnum === 22) m.status = v // match status code
      else if (fnum === 23) m.hasData = true
    } else if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 10) m.league = parseLeague(raw)
      else if (fnum === 30) {
        const t = parseTeamOrTitle(raw)
        if (t.title) m.title = t.title
        else if (!m.home.name) m.home = t
        else if (!m.away.name) m.away = t
      } else if (fnum === 100) m.score = parseScore(raw)
      else if (fnum === 150) {
        const meta = parseMatchMeta(raw)
        if (meta.slug) m.slug = meta.slug
        if (meta.leagueSlug) m.leagueSlug = meta.leagueSlug
      }
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return m
}

function parseLeague(buf) {
  const l = { leagueId: 0, name: '', logo: '', country: '', countryLogo: '' }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 0) {
      const [v, n] = readVarint(buf, pos)
      pos = n
      if (fnum === 1) l.leagueId = v
      else if (fnum === 2) l.sportType = v
    } else if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 3) l.name = parseNestedString(raw, 2)
      else if (fnum === 4) l.logo = str(raw)
      else if (fnum === 80) {
        // field 80 has country info: {1: id, 3: {2: name}, 4: logo}
        const c = parseNestedField(raw, 3)
        if (c) l.country = parseNestedString(c, 2)
        const cl = parseNestedField(raw, 4)
        if (cl) l.countryLogo = str(cl)
      }
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return l
}

function parseTeamOrTitle(buf) {
  // Field 30 is either a title wrapper {2: {8: {..: "Title"}}} or a team
  // {1: idx, 10: {1: teamId, 2: type, 3: {2: name}, 4: logoUrl}}
  const t = { title: '', name: '', logo: '' }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 2) t.title = deepestString(raw)
      else if (fnum === 10) {
        const team = parseNestedField(raw, 3)
        if (team) t.name = parseNestedString(team, 2)
        const logo = parseNestedField(raw, 4)
        if (logo) t.logo = str(logo)
      }
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return t
}

// Titles are a plain string a level or two deep ({2:"Title"} or
// {2:{8:{N:"Title"}}}) — take the longest printable string found, checking
// the buffer itself first so we never parse string bytes as field keys.
function deepestString(buf, depth = 0) {
  if (depth > 6) return ''
  const whole = str(buf)
  if (whole.length > 2 && /^[\x20-\x7e\u00c0-\u017f]+$/.test(whole)) return whole
  let best = ''
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      const s = str(raw)
      if (/^[\x20-\x7e\u00c0-\u017f]+$/.test(s) && s.length > best.length) best = s
      else {
        const inner = deepestString(raw, depth + 1)
        if (inner.length > best.length) best = inner
      }
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return best
}

function parseScore(buf) {
  // {1: home {10: score, ...}, 2: away {10: score, ...}} — field 10 is the
  // current total; other subfields are per-period breakdowns.
  const s = { home: null, away: null }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      const v = firstVarintField(raw, 10)
      if (fnum === 1) s.home = v
      else if (fnum === 2) s.away = v
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return s
}

function firstVarintField(buf, targetField) {
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 0) {
      const [v, n] = readVarint(buf, pos)
      pos = n
      if (fnum === targetField) return v
    } else if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n + ln
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return null
}

function parseMatchMeta(buf) {
  const m = {}
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 20) m.slug = str(raw)
      else if (fnum === 21) m.leagueSlug = str(raw)
      else if (fnum === 22) m.year = str(raw)
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return m
}

function parseNestedString(buf, targetField) {
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      if (fnum === targetField) return str(buf.slice(pos, pos + ln))
      pos += ln
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return ''
}

function parseNestedField(buf, targetField) {
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      if (fnum === targetField) return buf.slice(pos, pos + ln)
      pos += ln
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return null
}

// Parse a stream entry (field 10.2 in live/detail wrappers).
// f1=streamId (only in match/detail), f3=name, f9=siteType, f50=matchId.
// In /api/match/live the entries are markers: only f2/f5/f50 are set.
function parseStreamItem(buf) {
  const s = { streamId: 0, siteType: 0, name: '', matchId: 0 }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 0) {
      const [v, n] = readVarint(buf, pos)
      pos = n
      if (fnum === 1) s.streamId = v
      else if (fnum === 9) s.siteType = v
      else if (fnum === 50) s.matchId = v
    } else if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 3) s.name = str(raw)
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return s
}

// /api/match/detail: f10 → repeated f2 = stream entries.
export function parseDetailStreams(buf) {
  const streams = []
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt !== 2) {
      if (wt === 0) { const [, n] = readVarint(buf, pos); pos = n }
      else if (wt === 5) pos += 4
      else if (wt === 1) pos += 8
      else break
      continue
    }
    const [ln, n] = readLen(buf, pos)
    pos = n
    const raw = buf.slice(pos, pos + ln)
    pos += ln
    if (fnum !== 10) continue
    let j = 0
    while (j < raw.length) {
      const [f2, w2, n2] = readKey(raw, j)
      j = n2
      if (w2 === 2) {
        const [l2, n3] = readLen(raw, j)
        j = n3
        const inner = raw.slice(j, j + l2)
        j += l2
        if (f2 === 2) streams.push(parseStreamItem(inner))
      } else if (w2 === 0) {
        const [, n3] = readVarint(raw, j)
        j = n3
      } else if (w2 === 5) j += 4
      else if (w2 === 1) j += 8
      else break
    }
  }
  return streams
}

// /api/stream/detail: f10 → f2 → { f3: name, f4: encUrl, f12: encBackup[] }.
// Returns { name, url, backups } with the raw (still ROT47'd) strings.
export function parseStreamDetail(buf) {
  const out = { name: '', url: '', backups: [] }
  const data = parseNestedField(buf, 10)
  if (!data) return out
  const stream = parseNestedField(data, 2)
  if (!stream) return out
  let pos = 0
  while (pos < stream.length) {
    const [fnum, wt, next] = readKey(stream, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(stream, pos)
      pos = n
      const raw = stream.slice(pos, pos + ln)
      pos += ln
      if (fnum === 3) out.name = str(raw)
      else if (fnum === 4) out.url = str(raw)
      else if (fnum === 12) out.backups.push(str(raw))
    } else if (wt === 0) {
      const [, n] = readVarint(stream, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return out
}

// /api/user/info: f10 → { f1: ip, f2: country, f3: continent }
export function parseUserInfo(buf) {
  const data = parseNestedField(buf, 10)
  if (!data) return { country: '', continent: '' }
  return {
    country: parseNestedString(data, 2) || '',
    continent: parseNestedString(data, 3) || '',
  }
}

// Main entry: parse /api/match/live response
// Returns { matches: [], streams: [] }
export function parseLiveResponse(buf) {
  const result = { matches: [], streams: [] }
  let pos = 0
  while (pos < buf.length) {
    const [fnum, wt, next] = readKey(buf, pos)
    pos = next
    if (wt === 2) {
      const [ln, n] = readLen(buf, pos)
      pos = n
      const raw = buf.slice(pos, pos + ln)
      pos += ln
      if (fnum === 10) {
        // Parse wrapper: field 1 = matches, field 2 = streams, field 3 = odds
        let j = 0
        while (j < raw.length) {
          const [f2, w2, n2] = readKey(raw, j)
          j = n2
          if (w2 === 2) {
            const [l2, n3] = readLen(raw, j)
            j = n3
            const inner = raw.slice(j, j + l2)
            j += l2
            if (f2 === 1) result.matches.push(parseMatch(inner))
            else if (f2 === 2) result.streams.push(parseStreamItem(inner))
          } else if (w2 === 0) {
            const [, n3] = readVarint(raw, j)
            j = n3
          } else if (w2 === 5) j += 4
          else if (w2 === 1) j += 8
          else break
        }
      }
    } else if (wt === 0) {
      const [, n] = readVarint(buf, pos)
      pos = n
    } else if (wt === 5) pos += 4
    else if (wt === 1) pos += 8
    else break
  }
  return result
}

// ROT47 decoder for /api/common/params
export function rot47(str) {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : str[i]
  }
  return out
}
