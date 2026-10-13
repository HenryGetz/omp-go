// Region-gate error shaping.
//
// A Go model that requires Global regions fails with `400 {message}` from the
// gateway when the serving workspace's Privacy setting is not Global. That is
// an account-scoped policy denial — "a sibling account may not share it" in
// omp's own classification terms (`error/auth-classify.ts`) — but its 400
// status keeps it out of the credential-rotation lane, so the session pins the
// bad account and every retry lands on the same workspace.
//
// Reshaping the error to the 403 credential-rotation lane (`isAuthRetryableError`
// matches 401/403 unconditionally) makes omp rotate to a sibling account
// mid-turn when the pool has one, and the rewritten message tells the user
// exactly which workspace to fix when it does not.

import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai"
// Package root, never a `./utils/*` catch-all path: omp's extension loader
// only rewrites explicit package exports (same rule as the streamSimple import).
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai"

const REGION_GATE = /requires\s+Global\s+regions|Privacy settings/i
const ROTATION_STATUS = 403

function regionGateSuffix(): string {
  return (
    " (This is workspace policy, not a bad login: set Privacy → Global for this workspace in the " +
    "opencode Console, or /logout that account. omp rotates to a healthy account when the pool has one.)"
  )
}

/** Rewrite any message/status fields that carry the region gate, recursively. */
function reshape<T>(value: T): T {
  if (typeof value === "string") return (REGION_GATE.test(value) ? value + regionGateSuffix() : value) as T
  if (Array.isArray(value)) return value.map((item) => reshape(item)) as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "status" || key === "errorStatus") && typeof entry === "number" && entry >= 400 && entry < 500) {
        // Only promote gate-shaped failures; other 4xx keep their own meaning.
        out[key] = REGION_GATE.test(JSON.stringify(value)) ? ROTATION_STATUS : entry
      } else {
        out[key] = reshape(entry)
      }
    }
    return out as T
  }
  return value
}

/**
 * Wrap a provider stream so region-gate failures leave it classified as
 * credential-rotatable (403) and self-explanatory. Stream semantics are
 * preserved: events, final result, and failures all forward unchanged apart
 * from the reshaped error payloads.
 */
export function mapRegionGateErrors(source: ReturnType<typeof createAssistantMessageEventStream>) {
  const out = createAssistantMessageEventStream()
  void (async () => {
    try {
      for await (const event of source) out.push(reshape(event) as AssistantMessageEvent)
      out.end(await source.result())
    } catch (error) {
      out.fail(reshape(error))
    }
  })()
  out.forwardLocalWorkFrom(source)
  return out
}
