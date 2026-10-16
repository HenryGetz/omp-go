// `/freeusage` local accounting: rolling per-model windows, the tripped-window
// cooldown, tolerant ledger reads, and the model filter. The free tier has no
// server-side usage surface, so this is all the visibility there is.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const dir = mkdtempSync(path.join(tmpdir(), "omp-go-free-usage-test-"))
process.env.OMP_GO_WIRE_LOG = path.join(dir, "ledger-for-record.ndjson")

import { recordTraffic, retryAfterMsFromHeaders, trafficFile } from "../src/traffic"
import { aggregateFreeUsage, formatRemaining, freeLaneIds, freeUsageReport, isFreeLanePath, readLedger, WINDOWS } from "../src/free-usage"

const FREE_IDS = ["alpha-free", "beta-free", "gamma-free"]
const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString()
const row = (
  offsetMs: number,
  model: string,
  extra: Record<string, unknown> = {},
  bytes = 0,
  path = "/inference/v1/chat/completions",
) => ({ ts: at(offsetMs), method: "POST", path, hop: "direct", bytes, model, ...extra })

// ---------------------------------------------------------------- header parse
assert.equal(retryAfterMsFromHeaders(new Headers({ "retry-after-ms": "24409000" })), 24_409_000)
assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": "24409000" }), 24_409_000, "raw node header records parse too")
assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": ["3000"] }), 3000, "array-valued headers (node duplicates) parse")
assert.equal(retryAfterMsFromHeaders({ "retry-after": "60" }), 60_000, "retry-after seconds")
assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": "1000", "retry-after": "60" }), 60_000, "largest candidate wins")
assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": "0" }), undefined, "non-positive deltas are not a wait")
assert.equal(retryAfterMsFromHeaders({ "retry-after-ms": "soon" }), undefined)
assert.equal(retryAfterMsFromHeaders({}), undefined)
assert.equal(retryAfterMsFromHeaders(undefined), undefined)
const dateHeader = new Date(Date.now() + 90_000).toUTCString()
const fromDate = retryAfterMsFromHeaders({ "retry-after": dateHeader })
assert.ok(fromDate !== undefined && fromDate > 88_000 && fromDate <= 90_000, `HTTP-date retry-after (${fromDate})`)
const resetSeconds = retryAfterMsFromHeaders({ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) })
assert.ok(resetSeconds !== undefined && resetSeconds > 118_000 && resetSeconds <= 120_000, `x-ratelimit-reset epoch seconds (${resetSeconds})`)

// ---------------------------------------------------------- ledger round trip
recordTraffic({
  ts: at(0),
  method: "POST",
  path: "/inference/v1/chat/completions",
  hop: "direct",
  bytes: 7,
  model: "alpha-free",
  status: 429,
  retryAfterMs: 123,
})
writeFileSync(
  trafficFile(),
  `${JSON.stringify({ ts: at(10), method: "POST", path: "/x", hop: "direct", bytes: 1, model: "alpha-free" })}\n`,
  { flag: "a" },
)
const written = readLedger(trafficFile())
assert.equal(written.length, 2, "recorded line + old-shape line both read")
assert.equal(written[0]?.status, 429, "the new fields survive the write/read round trip")
assert.equal(written[0]?.retryAfterMs, 123)
assert.equal(written[1]?.status, undefined, "old-shape lines keep parsing without status/retryAfterMs")

// ------------------------------------------------------------ lane predicate
assert.equal(isFreeLanePath("/inference/v1/chat/completions"), true, "the free provider's own base is the free lane")
assert.equal(isFreeLanePath("/inference/openai/v1/chat/completions"), true, "the historical OpenAI-shaped free base is too")
assert.equal(isFreeLanePath("/zen/go/v1/chat/completions"), false, "the subscription lane stamps /go/")
assert.equal(isFreeLanePath("/inference/go/openai/v1/chat/completions"), false, "…including the older Console alias")
assert.equal(isFreeLanePath(undefined), false, "a line with no path cannot be attributed to a lane")

// ------------------------------------------------------------------ fixture
const lines = [
  JSON.stringify(row(86_500_000, "alpha-free", { status: 500 }, 5)), // outside 24h
  JSON.stringify(row(WINDOWS.h24, "alpha-free", { status: 200 }, 10)), // exactly on the 24h edge
  JSON.stringify(row(WINDOWS.h5 + 1, "alpha-free", {}, 20)), // old shape: no status recorded
  JSON.stringify(row(WINDOWS.h5, "alpha-free", { status: 200 }, 30)), // exactly on the 5h edge
  JSON.stringify(row(WINDOWS.h1 + 1, "alpha-free", { status: 200 }, 40)),
  JSON.stringify(row(WINDOWS.h1, "alpha-free", { status: 429, retryAfterMs: 20_809_000 }, 50)), // exactly on the 1h edge
  JSON.stringify(row(600_000, "beta-free", { status: 429 })), // newest 429, no hint
  JSON.stringify(row(10_000_000, "beta-free", { status: 429, retryAfterMs: 86_400_000 })), // older hinted 429
  JSON.stringify(row(120_000, "beta-free", { status: 200 })), // old-shape-newest? no: 2m ago is newest
  `{"ts":"${at(1_000)}",`, // partial append
  "not json at all",
  "", // blank
  JSON.stringify({ ts: 12345, method: "POST", path: "/x", hop: "direct", bytes: 1, model: "alpha-free" }), // no ts string
  // The live catalog's free models: not in the embedded snapshot, so only the
  // ledger's own free-lane rows can put them in the report.
  JSON.stringify(row(600_000, "deepseek-v4.1-flash-free", { status: 200 }, 1024)),
  JSON.stringify(row(1_800_000, "deepseek-v4.1-flash-free", { status: 200 }, 2048)),
  JSON.stringify(row(60_000, "ling-3.0-flash-fin-free", { status: 200 })), // catalog-dropped free model
  // A paid model the Go lane served through the SAME historical base path
  // (`/inference/openai/v1/…`), which is what makes the path alone ambiguous.
  JSON.stringify(row(60_000, "deepseek-v4.1-flash", { status: 200 }, 4096)),
  JSON.stringify(row(60_000, "deepseek-v4.1-flash", { status: 200 }, 4096, "/zen/go/v1/chat/completions")),
  // A free model's line that the Go lane carried: never charged to its window.
  JSON.stringify(row(900_000, "alpha-free", { status: 200 }, 9999, "/zen/go/v1/chat/completions")),
  JSON.stringify({ ts: at(60_000), method: "POST", path: "/x", hop: "direct", bytes: 3 }), // no model at all
]
const ledger = path.join(dir, "ledger.ndjson")
writeFileSync(ledger, `${lines.join("\n")}\n`)

const entries = readLedger(ledger)
assert.equal(entries.length, lines.length - 4, "malformed and non-string-ts lines are skipped silently")

const rows = aggregateFreeUsage(entries, { freeIds: FREE_IDS, now: NOW })
assert.deepEqual(
  rows.map((entry) => entry.id),
  ["alpha-free", "beta-free", "gamma-free"],
  "sorted by 5h requests desc, then id; every roster model present",
)

const alpha = rows[0]!
assert.deepEqual(alpha.requests, { h1: 1, h5: 3, h24: 5 }, "window boundaries are inclusive: 1h/5h/24h each keep their edge row")
assert.deepEqual(alpha.bytes, { h1: 50, h5: 120, h24: 150 }, "bytes follow the same windows")
assert.equal(alpha.lastTs, at(WINDOWS.h1), "last request is the newest FREE-lane row (the newer /zen/go/v1 line is not ours)")
assert.ok(alpha.bytes.h1 === 50, "a Go-lane line for a free model id never charges that model's window")
assert.equal(alpha.lastStatus, 429)
assert.equal(alpha.cooldownUntil, NOW - WINDOWS.h1 + 20_809_000, "the newest 429's own hint sets the cooldown end")

const beta = rows[1]!
assert.deepEqual(beta.requests, { h1: 2, h5: 3, h24: 3 }, "old-shape rows (no status) still aggregate")
assert.equal(beta.lastStatus, 200, "last status tracks the newest row")
assert.equal(beta.cooldownUntil, undefined, "the newest 429 carried no hint, so no cooldown is claimed")

const gamma = rows[2]!
assert.deepEqual(gamma.requests, { h1: 0, h5: 0, h24: 0 })
assert.equal(gamma.lastTs, undefined)
assert.equal(gamma.lastStatus, undefined)
assert.equal(gamma.cooldownUntil, undefined, "a zero-usage model renders idle rather than vanishing")

// -------------------------------------------------------------- lane union
const union = freeLaneIds(entries, FREE_IDS)
assert.deepEqual(
  [...union].sort(),
  ["alpha-free", "beta-free", "deepseek-v4.1-flash-free", "gamma-free", "ling-3.0-flash-fin-free"],
  "the roster wins by default; free-lane ledger ids are added, paid ids are not",
)
assert.ok(!union.includes("deepseek-v4.1-flash"), "the paid model on a non-/go/ path stays out")
assert.ok(freeLaneIds(entries).includes("deepseek-v4.1-flash-free"), "the default roster (the live one) unions with the ledger")

// The same ledger through the DEFAULT row set: snapshot roster ∪ free-lane ledger ids.
const unionReport = freeUsageReport({ file: ledger, now: NOW })
const unionRows = unionReport.split("\n").filter((line) => line.startsWith("deepseek-v4.1-flash"))
assert.equal(unionRows.length, 1, "only the free id renders a row")
assert.match(unionRows[0]!, /^deepseek-v4\.1-flash-free +2 /, "the union row carries its real window counts (2 requests in 1h)")
assert.match(unionReport, /^ling-3\.0-flash-fin-free /m, "a catalog-dropped free model with ledger rows still renders")
assert.match(unionReport, /alpha-free +1/, "the go-lane line is still excluded from the count")
assert.match(
  unionReport,
  /free-tier window totals: 1h 6 req · 5h 9 req · 24h 11 req/,
  "totals include the union rows and exclude the paid ones",
)

// -------------------------------------------------------------- expired 429
const expired = aggregateFreeUsage(
  [row(3_600_000, "alpha-free", { status: 429, retryAfterMs: 60_000 })],
  { freeIds: FREE_IDS, now: NOW },
)
assert.equal(expired[0]!.cooldownUntil, undefined, "an already-elapsed window is not a cooldown")
assert.equal(expired[0]!.lastStatus, 429, "…but the 429 stays the last status")

// ------------------------------------------------------------------- report
const report = freeUsageReport({ file: ledger, freeIds: FREE_IDS, now: NOW })
assert.match(report, /LOCAL accounting/, "the header says the numbers are client-side only")
assert.match(report, /no\s+server-side usage/)
assert.ok(report.includes(ledger), "the header names the ledger path it read")
assert.match(report, /free-tier window totals: 1h 3 req · 5h 6 req · 24h 8 req/)
assert.match(report, /alpha-free/, "roster rows render")
assert.match(report, /gamma-free +0 +0 B/, "a zero-usage model still gets a row")
assert.ok(report.includes("idle"), "zero usage renders idle")
assert.match(report, new RegExp(`limited \\(until \\d\\d:\\d\\d, ~${formatRemaining(20_809_000 - WINDOWS.h1)} left\\)`))
assert.match(report, /note: limits are per-MODEL rolling windows/)
assert.equal(report.split("\n").length, 3 + 1 + 3 + 2, "header + column row + one row per free model + footer")

const filtered = freeUsageReport({ file: ledger, freeIds: FREE_IDS, now: NOW, filter: "ALPHA" })
assert.ok(filtered.includes("alpha-free") && !filtered.includes("beta-free"), "filter matches case-insensitively")
assert.match(filtered, /filter 'ALPHA'/)
assert.match(filtered, /free-tier window totals: 1h 3 req · 5h 6 req · 24h 8 req · filter/, "totals stay tier-wide")

const none = freeUsageReport({ file: ledger, freeIds: FREE_IDS, now: NOW, filter: "mimo" })
assert.match(none, /no free models match 'mimo'/, "no match is a clear line, not a crash")
assert.ok(!none.includes("gamma-free"), "…and no rows follow it")

// -------------------------------------------------------------- empty ledger
const missing = path.join(dir, "does-not-exist.ndjson")
assert.deepEqual(readLedger(missing), [], "a missing ledger reads as empty")
const empty = freeUsageReport({ file: missing, freeIds: FREE_IDS, now: NOW })
assert.match(empty, /free-tier window totals: 1h 0 req · 5h 0 req · 24h 0 req/)
assert.equal(empty.split("\n").filter((line) => line.includes("idle")).length, 3, "an empty ledger renders the whole roster as idle")

const malformedOnly = path.join(dir, "malformed.ndjson")
writeFileSync(malformedOnly, "{oops\n\n}\n")
assert.deepEqual(readLedger(malformedOnly), [], "a fully malformed ledger is empty, never a throw")

// ------------------------------------------------------------- empty filter
const blank = freeUsageReport({ file: ledger, freeIds: FREE_IDS, now: NOW, filter: "   " })
assert.equal(blank, report, "a whitespace-only filter is no filter")

// ------------------------------------------------------- stale-row stamping
const staleFile = path.join(dir, "stale.ndjson")
writeFileSync(staleFile, `${JSON.stringify(row(50 * WINDOWS.h24, "alpha-free", { status: 200 }))}\n`)
const staleRow = freeUsageReport({ file: staleFile, freeIds: FREE_IDS, now: NOW })
  .split("\n")
  .find((line) => line.startsWith("alpha-free"))!
const staleDate = new Date(NOW - 50 * WINDOWS.h24)
const expectedStamp = `${String(staleDate.getMonth() + 1).padStart(2, "0")}-${String(staleDate.getDate()).padStart(2, "0")} ${String(staleDate.getHours()).padStart(2, "0")}:${String(staleDate.getMinutes()).padStart(2, "0")}`
assert.ok(staleRow.includes(expectedStamp), `an out-of-window stamp carries its date (${staleRow})`)
assert.match(staleRow, /idle/)
assert.match(report, / \d\d:\d\d:\d\d +429 /, "an in-window stamp is a bare time of day")

rmSync(dir, { recursive: true, force: true })
console.log("FREE-USAGE OK: rolling windows, cooldown, tolerant ledger, filter and idle rows pinned")
