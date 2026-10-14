// Local traffic accounting: the free tier has no server-side usage surface,
// so these are the numbers `/egress traffic` reports.

import assert from "node:assert/strict"
import { modelFrom, summarizeTraffic, type TrafficEntry } from "../src/traffic"

assert.equal(modelFrom('{"model":"mimo-v2.6-flash-free","messages":[]}'), "mimo-v2.6-flash-free")
assert.equal(modelFrom(undefined), undefined)
assert.equal(modelFrom("{}"), undefined)

const entries: TrafficEntry[] = [
  { ts: "2026-10-14T00:00:00Z", method: "POST", path: "/inference/v1/chat/completions", hop: "socks5://127.0.0.1:1", bytes: 100, model: "mimo-v2.6-flash-free" },
  { ts: "2026-10-14T00:00:01Z", method: "POST", path: "/inference/v1/chat/completions", hop: "socks5://127.0.0.1:2", bytes: 200, model: "mimo-v2.6-flash-free" },
  { ts: "2026-10-14T00:00:02Z", method: "POST", path: "/inference/v1/chat/completions", hop: "direct", bytes: 50 },
]
const summary = summarizeTraffic(entries)
assert.equal(summary.requests, 3)
assert.equal(summary.bytes, 350)
assert.deepEqual(summary.byHop, { "socks5://127.0.0.1:1": 1, "socks5://127.0.0.1:2": 1, direct: 1 })
assert.equal(summary.byModel["mimo-v2.6-flash-free"], 2, "model counts only where known")
assert.equal(summary.last, "2026-10-14T00:00:02Z")

console.log("TRAFFIC OK: per-hop and per-model accounting pinned")
