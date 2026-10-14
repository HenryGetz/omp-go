// Account-scoped denials must leave the stream classified as
// credential-rotatable (403) with actionable guidance — otherwise the session
// pins the broken account and every retry lands on it.

import assert from "node:assert/strict"
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { mapRegionGateErrors } from "../src/region"
import { accountVerdict, clearAccountVerdicts, markAccountVerdict, VERDICT_TTL_MS } from "../src/verdicts"
import { opencodeGoUsageProvider } from "../src/usage"

async function failureOf(source: AssistantMessageEventStream) {
  try {
    for await (const _event of source) {
      // drain
    }
    await source.result()
    return undefined
  } catch (error) {
    return error as { status?: number; message?: string }
  }
}

// 402 "Insufficient account funds" -> rotation lane + account guidance
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 402, message: "Upstream request failed: Insufficient account funds", type: "server_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 403, "402 promotes to the credential-rotation lane")
  assert.match(error?.message ?? "", /account verdict/, "explains it is account-scoped")
  assert.match(error?.message ?? "", /Insufficient account funds/, "keeps the upstream message")
}

// 403 "Workspace access denied" -> guidance, stays rotatable
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src)
  src.fail({ status: 403, message: "Workspace access denied", type: "permission_error" })
  const error = await failureOf(out)
  assert.equal(error?.status, 403)
  assert.match(error?.message ?? "", /account verdict/)
  assert.match(error?.message ?? "", /not a member of this workspace/)
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
