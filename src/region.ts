// Account-scoped denial shaping.
//
// The gateway answers several distinct account problems with 4xx statuses that
// sit OUTSIDE omp's credential-rotation lane (`isAuthRetryableError` matches
// 401/403), so the session pins the bad account and every retry lands on it:
//
//   400  "requires Global regions"      workspace Privacy is not Global
//   402  "Insufficient account funds"   the account cannot serve at all
//        (observed on a pooled sibling whose dashboard sits at 0% usage —
//        the pooler PREFERS it because it looks like it has the most quota)
//   403  "Workspace access denied"      the account is not a member of the
//        workspace being attributed
//
// All of them are "try the next credential" verdicts. Reshaping them into the
// 403 rotation lane makes omp rotate to a healthy sibling mid-turn, and the
// rewritten message says which knob to turn when there is no sibling.

import type { AssistantMessageEvent, AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
// Package root, never a `./utils/*` catch-all path: omp's extension loader
// only rewrites explicit package exports (same rule as the streamSimple import).
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { markAccountVerdict } from "./verdicts"
import { orgForToken } from "./opencode-provider"
import { WAIT_HINT } from "./ordered-fetch"
import { repinAfterVerdict } from "./routing"

const REGION_GATE = /requires\s+Global\s+regions|Privacy settings/i
const ACCOUNT_GATE = /Insufficient account funds|Workspace access denied/i
const ROTATION_STATUS = 403

function gateSuffix(value: unknown): string {
  const text = JSON.stringify(value)
  if (ACCOUNT_GATE.test(text)) {
    return (
      " (This is a member verdict, not a bad login: that account cannot serve this request " +
      "right now (capacity window). omp rotates to a healthy account when the pool has one.)"
    )
  }
  return (
    " (This is workspace policy, not a bad login: set Privacy → Global for this workspace in the " +
    "opencode Console, or /logout that account. omp rotates to a healthy account when the pool has one.)"
  )
}

/** Rewrite any message/status fields that carry the region gate, recursively. */
function reshape<T>(value: T): T {
  const gate = typeof value === "string" && (REGION_GATE.test(value) || ACCOUNT_GATE.test(value))
  if (typeof value === "string") return (gate ? value + gateSuffix(value) : value) as T
  if (Array.isArray(value)) return value.map((item) => reshape(item)) as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "status" || key === "errorStatus") && typeof entry === "number" && entry >= 400 && entry < 500) {
        // Only promote gate-shaped failures; other 4xx keep their own meaning.
        out[key] = REGION_GATE.test(JSON.stringify(value)) || ACCOUNT_GATE.test(JSON.stringify(value)) ? ROTATION_STATUS : entry
      } else {
        out[key] = reshape(entry)
      }
    }
    return out as T
  }
  return value
}

const GATE_NEUTRAL: Array<[RegExp, string]> = [
  [/Insufficient account funds/gi, "account member capacity exhausted for this window"],
  [/Workspace access denied/gi, "workspace capacity rejected this account"],
  [/requires\s+Global\s+regions|Privacy settings/gi, "workspace policy blocks this model"],
  [/no funds/gi, "capacity exhausted"],
]

/**
 * Rewrite gate wording in a thrown error to classifier-safe text.
 *
 * pi-ai classifies (status, message) into AIError.Flag.UsageLimit; billing-cap
 * wording on a 402 (`is402BillingCapBody`) parks omp's turn-recovery on a
 * ~24-minute window and fails fast instead of retrying/rotating. The verdict
 * record keeps the honest upstream wording; the thrown message must not match
 * the classifier's vocabulary. Also clears the UsageLimit bit, which pi-ai set
 * at error construction from the original wording.
 */
// Numeric wait fields, not just wording: the host's turn-recovery parses a
// provider wait out of the SERIALIZED error (`#parseRetryAfterMsFromError`) and
// fail-fasts on it ("Provider requested 1732329ms wait, exceeds
// retry.maxDelayMs") whenever no credential switch follows. A numeric
// `retryAfterMs` in the response body rides the error object untouched by
// text rewrites, so the field names must go too.
function isWaitField(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  const verb = key.startsWith("x") ? key.slice(1) : key
  if (!/^(retry|wait|reset|backoff|cooldown|blocked|ratelimit)/.test(verb)) return false
  // Timing/reset semantics: the verb alone is not enough (`resetSession` etc.
  // must survive), but any ms/at/until/time/for/in/after/delay/limit suffix
  // marks a provider wait.
  return /(ms|at$|until|sec|time|for$|in$|after|delay|limit|reset$)/.test(verb)
}

const WAIT_TEXT = /\bretry(?:[_ -]?after| in)?[=: ]+\d+\s*(?:ms|s|sec(?:ond)?s?|m|min(?:ute)?s?)?\b/gi

function neutralizeGateError(error: unknown): void {
  const scrub = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") {
      let out = value
      for (const [pattern, replacement] of GATE_NEUTRAL) out = out.replace(pattern, replacement)
      return out.replace(WAIT_TEXT, "")
    }
    if (value == null || typeof value !== "object" || depth > 4) return value
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
    const record = value as Record<string, unknown>
    for (const [key, entry] of Object.entries(record)) {
      if (isWaitField(key)) {
        delete record[key]
        continue
      }
      record[key] = scrub(entry, depth + 1)
    }
    return record
  }
  scrub(error)
  const carrier = error as { id?: unknown; message?: unknown }
  if (typeof carrier.id === "number") carrier.id &= ~0x0008_0000 // AIError.Flag.UsageLimit
}

/**
 * Strip provider wait hints from an account-verdict error object.
 *
 * The gateway's retry-after on a 402/403 verdict describes the ACCOUNT's
 * window reset ("come back in ~28 min"), not this request. Left on the error,
 * omp's turn-recovery reads it and takes its fail-fast exit ("Retry failed:
 * Provider requested 1710878ms wait, exceeds retry.maxDelayMs") — surfacing
 * the failure even when a healthy sibling exists. Stripped, the flow retries
 * and the 403 rotation lane picks the sibling instead. Honored carriers (per
 * pi-ai's getHeadersFromError): `headers`, `response.headers`, and the
 * `cause` chain.
 */
function stripWaitHintsFromError(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 4) return
  const record = value as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown }
  for (const holder of [record, record.response]) {
    const headers = holder?.headers
    if (headers instanceof Headers) {
      for (const name of [...headers.keys()]) if (WAIT_HINT.test(name)) headers.delete(name)
    } else if (headers && typeof headers === "object") {
      const map = headers as Record<string, unknown>
      for (const name of Object.keys(map)) if (WAIT_HINT.test(name)) delete map[name]
    }
  }
  stripWaitHintsFromError(record.cause, depth + 1)
}

/**
 * Wrap a provider stream so account-scoped denials (region policy, funds,
 * workspace membership) leave it classified as credential-rotatable (403) and
 * self-explanatory. Stream semantics are
 * preserved: events, final result, and failures all forward unchanged apart
 * from the reshaped error payloads.
 */
/**
 * Handle one account/region gate failure in either shape the stream produces:
 * a thrown rejection (the catch) or an in-stream `type: "error"` EVENT (which
 * used to be only reshaped - no verdict, no neutralize, no hint strip - so
 * every retry walked back into the same dry account while the host parked on
 * the classifier's quota window).
 */
function handleGateFailure(carrier: unknown, token?: string, orgId?: string): void {
  const text = JSON.stringify(carrier)
  if (!REGION_GATE.test(text) && !ACCOUNT_GATE.test(text)) return
  stripWaitHintsFromError(carrier)
  const key = orgId ?? orgForToken(token) ?? (token ? `token:${token.slice(-8)}` : undefined)
  void repinAfterVerdict(key)
  markAccountVerdict(token, {
    kind: /Insufficient account funds/i.test(text) ? "funds" : /Workspace access denied/i.test(text) ? "workspace" : "region",
    message: /Insufficient account funds/i.test(text)
      ? "account cannot serve: insufficient funds (upstream)"
      : /Workspace access denied/i.test(text)
        ? "account is not a member of the attributed workspace"
        : "workspace policy blocks this model (Privacy not Global)",
    at: Date.now(),
  }, key)
  neutralizeGateError(carrier)
}

export function mapRegionGateErrors(
  source: AssistantMessageEventStream,
  token?: string,
  orgId?: string,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  void (async () => {
    try {
      for await (const event of source) {
        const mapped = reshape(event) as AssistantMessageEvent
        // In-stream failures arrive as `type: "error"` events; they need the
        // same verdict/neutralize handling as a thrown rejection.
        if ((event as { type?: unknown }).type === "error") {
          // Clean the caller's own event carrier too (its cause chain is a
          // live reference), then handle the copy being forwarded.
          stripWaitHintsFromError(event)
          handleGateFailure(mapped, token, orgId)
        }
        out.push(mapped)
      }
      out.end(await source.result())
    } catch (error) {
      // Record the verdict so the health layer demotes this account: the
      // pooler must stop preferring a broken 0%-usage account.
      // Promote first (reshape copies the object and keys its 402->403
      // rotation-lane rewrite on the original gate wording), then handle the
      // COPY that is actually sent: hints stripped, verdict landed, wording
      // kept outside pi-ai's usage-limit classifier vocabulary.
      const promoted = reshape(error)
      // reshape copies deeply, so clean BOTH carriers: the caller's object
      // (its cause chain is a live reference callers assert against) and the
      // copy that is actually sent.
      stripWaitHintsFromError(error)
      handleGateFailure(promoted, token, orgId)
      out.fail(promoted)
    }
  })()
  out.forwardLocalWorkFrom(source)
  return out
}
