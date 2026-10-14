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

const REGION_GATE = /requires\s+Global\s+regions|Privacy settings/i
const ACCOUNT_GATE = /Insufficient account funds|Workspace access denied/i
const ROTATION_STATUS = 403

function gateSuffix(value: unknown): string {
  const text = JSON.stringify(value)
  if (ACCOUNT_GATE.test(text)) {
    return (
      " (This is an account verdict, not a bad login: that account cannot serve this request " +
      "(no funds, or not a member of this workspace). omp rotates to a healthy account when the pool has one.)"
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

/**
 * Wrap a provider stream so account-scoped denials (region policy, funds,
 * workspace membership) leave it classified as credential-rotatable (403) and
 * self-explanatory. Stream semantics are
 * preserved: events, final result, and failures all forward unchanged apart
 * from the reshaped error payloads.
 */
export function mapRegionGateErrors(source: AssistantMessageEventStream, token?: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  void (async () => {
    try {
      for await (const event of source) out.push(reshape(event) as AssistantMessageEvent)
      out.end(await source.result())
    } catch (error) {
      // Record the verdict so the health layer demotes this account: the
      // pooler must stop preferring a broken 0%-usage account.
      const text = JSON.stringify(error)
      if (REGION_GATE.test(text) || ACCOUNT_GATE.test(text)) {
        markAccountVerdict(token, {
          kind: /Insufficient account funds/i.test(text) ? "funds" : /Workspace access denied/i.test(text) ? "workspace" : "region",
          message: /Insufficient account funds/i.test(text)
            ? "account cannot serve: insufficient funds (upstream)"
            : /Workspace access denied/i.test(text)
              ? "account is not a member of the attributed workspace"
              : "workspace policy blocks this model (Privacy not Global)",
          at: Date.now(),
        }, orgForToken(token))
      }
      out.fail(reshape(error))
    }
  })()
  out.forwardLocalWorkFrom(source)
  return out
}
