import { describe, expect, it } from 'vitest'
import { isValidPartyId, isValidWatchPartyState } from './watchParty.js'

const now = 1_800_000_000_000
const validState = {
  kind: 'octostream-watch-party',
  version: 1,
  partyId: 'party_12345678',
  command: 'state',
  mediaKey: 'tt1234567',
  title: 'Example film',
  position: 120.5,
  playing: true,
  sentAt: now,
}

describe('watch-party message validation', () => {
  it('accepts constrained playback state and valid party IDs', () => {
    expect(isValidPartyId(validState.partyId)).toBe(true)
    expect(isValidWatchPartyState(validState, now)).toBe(true)
  })

  it('rejects stale, malformed, oversized, or URL-bearing payloads', () => {
    expect(isValidWatchPartyState({ ...validState, sentAt: now - 121_000 }, now)).toBe(false)
    expect(isValidWatchPartyState({ ...validState, position: Number.POSITIVE_INFINITY }, now)).toBe(false)
    expect(isValidWatchPartyState({ ...validState, title: 'x'.repeat(241) }, now)).toBe(false)
    expect(isValidWatchPartyState({ ...validState, partyId: 'bad' }, now)).toBe(false)
    expect(isValidWatchPartyState({ ...validState, url: 'https://signed.example/secret' }, now)).toBe(false)
  })
})
