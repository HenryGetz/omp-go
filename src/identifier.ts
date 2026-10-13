// Byte-exact port of the harness's identifier scheme
// (opencode/packages/schema/src/identifier.ts): the free-tier gateway validates
// that session ids are the harness's descending time encoding — random ids of
// the right shape get `FreeTierError: … can only be used from within OpenCode`.
//
//   value   = ~(Date.now() * 0x1000 + counter)      // descending
//   prefix  = low 48 bits of value, hex, 12 chars   // `eca234278ffe`-shaped
//   suffix  = 14 base62 chars (byte % 62)
//
// The gate checks the encoding, not freshness (30-day-old ids pass), so one id
// per session matches the harness exactly.

const LENGTH = 26
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

/** Harness `Identifier.descending()` — the session-id form the gateway accepts. */
export function descendingID(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = ~current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH - 12))
  return time + Array.from(bytes, (byte) => CHARS[byte % 62]).join("")
}

/** `ses_` + harness-shaped id (12 hex time chars + 14 base62). */
export function sessionIdentifier(timestamp = Date.now()): string {
  return `ses_${descendingID(timestamp)}`
}

/** Shape check for ids we did not generate (12 lowercase hex + 14 base62). */
export function isHarnessID(id: string): boolean {
  return /^[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)
}
