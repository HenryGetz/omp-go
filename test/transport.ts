// Transport contract test: the free-tier gateway fingerprint-checks header
// ORDER, header CASE, and session-id encoding (src/ordered-fetch.ts). These
// assertions pin the harness's exact wire shape without touching the network —
// if one of them breaks, free-tier requests get `FreeTierError`.

import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { assembleHeaders, decode } from "../src/ordered-fetch"
import { readHttpResponse } from "../src/raw-http"
import { orgScopedHeaders } from "../src/console-config"
import { writeModelsOverride } from "../src/models-config"
import { WIRE_API, isOurWireProvider, withServingOrg } from "../src/register"
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

// Static org stamps are banned: an org written into models.yml outlives the
// per-request credential, and the pool's other token then serves under the
// wrong org — the gateway answers `403 Workspace access denied` (reproduced
// against both real accounts). The org rides the serving credential only.
{
  const home = mkdtempSync(path.join(tmpdir(), "omp-org-stamp-"))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    // Pre-seed a foreign provider: the managed block must merge into the
    // file's existing `providers:` map (a second top-level key loses whichever
    // key wins in YAML) and still carry its own markers + stamp.
    const dir = path.join(home, ".omp", "agent")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "models.yml"),
      "providers:\n  anthropic:\n    baseUrl: https://api.anthropic.com\n",
      { mode: 0o600 },
    )

    writeModelsOverride({ orgId: "wrk_01TESTWORKSPACE000000000000" })
    const content = readFileSync(path.join(dir, readdirSync(dir).find((name) => name === "models.yml")!), "utf8")
    assert.ok(!content.includes("x-opencode-org-id"), "models.yml never stamps x-opencode-org-id")
    assert.ok(!content.includes("wrk_01TESTWORKSPACE"), "no org value leaks into the managed block")
    assert.ok(content.includes("x-session-id"), "attribution headers still present")
    // Freshness stamp: `ensureModelsOverride` skips the state-lock rewrite only
    // on a stamped block; a run that drops it makes every session start rewrite.
    assert.match(content, /^# generated: \d+$/m, "managed block always carries the # generated: stamp")
    // Per-model reasoning defaults: without `modelOverrides` every chat silently
    // runs at the gateway's lightest effort rung.
    assert.ok(content.includes("modelOverrides:"), "effort-capable catalog models get modelOverrides")
    assert.match(content, /^ {6}"[^"]+":$/m, "modelOverrides carries per-model entries")
    // Merge, not nest: the foreign provider survives and only one top-level map.
    assert.ok(content.includes("anthropic:"), "foreign providers are preserved")
    assert.equal(content.match(/^providers:$/gm)?.length, 1, "the block merges into one top-level providers map")
    assert.ok(
      content.includes("# >>> omp-go managed block (do not edit) >>>\n# generated: "),
      "BEGIN marker is immediately followed by the stamp, before the providers map",
    )
  } finally {
    process.env.HOME = previousHome
  }
}

// Routing decision (src/register.ts `wireStream`): a model carrying the
// built-in `openai-completions`/`openai-responses` api for one of OUR providers
// must still be routed through the fingerprint wrapper. pi-catalog's built-in
// `opencode-go` rows look exactly like this, and that is what a preset's
// `pi.setModel` hands over — an `api === WIRE_API` guard would drop the
// per-request `x-opencode-org-id` and the gateway would answer
// `402 Insufficient account funds` for a funded account.
const wireApi: string = WIRE_API
assert.ok(wireApi !== "openai-completions" && wireApi !== "openai-responses", "WIRE_API is a custom, non-built-in id")
assert.equal(isOurWireProvider("opencode-go"), true)
assert.equal(isOurWireProvider("opencode-free"), true)
assert.equal(isOurWireProvider("anthropic"), false, "foreign providers are never swallowed")
assert.equal(isOurWireProvider(undefined), false)
for (const api of [WIRE_API, "openai-completions", "openai-responses"]) {
  const registryRow = { id: "deepseek-v4.1-flash", provider: "opencode-go", api } as const
  assert.equal(
    isOurWireProvider(registryRow.provider),
    true,
    `provider ${registryRow.provider} with api ${api} still rides the fingerprint wrapper`,
  )
}

// Org attribution is single-sourced. The Console-config cache is per org, and a
// fallback snapshot belongs to ANOTHER account: reusing its `x-opencode-org-id`
// pairs this bearer with an org it is not a member of — the exact shape the
// gateway answers with `402 … Insufficient account funds` / `403 Workspace
// access denied` (reproduced against both real accounts).
const fingerprint = { "user-agent": "opencode/latest/2.0.26/cli" }
assert.deepEqual(
  orgScopedHeaders({ ...fingerprint, "x-opencode-org-id": "wrk_OTHERACCOUNT" }, false),
  fingerprint,
  "a foreign snapshot contributes org-neutral values only",
)
assert.deepEqual(
  orgScopedHeaders({ ...fingerprint, "X-Opencode-Org-Id": "wrk_OTHERACCOUNT" }, false),
  fingerprint,
  "the org stamp is dropped whatever its casing",
)
assert.deepEqual(
  orgScopedHeaders({ "x-opencode-org-id": "wrk_MINE" }, true),
  { "x-opencode-org-id": "wrk_MINE" },
  "the org's own snapshot keeps its attribution",
)

// The request-time merge: only the serving credential's own org survives.
{
  const merged = withServingOrg(
    { ...fingerprint, "x-opencode-org-id": "wrk_OTHERACCOUNT" },
    "wrk_MINE",
  )
  assert.equal(merged["x-opencode-org-id"], "wrk_MINE", "the resolved serving org overrides a foreign stamp")
  assert.equal(
    Object.keys(merged).filter((name) => name.toLowerCase() === "x-opencode-org-id").length,
    1,
    "exactly one x-opencode-org-id reaches the wire",
  )
  assert.equal(merged["user-agent"], fingerprint["user-agent"], "fingerprint headers survive the merge")

  // No resolved org: send none, never a stale foreign one.
  const unowned = withServingOrg({ ...fingerprint, "x-opencode-org-id": "wrk_OTHERACCOUNT" }, undefined)
  assert.ok(!("x-opencode-org-id" in unowned), "no org id resolved => no org header at all")
  assert.equal(unowned["user-agent"], fingerprint["user-agent"], "fingerprint headers still sent without an org")
}

// --- Accept-Encoding / decoder lockstep --------------------------------------

// The harness's exact accept-encoding is fingerprint-checked, so EVERY token it
// advertises must have a decoder: a response handed downstream still compressed
// kills the SSE reader for the whole stream (zstd was advertised-but-undecoded).
{
  const advertised = (headers["Accept-Encoding"] ?? "").split(", ")
  assert.deepEqual(advertised, ["gzip", "deflate", "br", "zstd"], "the harness's exact accept-encoding set")
  for (const coding of advertised)
    assert.ok(decode(coding), `accept-encoding advertises "${coding}" but decode() cannot decode it`)
  const compressed = zlib.zstdCompressSync(Buffer.from("hello zstd"))
  const decoded = await new Promise<string>((resolve, reject) => {
    const stream = decode("zstd")
    if (!stream) return reject(new Error("no zstd decoder"))
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()))
    stream.on("error", reject)
    stream.end(compressed)
  })
  assert.equal(decoded, "hello zstd", "the zstd decoder must actually round-trip, not just exist")
}

// --- raw-http: a dropped connection must ERROR, never resolve short ----------

// The proxied path parses responses over a raw socket; before this, EOF in the
// middle of a declared frame resolved the PARTIAL buffer as success and the
// tail misparsed. Every truncated frame now errors; clean EOF-framed bodies
// (the connection's end is the frame) still complete.
{
  const serve = async (respond: (socket: net.Socket) => void) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined)
      respond(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    return { port, server }
  }
  const rawGet = async (port: number) => {
    const socket = net.connect(port, "127.0.0.1")
    await once(socket, "connect")
    return readHttpResponse(socket)
  }
  const readAllBody = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks)
  }

  // Dropped mid-content-length body.
  {
    const { port, server } = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n")
      socket.write("0123456789")
      socket.end()
    })
    try {
      const response = await rawGet(port)
      assert.equal(response.status, 200, "the head of a truncated response still parses")
      await assert.rejects(
        () => readAllBody(response.body),
        /connection closed after 10 of 50 bytes/,
        "a truncated content-length body must error, not resolve short",
      )
    } finally {
      server.close()
    }
  }

  // Dropped mid-chunk body.
  {
    const { port, server } = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
      socket.write("a\r\n")
      socket.write("partial")
      socket.end()
    })
    try {
      const response = await rawGet(port)
      await assert.rejects(
        () => readAllBody(response.body),
        /connection closed after 7 of 10 bytes/,
        "a truncated chunk body must error, not misframe the tail",
      )
    } finally {
      server.close()
    }
  }

  // Dropped mid-head.
  {
    const { port, server } = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nConte")
      socket.end()
    })
    try {
      await assert.rejects(
        () => rawGet(port),
        /connection closed before response head/,
        "a dropped head must error",
      )
    } finally {
      server.close()
    }
  }

  // EOF-framed body (no length header): the connection's end is the frame —
  // short reads are the normal case and the body completes.
  {
    const { port, server } = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
      socket.write("data: hi\n\n")
      socket.end()
    })
    try {
      const response = await rawGet(port)
      assert.equal((await readAllBody(response.body)).toString(), "data: hi\n\n", "an EOF-framed body completes")
    } finally {
      server.close()
    }
  }

  // A complete chunked stream (terminal chunk, then close) still round-trips.
  {
    const { port, server } = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
      socket.write("5\r\nhello\r\n")
      socket.write("3\r\n---\r\n")
      socket.write("0\r\n\r\n")
      socket.end()
    })
    try {
      const response = await rawGet(port)
      assert.equal((await readAllBody(response.body)).toString(), "hello---", "a complete chunked body round-trips")
    } finally {
      server.close()
    }
  }
}

console.log("TRANSPORT OK: header order/casing, session-id scheme, no static org stamps, decoder lockstep, raw-http EOF errors")
