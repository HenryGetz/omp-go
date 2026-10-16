// Account rotation on member-capacity verdicts: the pinned/exhausted account
// answers 403/402, the pool's healthy sibling must take the NEXT attempt and
// the request must leave with ONLY the serving credential's own org stamp.
//
// Reproduces the production failure of 2026-10-16 (17× 403 "Workspace access
// denied" on the healthy account, a verdict mis-filed against it, and every
// pin glued to the Weekly-100% account): the projection-time Console snapshot
// stamps the FIRST credential's org into the model's resolved headers (host
// model-registry.ts #applyRuntimeModelModifiers composes [sessionHeaders,
// projectionHeaders] with the LATER source winning), while the rotated attempt
// carries the OTHER account's bearer — a bearer paired with a foreign org
// stamp is exactly what the gateway answers 402/403 on.
//
// Gateway contract mirrored here (per the observed ledger + gateway wording):
//   bearer + foreign/missing org stamp -> 403 "Workspace access denied"
//   exhausted account + its own stamp  -> 402 "Insufficient account funds"
//   healthy account + its own stamp    -> 200
//
// The seam: CONSOLE_BASE_ENV / GO_BASE_ENV (src/register.ts) point the Console
// and the gateway at an in-process stub; the api-key resolver mirrors the
// host's auth-retry driver (initial resolve → rotate to sibling → pool spent).
//
//   bun test/rotation.ts

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
process.env.HOME = mkdtempSync(path.join(tmpdir(), "omp-go-rotation-test-"))

import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry"
import { streamSimple } from "@oh-my-pi/pi-ai"
import type { AssistantMessageEventStream, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo } from "../src/register"
import { refreshConsoleConfig } from "../src/console-config"
import { orgVerdict } from "../src/verdicts"
import { chooseAccount, noteServedOrg, noteUsageOrg, pinNewSession } from "../src/routing"
import { clearAccountVerdicts } from "../src/verdicts"

clearAccountVerdicts()

// ─── stub Console + gateway ─────────────────────────────────────────────────
// Two accounts: A (org A) is member-capacity exhausted — every request on its
// bearer answers the gateway's 403 member verdict; B (org B) is healthy but
// ONLY under its own org stamp (a foreign/missing stamp on B's bearer is the
// attribution failure the pool rotated into — 402 member capacity).

const ORG_A = "org_CAPACITYEXHAUSTED0000000000000"
const ORG_B = "org_HEALTHYMEMBER00000000000000000"
const TOKEN_A = "tok_rotation_account_a"
const TOKEN_B = "tok_rotation_account_b"
/** The console-reported reset horizon of A's exhausted window ("2d 12h"). */
const WINDOW_RESET_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000

type Attempt = { bearer: string | undefined; org: string | undefined; url: string }
const attempts: Attempt[] = []

const orgOfBearer = (bearer: string | undefined): string | undefined =>
  bearer === TOKEN_A ? ORG_A : bearer === TOKEN_B ? ORG_B : undefined

const send = (res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }, status: number, payload: unknown) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) })
  res.end(body)
}

const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")
    const url = new URL(req.url ?? "/", "http://127.0.0.1").pathname
    if (req.method === "GET" && url === "/console/api/v2/config") {
      // Realistic Console push: the per-org attribution header + config-driven
      // endpoint (capture/stub-console.mjs, capture/golden-requests.ndjson).
      const orgId = orgOfBearer(bearer)
      return send(res, 200, {
        providers: {
          "opencode-go": {
            name: "Rotation Stub / OpenCode Go",
            settings: { baseURL: goBase },
            headers: { "x-opencode-org-id": orgId },
            models: {},
          },
          opencode: {
            name: "Rotation Stub / OpenCode",
            settings: { baseURL: goBase },
            headers: { "x-opencode-org-id": orgId },
            models: {},
          },
        },
      })
    }
    if (req.method === "POST" && url === chatPath) {
      attempts.push({ bearer, org: req.headers["x-opencode-org-id"] as string | undefined, url })
      const stamped = req.headers["x-opencode-org-id"]
      // Membership first: a bearer stamped with ANY org that is not its own
      // (foreign projection-time stamp, or none at all) is a pairing failure —
      // the gateway's "Workspace access denied" (the observed 17×403).
      if (stamped !== orgOfBearer(bearer))
        return send(res, 403, {
          error: { type: "permission_error", message: "Workspace access denied" },
        })
      // Exhausted member under its own stamp: the capacity window verdict.
      // The message carries the window's own reset horizon ("resets in 2d 12h",
      // the console's wording) plus the numeric body fields — the verdict must
      // persist at least that long.
      if (bearer === TOKEN_A)
        return send(res, 402, {
          error: {
            type: "server_error",
            message: "Upstream request failed: Insufficient account funds (resets in 2d 12h)",
          },
          retryAfterMs: WINDOW_RESET_MS,
          data: { error: { code: "funds", resetAt: Date.now() + WINDOW_RESET_MS } },
        })
      // Healthy member under its own stamp: serves.
      if (bearer === TOKEN_B && stamped === ORG_B) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-rotation",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "mimo-v2.6-pro",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        res.write(chunk({ role: "assistant", content: "Hello from healthy account" }, null))
        res.write(chunk({}, "stop"))
        res.write("data: [DONE]\n\n")
        return res.end()
      }
      return send(res, 500, { error: { type: "server_error", message: "unexpected stub state" } })
    }
    return send(res, 404, { error: "not_found", path: url })
  })
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as AddressInfo).port
const consoleBase = `http://127.0.0.1:${port}/console`
const goBase = `http://127.0.0.1:${port}/zen/go/v1`
const chatPath = `${new URL(goBase).pathname}/chat/completions`
process.env.OMP_GO_CONSOLE = consoleBase
process.env.OMP_GO_BASE = goBase
process.env.OMP_GO_FREE = `http://127.0.0.1:${port}/zen/v1`
const orgDebug = path.join(process.env.HOME!, "org-debug.ndjson")
process.env.OMP_ORG_DEBUG = orgDebug

// ─── register through the real extension seam (parity-style fake `pi`) ──────

const registered = new Map<string, ProviderConfig>()
const fakePi = {
  registerProvider: (name: string, config: ProviderConfig) => registered.set(name, config),
  registerTool: () => undefined,
  getActiveTools: () => ["read", "edit", "glob", "grep", "write"],
  setActiveTools: () => undefined,
  on: () => undefined,
} as unknown as ExtensionAPI
registerOpencodeGo(fakePi)
const config = registered.get("opencode-go")
assert.ok(config?.streamSimple && config.oauth?.modifyModels, "opencode-go registered with streamSimple + modifyModels")

// ─── window-exhaustion re-pin: pins must move off a spent account ───────────
// Production state that motivated this: 69/69 session pins pointed at the
// Weekly-100% account and NOTHING ever moved them — no verdict landed on that
// org (the mispairing verdict was filed against the healthy one), so the
// verdict-driven re-pin was a guaranteed no-op. A usage poll reporting 100%
// must re-pin exactly like a verdict, and a spent window must never win
// selection on its own.
{
  const pinCalls: Array<{ sessionId: string; credentialId: number }> = []
  const accounts = [
    { credentialId: 13, orgId: ORG_A },
    { credentialId: 14, orgId: ORG_B },
  ]
  // Fake host auth storage: pinNewSession/repinAfterVerdict only reach
  // oauth.accounts / sessions.pin / health.model.
  const fakeAuth = {
    oauth: { accounts: () => accounts },
    sessions: {
      pin: (_provider: string, sessionId: string, credentialId: number) => {
        pinCalls.push({ sessionId, credentialId })
        return true
      },
    },
    health: {
      model: async () => {
        throw new Error("no health in the rotation stub")
      },
    },
  }
  const fakeApi = { pi: { discoverAuthStorage: async () => fakeAuth } } as unknown as ExtensionAPI

  noteServedOrg(ORG_A) // A was the warm leader when the session pinned
  noteUsageOrg(ORG_B, 0.39) // sibling headroom (production numbers)

  assert.equal(
    chooseAccount([
      { credentialId: 13, orgId: ORG_A, usedPct: 1 },
      { credentialId: 14, orgId: ORG_B, usedPct: 0.39 },
    ]),
    14,
    "a 100%-used window never wins selection",
  )

  assert.equal(await pinNewSession(fakeApi, "ses_window_repin"), true, "fresh session pins to the warm leader")
  const pinsPath = path.join(process.env.HOME!, ".omp", "agent", "omp-go-pins.json")
  const pinsOf = () =>
    JSON.parse(readFileSync(pinsPath, "utf8")) as Array<{ sessionId: string; orgId?: string; credentialId: number }>
  assert.equal(pinsOf()[0]?.credentialId, 13, "pinned to the (then-warm) leader")

  // The window hits 100%: the usage poll must move the pin to the sibling.
  noteUsageOrg(ORG_A, 1)
  const deadline = Date.now() + 5_000
  while (pinsOf().some((pin) => pin.credentialId === 13) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25))
  const pins = pinsOf()
  assert.equal(pins[0]?.credentialId, 14, "window-exhausted account's pin moved to the healthy sibling")
  assert.equal(pins[0]?.orgId, ORG_B, "moved pin carries the healthy org")
  assert.ok(
    pinCalls.some((call) => call.sessionId === "ses_window_repin" && call.credentialId === 14),
    "sessions.pin invoked with the healthy credential",
  )
}

// ─── per-attempt flow, exactly as the host drives it ────────────────────────
// 1) projection: the host projects the catalog through the CURRENT OAuth
//    credential (model-registry.ts #applyRuntimeModelModifiers → our
//    projectModels), after stamping provider/baseUrl like buildCustomModelOverlay.
// 2) request: streamSimple's auth-retry driver resolves the bearer per attempt
//    (initial → pinned/exhausted A; on the 403 → rotate → healthy B) and
//    re-enters the wire wrapper with that attempt's credentials.

const credentialA = {
  refresh: "rt_rotation_account_a",
  access: TOKEN_A,
  expires: Date.now() + 3600_000,
  accountId: "usr_rotation_a",
  email: "exhausted@example.com",
  orgId: ORG_A,
  orgName: "Capacity Org",
  apiEndpoint: consoleBase,
}
// Seed A's Console snapshot so the projection resolves an EXACT (stamped)
// snapshot for its org — the stale-stamp precondition.
await refreshConsoleConfig({ consoleBase, token: TOKEN_A, orgId: ORG_A })

const row = config.models!.find((model) => model.id === "mimo-v2.6-pro")
assert.ok(row, "mimo-v2.6-pro present in the catalog")
const projected = config.oauth!.modifyModels!(
  [Object.assign(Object.create(Object.getPrototypeOf(row)), row, {
    provider: "opencode-go",
    baseUrl: goBase,
    headers: { "user-agent": "opencode/latest/2.0.26/cli" },
  })],
  credentialA as never,
)[0]
assert.equal(projected.api, "opencode-go-wire", "projection keeps the wire wrapper api")
// Pre-fix this record carried `x-opencode-org-id: ORG_A` (the projection
// credential's org) and rode model.headers onto EVERY attempt — the stale
// stamp the gateway answered 403/402 on. The projection stays org-neutral now.
assert.equal(
  projected.headers?.["x-opencode-org-id"],
  undefined,
  "projection never stamps an org into the model; wireStream stamps per attempt",
)
// The host registry composes resolveHeaders [session, projection] — later wins
// (model-registry.ts:1128), so the projection's org stamp is what the request
// resolves. Replicate that composition (host internals are not importable).
const projectedHeaders = projected.headers
const sessionResolve = projected.resolveHeaders
const model = {
  ...projected,
  headers: undefined,
  resolveHeaders: async (signal?: AbortSignal) => ({
    ...((await sessionResolve?.(signal)) ?? {}),
    ...projectedHeaders,
  }),
}

registerCustomApi(config.api!, config.streamSimple!, "rotation-test", (m, context, options) =>
  config.streamSimple!(m, context, options as SimpleStreamOptions),
)

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }

// The host's resolver contract (config/api-key-resolver.ts): initial resolve →
// session-sticky credential; on an account verdict → rotate to a sibling; a
// second rotation with the pool spent → undefined (no more accounts).
let rotatedOnce = false
const resolver = async ({ lastChance, error }: { lastChance: boolean; error: unknown }) => {
  if (error === undefined) return { apiKey: TOKEN_A, credentialId: 1, oauthIdentity: { orgId: ORG_A } }
  if (lastChance && !rotatedOnce) {
    rotatedOnce = true
    return { apiKey: TOKEN_B, credentialId: 2, oauthIdentity: { orgId: ORG_B } }
  }
  return undefined
}

const watchdog = setTimeout(() => {
  console.error("ROTATION FAIL: request did not settle within 30s")
  process.exit(1)
}, 30_000)

let failure: unknown
let text = ""
const stream: AssistantMessageEventStream = streamSimple(model, context, { apiKey: resolver } as SimpleStreamOptions)
try {
  for await (const event of stream) {
    // In-stream failures arrive as events, not throws — the request's outcome
    // must see them (the catch below is the other shape).
    if (event.type === "error") {
      const err = event.error as { errorMessage?: string }
      failure ??= new Error(err.errorMessage ?? "stream error event")
    }
    if (event.type === "text_delta") text += event.delta
  }
  await stream.result()
} catch (error) {
  failure = error
}
clearTimeout(watchdog)
server.close()

// ─── evidence, printed before asserting (the pre-fix run reads as the repro) ─
console.log("attempts (bearer tail / org stamp / path):")
for (const [index, attempt] of attempts.entries())
  console.log(`  #${index + 1} bearer=...${(attempt.bearer ?? "none").slice(-6)} org=${attempt.org ?? "NONE"} ${attempt.url}`)
console.log(`outcome: ${failure === undefined ? `success "${text}"` : `failure: ${(failure as Error)?.message ?? JSON.stringify(failure)}`}`)

// 1) The rotated attempt reaches the healthy account and SUCCEEDS — with ONLY
//    the serving credential's own org stamp on the wire.
assert.equal(failure, undefined, "healthy sibling must serve the request after the member-capacity verdict")
assert.match(text, /Hello from healthy account/, "the healthy account's completion is delivered")
assert.equal(attempts.length, 2, "exactly one rotation: exhausted attempt + healthy attempt")
assert.equal(attempts[1]?.bearer, TOKEN_B, "second attempt carries the healthy bearer")
assert.equal(attempts[1]?.org, ORG_B, "rotated request carries EXACTLY the healthy account's org id")
assert.equal(attempts[0]?.org, ORG_A, "first attempt carries the exhausted account's own org id")

// 2) The verdict landed under the serving org with the window's reset horizon
//    persisted — it must not expire before the window does.
const verdict = orgVerdict(ORG_A)
assert.ok(verdict, "capacity verdict recorded for the exhausted org")
assert.equal(verdict.kind, "funds")
assert.ok(
  (verdict.until ?? 0) - verdict.at >= WINDOW_RESET_MS - 60_000,
  `verdict persists at least the reset horizon (until-at=${(verdict.until ?? 0) - verdict.at}ms)`,
)
assert.equal(orgVerdict(ORG_B), undefined, "healthy org carries no verdict")

// 3) While the verdict is live the exhausted account never wins selection —
//    the state mapping is pinNewSession's own (orgVerdict -> depleted).
assert.equal(
  chooseAccount([
    { credentialId: 1, orgId: ORG_A, state: orgVerdict(ORG_A) ? "depleted" : "healthy" },
    { credentialId: 2, orgId: ORG_B, usedPct: 0.19 },
  ]),
  2,
  "a verdict'd account ranks below the healthy sibling",
)

// 4) The per-attempt debug log proves the stamp pairings (no token values).
const debugLines = readFileSync(orgDebug, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { org?: string })
assert.deepEqual(
  debugLines.map((line) => line.org),
  [ORG_A, ORG_B],
  "OMP_ORG_DEBUG sees the exhausted org then the healthy org — one stamp per attempt",
)

console.log("ROTATION OK: verdict on the exhausted account rotates to the healthy sibling with its own org stamp only")
