// Cache-strategic routing policy (src/routing.ts): new sessions join the warm
// leader while it has headroom, spill to the sibling near-full, and never
// start on a depleted account. These assertions pin the policy itself; the
// end-to-end pin behavior is proven in test/e2e/multi-account.mjs against the
// real host.

import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chooseAccount, noteServedOrg, noteUsageOrg } from "../src/routing"

// 1. The warm leader wins even with less headroom: consolidating on the
// account whose prompt cache is live beats the emptiest-first spread.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", usedPct: 0.5, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", usedPct: 0.1 },
  ]),
  1,
  "warm leader (most recently served) beats the emptier sibling",
)

// 2. Spill: a leader past the threshold starts no new sessions; the sibling
// with headroom takes them.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", usedPct: 0.95, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", usedPct: 0.1 },
  ]),
  2,
  "new sessions spill to the sibling once the leader is near-full",
)

// 3. The threshold is strict: exactly at the spill line the account is done
// taking new work (default spill = 90% used).
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", usedPct: 0.9, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", usedPct: 0.2 },
  ]),
  2,
  "at the spill line the leader stops taking new sessions",
)

// 4. When every account is near-full it no longer matters — but consolidating
// is never worse for cache, so the leader still wins.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", usedPct: 0.95, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", usedPct: 0.92 },
  ]),
  1,
  "all near-full: keep consolidating on the warm leader",
)

// 5. A depleted account starts nothing, warm or not.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", state: "depleted", usedPct: 1, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", usedPct: 0.4 },
  ]),
  2,
  "depleted accounts are never chosen",
)
assert.equal(
  chooseAccount([{ credentialId: 1, state: "depleted" }, { credentialId: 2, state: "depleted" }]),
  undefined,
  "no usable account: defer to core ranking",
)
assert.equal(chooseAccount([]), undefined, "empty pool: defer to core ranking")

// 6. No serving history yet: most headroom first, ties resolved stably.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", usedPct: 0.5 },
    { credentialId: 2, orgId: "B", usedPct: 0.1 },
  ]),
  2,
  "cold start: most headroom first",
)
assert.equal(
  chooseAccount([
    { credentialId: 7, orgId: "A", usedPct: 0.1 },
    { credentialId: 3, orgId: "B", usedPct: 0.1 },
  ]),
  3,
  "cold start at a tie: lowest credential id",
)

// 7. Health-derived headroom (remainingFraction) drives the same spill rule
// when no usage poll has reported yet.
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: "A", remainingFraction: 0.05, lastServedAtMs: 100 },
    { credentialId: 2, orgId: "B", remainingFraction: 0.5 },
  ]),
  2,
  "remainingFraction feeds the spill decision",
)

// 8. The threshold is tunable per call (OMP_GO_SPILL_PCT sets the default).
assert.equal(
  chooseAccount(
    [
      { credentialId: 1, orgId: "A", usedPct: 0.6, lastServedAtMs: 100 },
      { credentialId: 2, orgId: "B", usedPct: 0.2 },
    ],
    0.5,
  ),
  2,
  "custom spill threshold",
)

// 9. Warmth/usage state persists across processes (every omp invocation is a
// fresh process and must agree on the leader), survives a corrupt file, and
// stores nothing when no org is known.
{
  const home = mkdtempSync(path.join(tmpdir(), "omp-go-routing-"))
  const previousHome = process.env.HOME
  try {
    process.env.HOME = home
    const file = path.join(home, ".omp", "agent", "omp-go-routing.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{corrupt", "utf8")

    noteUsageOrg(undefined, 0.5) // unknown org: no-op, no throw
    noteUsageOrg("A", 0.42)
    noteServedOrg("A")
    noteServedOrg("B")

    const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    assert.ok(state.A !== undefined && typeof state.A === "object", "entry A stored")
    const a = state.A as Record<string, unknown>
    const b = state.B as Record<string, unknown>
    assert.equal(a.usedPct, 0.42, "usage poll recorded")
    assert.ok(typeof a.lastServedAtMs === "number", "serving recorded")
    assert.equal(b.usedPct, undefined, "only observed fields are stored")
    assert.ok(typeof b.lastServedAtMs === "number", "serving recorded for B")
    chmodSync(file, 0o600)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

console.log("ROUTING OK: warm-leader consolidation, spill at threshold, drain-by-pin")
