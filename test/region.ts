// Account-scoped denials must leave the stream classified as
// credential-rotatable (403) with actionable guidance — otherwise the session
// pins the broken account and every retry lands on it.

// Isolate HOME before the verdicts sidecar loads: these tests write verdicts,
// and they must never touch the real ~/.omp state.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
process.env.HOME = mkdtempSync(path.join(tmpdir(), "omp-go-region-test-"))

import assert from "node:assert/strict"
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { mapRegionGateErrors } from "../src/region"
import { accountVerdict, clearAccountVerdicts, markAccountVerdict, orgVerdict, VERDICT_TTL_MS } from "../src/verdicts"
import { opencodeGoUsageProvider } from "../src/usage"

async function failureOf(source: AssistantMessageEventStream) {
  try {
    for await (const _event of source) {
      // drain
    }
    await source.result()
    return undefined
  } catch (error) {
    return error as { status?: number; message?: string; headers?: Record<string, unknown>; cause?: unknown }
  }
}

// 402 "Insufficient account funds" -> rotation lane + account guidance
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 402, message: "Upstream request failed: Insufficient account funds", type: "server_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 403, "402 promotes to the credential-rotation lane")
  assert.match(error?.message ?? "", /member verdict/, "explains it is account-scoped")
  // Contract: the THROWN error must stay outside pi-ai's usage-limit classifier
  // vocabulary (funds/quota/limit/plan/balance/...). Billing-cap wording on a
  // 402 (is402BillingCapBody) parks omp's turn-recovery on a ~24-minute window
  // and fails fast ("Provider requested ...ms wait, exceeds retry.maxDelayMs")
  // instead of rotating. The honest upstream wording lives in the verdict
  // record, not the thrown message.
  assert.doesNotMatch(error?.message ?? "", /funds|balance|quota|plan|billing|spend|credit/i, "thrown message avoids the billing-cap classifier")
  assert.match(error?.message ?? "", /capacity/, "thrown message classifies into the short transient backoff lane")
  const idCarrier = error as { id?: unknown } | null
  if (typeof idCarrier?.id === "number") {
    assert.equal(idCarrier.id & 0x0008_0000, 0, "UsageLimit flag cleared on the thrown error")
  }
}

// 403 "Workspace access denied" -> guidance, stays rotatable
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 403, message: "Workspace access denied", type: "permission_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 403)
  assert.match(error?.message ?? "", /member verdict/)
  assert.doesNotMatch(error?.message ?? "", /funds|balance|quota|plan|billing|spend|credit/i, "thrown message avoids the billing-cap classifier")
  assert.match(error?.message ?? "", /capacity/, "thrown message classifies into the short transient backoff lane")
}

// Wait hints leave with the verdict: the gateway's retry-after on a 402
// describes the ACCOUNT's window reset (~28 min), not this request. Left on
// the error object, omp's turn-recovery takes its fail-fast exit ("Retry
// failed: Provider requested …ms wait, exceeds retry.maxDelayMs") instead of
// retrying into a healthy sibling — the exact surfaced failure.
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  const cause = { headers: { "retry-after-ms": "1710878", "x-ratelimit-reset": "1711" } }
  src.fail({
    status: 402,
    message: "Upstream request failed: Insufficient account funds",
    type: "server_error",
    headers: { "retry-after-ms": "1710878", "content-type": "application/json" },
    cause,
  })
  const error = await failureOf(out)
  assert.equal(error?.status, 403, "still promoted to the rotation lane")
  assert.equal(error?.headers?.["retry-after-ms"], undefined, "top-level wait hints stripped")
  assert.equal(error?.headers?.["content-type"], "application/json", "non-hint headers preserved")
  assert.equal((cause.headers as Record<string, unknown>)["retry-after-ms"], undefined, "cause-chain hints stripped")
}

// Region gate keeps its own guidance and rotation
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 400, message: "This model requires Global regions for this workspace", type: "server_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 403, "region gate still rotates")
  assert.match(error?.message ?? "", /Privacy → Global/)
}

// Unrelated 4xx keep their own meaning (no over-promotion)
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 429, message: "Upstream request failed: rate limited", type: "server_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 429, "rate limits are not credential verdicts")
  assert.doesNotMatch(error?.message ?? "", /account verdict/)
}

// Verdict feedback: gate failures must demote the account in health checks.
{
  clearAccountVerdicts()
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src, "token-b")
  src.fail({ status: 402, message: "Upstream request failed: Insufficient account funds", type: "server_error" })
  await failureOf(out)
  assert.equal(accountVerdict("token-b")?.kind, "funds", "402 records a funds verdict for the serving token")
  assert.equal(accountVerdict("token-a"), undefined, "other accounts unaffected")

  // The usage/health layer must fail loudly on a token with a fresh verdict —
  // even when its usage endpoint answers fine (the observed "0% used" account).
  const provider = opencodeGoUsageProvider({ session: { session: "ses_x", affinity: "ses_x", project: "p", client: "cli" }, identity: { channel: "latest", version: "2.0.26", name: "cli" } })
  const ctx = {
    fetch: async () => new Response(JSON.stringify({ usage: { windows: {} } }), { status: 200 }),
    previousReport: undefined,
  }
  let thrown: Error | undefined
  try {
    await provider.fetchUsage(
      { provider: "opencode-go", credential: { type: "api_key", apiKey: "token-b" }, baseUrl: "https://opencode.ai/zen/go" },
      ctx as never,
    )
  } catch (error) {
    thrown = error as Error
  }
  assert.ok(thrown, "usage fails loudly for a verdict-marked account (demotes it in the pool)")
  assert.match(thrown?.message ?? "", /account verdict from inference: account cannot serve/)

  // Healthy tokens are unaffected by the verdict layer.
  const report = await provider.fetchUsage(
    { provider: "opencode-go", credential: { type: "api_key", apiKey: "token-a" }, baseUrl: "https://opencode.ai/zen/go" },
    ctx as never,
  )
  assert.ok(report !== undefined, "healthy account still reports")

  // TTL: verdicts expire so a topped-up account heals itself.
  markAccountVerdict("token-c", { kind: "funds", message: "m", at: Date.now() - VERDICT_TTL_MS - 1000 })
  assert.equal(accountVerdict("token-c"), undefined, "expired verdict clears")
  clearAccountVerdicts()
}

console.log("ACCOUNT-GATE OK: denials rotate, demote the account in health, and heal on TTL")

// The verdict MUST land under a stable key even when the token->org index is
// empty: a silently dropped verdict meant "no rotation ever happens" - every
// retry walked back into the same dry account while verdicts.json stayed empty.
{
  clearAccountVerdicts()
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src, "tok-secret-abcdef", "org_known")
  src.fail({ status: 402, message: "Upstream request failed: Insufficient account funds", type: "server_error" })
  await failureOf(out)
  const landed = orgVerdict("org_known") ?? accountVerdict("token:abcdef")
  assert.ok(landed, "gate failure lands a verdict under a stable key")
  assert.equal(landed?.kind, "funds")
}

// Numeric wait fields must not survive: the host parses a provider wait out of
// the serialized error (#parseRetryAfterMsFromError) and fail-fasts on it
// ("Provider requested 1732329ms wait, exceeds retry.maxDelayMs") whenever no
// credential switch follows. The gateway body carries `retryAfterMs` as a
// NUMBER - text rewrites never touched it.
{
  clearAccountVerdicts()
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src, "tok-secret-abcdef", "org_known")
  src.fail({
    status: 402,
    message: "Upstream request failed: Insufficient account funds",
    type: "server_error",
    retryAfterMs: 1732329,
    data: { error: { code: "funds", retryAfterMs: 1732329, waitTimeMs: 1732329, resetAt: 1792028239109 } },
  })
  const error = await failureOf(out)
  const serialized = JSON.stringify(error ?? {})
  assert.doesNotMatch(serialized, /1732329/, "no parsed wait may survive in the thrown error")
  assert.doesNotMatch(serialized, /retryAfterMs|waitTimeMs|resetAt/i, "wait-typed fields are removed")
  assert.doesNotMatch(error?.message ?? "", /retry[ =:]+\d/i, "no retry-after text in the message")
}
