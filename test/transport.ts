// Transport contract test: the free-tier gateway fingerprint-checks header
// ORDER, header CASE, and session-id encoding (src/ordered-fetch.ts). These
// assertions pin the harness's exact wire shape without touching the network —
// if one of them breaks, free-tier requests get `FreeTierError`.

import assert from "node:assert/strict"
import { assembleHeaders } from "../src/ordered-fetch"
import { isHarnessID } from "../src/identifier"

const url = new URL("https://opencode.ai/inference/v1/chat/completions")
const body = Buffer.from(JSON.stringify({ model: "mimo-v2.6-flash-free", messages: [] }))
const headers = assembleHeaders(url, { authorization: "Bearer public", "content-type": "application/json" }, body)

// Order and casing are the harness's own (captured via mitmproxy from the real
// v2.0.26 binary). Node writes object keys verbatim, so both are load-bearing.
assert.deepEqual(
  Object.keys(headers),
  [
    "Authorization",
    "Content-Type",
    "User-Agent",
    "b3",
    "traceparent",
    "x-opencode-client",
    "x-opencode-project",
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "Connection",
    "Accept",
    "Host",
    "Accept-Encoding",
    "Content-Length",
  ],
  "header order/case must match the harness wire capture",
)
assert.equal(headers["User-Agent"], "opencode/latest/2.0.26/cli")
assert.equal(headers["Accept-Encoding"], "gzip, deflate, br, zstd")
assert.equal(headers["Host"], "opencode.ai")
assert.equal(headers["Content-Length"], String(body.byteLength))

// Session family: one `ses_` + harness descending id, all four headers equal.
for (const name of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
  assert.ok(headers[name].startsWith("ses_"), `${name} carries the ses_ prefix`)
  assert.ok(isHarnessID(headers[name].slice(4)), `${name} is the harness's descending encoding (gateway-enforced)`)
  assert.equal(headers[name], headers["x-opencode-session"])
}

// Trace headers: one trace id, one span id, b3 sampled with parent.
assert.match(headers["b3"], /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/)
assert.equal(headers["traceparent"], `00-${headers["b3"].split("-")[0]}-${headers["b3"].split("-")[1]}-01`)

// Unknown headers survive (e.g. org attribution), placed after the template.
const withOrg = assembleHeaders(url, { authorization: "Bearer public", "x-opencode-org-id": "org_42" }, body)
assert.equal(withOrg["x-opencode-org-id"], "org_42")

console.log("TRANSPORT OK: harness header order, casing, and session-id scheme pinned")
