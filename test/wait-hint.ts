// The reported fail-fast ("Retry failed after 1 attempts: Provider requested
// 1732329ms wait, exceeds retry.maxDelayMs (300000ms)") is omp's turn-recovery
// computing a wait and refusing to retry past retry.maxDelayMs. Two sources
// feed that wait: a parsed provider hint, or the classifier's heuristic backoff
// (parseRateLimitReason -> calculateRateLimitBackoffMs - an UNRECOGNIZED
// message lands in UNKNOWN, whose default backoff is 1800000ms = the 30-minute
// park). The reported 1732329ms is a window-remaining wait in the same class.
//
// Contract for verdict errors: no parseable provider hint, AND a classification
// whose backoff stays UNDER retry.maxDelayMs so the retry proceeds and the org
// rotation serves the healthy sibling.

import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
process.env.HOME = mkdtempSync(path.join(tmpdir(), "omp-go-wait-hint-test-"))

import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after"
import { parseRateLimitReason, calculateRateLimitBackoffMs } from "@oh-my-pi/pi-ai/error/rate-limit"
import { mapRegionGateErrors } from "../src/region"

const MAX_DELAY_MS = 300_000 // the user's retry.maxDelayMs

async function failureOf(source: AssistantMessageEventStream) {
  try {
    for await (const _event of source) {
      // drain
    }
    await source.result()
    return undefined
  } catch (error) {
    return error
  }
}

function gatewayError() {
  return {
    status: 402,
    message: "Upstream request failed: Insufficient account funds",
    type: "server_error",
    retryAfterMs: 1732329,
    data: { error: { code: "funds", message: "Upstream request failed: Insufficient account funds", retryAfterMs: 1732329, waitTimeMs: 1732329 } },
  }
}

// 1. REPRODUCTION of the failure class: the RAW gateway error classifies into a
//    wait that exceeds retry.maxDelayMs -> the host fail-fasts exactly as
//    reported instead of retrying into the healthy sibling.
{
  const raw = gatewayError()
  const rawText = `${String(raw.message)}\n${JSON.stringify(raw)}`
  const parsed = extractProviderRetryHint("opencode-go", rawText)
  const reason = parseRateLimitReason(rawText)
  const backoff = calculateRateLimitBackoffMs(reason)
  assert.ok(backoff > MAX_DELAY_MS, `raw error reproduces the fail-fast class (${reason} -> ${backoff}ms wait > ${MAX_DELAY_MS}ms)`)
}

// 2. FIX: the handled verdict error exposes NO parseable hint and classifies
//    into the short transient lane (backoff under the cap) - the retry proceeds.
{
  const src = createAssistantMessageEventStream()
  const out = mapRegionGateErrors(src, "tok-secret-abcdef", "org_known")
  src.fail(gatewayError())
  const error = await failureOf(out)
  const text = `${String((error as { message?: unknown })?.message ?? "")}\n${JSON.stringify(error)}`
  const parsed = extractProviderRetryHint("opencode-go", text)
  assert.equal(parsed, undefined, "handled verdict error exposes no provider wait to the hint parser")
  const reason = parseRateLimitReason(text)
  const backoff = calculateRateLimitBackoffMs(reason)
  assert.ok(backoff <= MAX_DELAY_MS, `handled error must stay under retry.maxDelayMs (${reason} -> ${backoff}ms)`)
  console.log(`WAIT-HINT OK: raw class -> fail-fast (>${MAX_DELAY_MS}ms); handled class -> ${reason} (${backoff}ms) with no parsed hint`)
}
