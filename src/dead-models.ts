// Runtime-learned model retirements — the ONE shared dead-model set.
//
// The gateway answers `410 Model <id> has been deprecated.` with
// `type=ModelDeprecated` when upstream retires a model. The embedded catalog
// snapshot and the host's 24h discovery cache both lag behind those
// rotations (2026-10-17: `muse-spark-1.3-contributor-free` was still being
// OFFERED by the picker after upstream had already retired it — the third
// roster rotation in two days), so any request failing with that signature
// marks the model dead HERE, at runtime: no manual set edits, no waiting for
// the next snapshot.
//
// Every roster surface derives from this one place: the provider model lists
// (src/models.ts `freeModels`/`catalogModels`, which feed both the
// registration-time `models:` and the `fetchDynamicModels` results) and the
// `/freeusage` row set (src/free-usage.ts `freeLaneIds`).
//
// Two copies, both cheap (the pattern src/verdicts.ts uses):
//   - in-memory: the marking process drops the model on the same request;
//   - persisted (`omp-go-dead-models.json`): every later omp process starts
//     with the retirement already learned. `deadModels()` re-reads the file
//     per call (it is tiny), so one process's mark reaches every other
//     process at its next roster derivation, without a restart.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
// Package root, never a `./utils/*` catch-all path: omp's extension loader
// only rewrites explicit package exports (same rule as register.ts).
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { withStateLock } from "./state-lock"

/**
 * Models the gateway rejects outright even though a catalog snapshot once
 * listed them live. Maintained by `bun test/gateway-sweep.ts` for the
 * HAND-VERIFIED cases only (when one recovers upstream, the sweep says so —
 * delete it here); every later retirement is learned at runtime by the
 * deprecation detector below and needs no edit. Verified dead 2026-10-14:
 * ling-3.0-flash-fin-free ("Model is unavailable"), exo-free
 * (`410 ModelDeprecated`).
 */
export const SEED_DEAD_MODELS = new Set(["ling-3.0-flash-fin-free", "exo-free"])

/** Marks learned from live failures this process has seen (durable twin below). */
const learnedDead = new Set<string>()

function deadFile(): string {
  return path.join(process.env.HOME || homedir(), ".omp", "agent", "omp-go-dead-models.json")
}

/** Tolerant read: `{ "<model id>": { "at": epochMs } }`, missing file = none. */
function persistedDead(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(deadFile(), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    const state: Record<string, number> = {}
    for (const [id, entry] of Object.entries(parsed)) {
      const at = typeof entry === "object" && entry !== null && "at" in entry ? (entry as { at?: unknown }).at : undefined
      if (typeof at === "number") state[id] = at
    }
    return state
  } catch {
    return {}
  }
}

function persistDead(id: string): void {
  try {
    const file = deadFile()
    mkdirSync(path.dirname(file), { recursive: true })
    // Read-modify-write under the shared-state lock (several omp processes can
    // learn retirements concurrently), same as every other sidecar writer.
    withStateLock(() => {
      const state: Record<string, { at: number }> = {}
      for (const [known, at] of Object.entries(persistedDead())) state[known] = { at }
      state[id] = { at: Date.now() }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, file)
    })
  } catch {
    // Best-effort: the in-memory copy still protects this process; a failed
    // write only delays other processes until their own failure re-learns.
  }
}

/**
 * The dead set every roster surface must filter through: the hand-verified
 * seed, everything this process learned, and everything any process has
 * persisted. Fresh per call on purpose — the file is tiny, and a stale
 * in-memory snapshot is exactly how a retired model keeps being offered.
 */
export function deadModels(): Set<string> {
  const dead = new Set(SEED_DEAD_MODELS)
  for (const id of Object.keys(persistedDead())) dead.add(id)
  for (const id of learnedDead) dead.add(id)
  return dead
}

export function isDeadModel(id: string): boolean {
  return deadModels().has(id)
}

/**
 * Mark a model dead at runtime. Returns true when this call is the one that
 * learned the retirement (first mark wins; repeat marks are no-ops).
 */
export function markModelDead(id: string): boolean {
  if (!id) return false
  const fresh = !deadModels().has(id)
  learnedDead.add(id)
  if (fresh) persistDead(id)
  return fresh
}

/** Test hook: forget every runtime-learned mark (seed stays). */
export function clearLearnedDeadModels(): void {
  learnedDead.clear()
  try {
    const file = deadFile()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{}", { mode: 0o600 })
  } catch {}
}

// ─── Deprecation detection ──────────────────────────────────────────────────
//
// The gateway spells a retirement three ways: status 410, the machine code
// `type=ModelDeprecated`, and the prose "has been deprecated". The machine
// code and the prose are deprecation on their own; a bare 410 (or a 404)
// without deprecation wording is some OTHER failure and must never mark a
// model dead — hiding a model that could still serve is worse than a loud
// error.

const DEPRECATION_TEXT = /\bModelDeprecated\b|\bhas been deprecated\b/i

type FailureFacts = { text: string[]; statuses: number[] }

/**
 * Collect the strings and status-ish numbers of an error-shaped carrier,
 * whatever position they arrive in: `Error.message` is non-enumerable (a
 * JSON/entries walk misses it), in-stream failures carry `errorMessage` on an
 * AssistantMessage, and the decoded gateway body hides in `cause`,
 * `response`, or `captured`.
 */
function collectFacts(value: unknown, facts: FailureFacts, depth: number, seen: WeakSet<object>): void {
  if (typeof value === "string") {
    facts.text.push(value)
    return
  }
  if (value === null || typeof value !== "object" || depth > 6 || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) collectFacts(entry, facts, depth + 1, seen)
    return
  }
  const carrier = value as Record<string, unknown>
  for (const key of ["message", "errorMessage", "cause", "captured", "response", "error", "data"]) {
    const entry = carrier[key]
    if (typeof entry === "string") facts.text.push(entry)
  }
  for (const [key, entry] of Object.entries(carrier)) {
    if (
      typeof entry === "number" &&
      /status/i.test(key) &&
      Number.isInteger(entry) &&
      entry >= 100 &&
      entry < 600
    ) {
      facts.statuses.push(entry)
    }
    collectFacts(entry, facts, depth + 1, seen)
  }
}

/** True when a failure is the gateway retiring the model (see the spellings above). */
export function isDeprecationFailure(carrier: unknown): boolean {
  const facts: FailureFacts = { text: [], statuses: [] }
  collectFacts(carrier, facts, 0, new WeakSet())
  const text = facts.text.join("\n")
  if (text.length === 0) return false
  if (DEPRECATION_TEXT.test(text)) return true
  // A 410 needs SOME deprecation wording: `410 the session expired` is not a
  // model retirement and must stay loud-and-visible without hiding anything.
  return facts.statuses.includes(410) && /\bdeprecat/i.test(text)
}

// ─── The loud, actionable rewrite ───────────────────────────────────────────

const MAX_LISTED_ALTERNATIVES = 12

/**
 * The appended note. It names the model as RETIRED UPSTREAM, keeps the
 * gateway's `type=ModelDeprecated` classification visible, and points at
 * what to use instead. It deliberately stays outside every classifier's
 * vocabulary (no rate/quota/wait wording) so the host classifies the failure
 * exactly as before — the failure stays loud and specific; the roster heals
 * behind it and the session's model is NEVER swapped silently.
 */
export function retirementNote(
  modelId: string,
  options: { alternatives?: string[]; freeUsageHint?: boolean } = {},
): string {
  const alternatives = (options.alternatives ?? []).filter((id) => id !== modelId)
  const shown = alternatives.slice(0, MAX_LISTED_ALTERNATIVES)
  const rest = alternatives.length - shown.length
  const use =
    shown.length > 0
      ? `Use a live model instead: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""} — /model switches.`
      : "Run /model to pick a live model."
  return (
    `RETIRED UPSTREAM: ${modelId} no longer exists at the gateway (type=ModelDeprecated) — ` +
    `omp marked it dead and dropped it from the roster${options.freeUsageHint ? " and /freeusage" : ""}; ` +
    `it will not be offered again. ${use}` +
    (options.freeUsageHint ? " /freeusage shows this machine's per-model windows." : "")
  )
}

/**
 * Copy `carrier` with `note` appended to the first deprecation-bearing string
 * (any key — the wording may live on `message`, `errorMessage`, a content
 * block, or a nested body decode). Returns the input untouched when no string
 * carries the deprecation: the mark must never rewrite an unrelated failure.
 */
function withRetirementNote(carrier: unknown, note: string): unknown {
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): { copy: unknown; done: boolean } => {
    if (value === null || typeof value !== "object" || depth > 6 || seen.has(value))
      return { copy: value, done: false }
    seen.add(value)
    if (Array.isArray(value)) {
      const copy: unknown[] = []
      for (const entry of value) {
        const next = visit(entry, depth + 1)
        copy.push(next.copy)
      }
      return { copy, done: false }
    }
    const record = value as Record<string, unknown>
    const copy: Record<string, unknown> = {}
    let done = false
    // Own keys PLUS the non-enumerable carriers a plain entries walk misses:
    // `Error.message` and `Error.cause` are non-enumerable, and they are
    // exactly where a thrown rejection keeps its text.
    const keys = new Set(Object.keys(record))
    for (const key of ["message", "errorMessage", "cause", "captured", "response", "error", "data"]) {
      if (key in record) keys.add(key)
    }
    // Preferred carriers first: one note, at the position a reader sees it.
    const ordered = [...keys].sort((left, right) => carrierKeyRank(left) - carrierKeyRank(right))
    for (const key of ordered) {
      const entry = record[key]
      if (!done && typeof entry === "string" && /\bdeprecat/i.test(entry)) {
        copy[key] = `${entry}\n${note}`
        done = true
        continue
      }
      const next = visit(entry, depth + 1)
      copy[key] = next.copy
      done ||= next.done
    }
    return { copy, done }
  }
  const { copy } = visit(carrier, 0)
  return copy
}

/** The fields a reader (and the host's error pinning) actually renders, first. */
function carrierKeyRank(key: string): number {
  if (key === "errorMessage") return 0
  if (key === "message") return 1
  if (key === "text") return 2
  return 3
}

export type DeprecationStreamOptions = {
  /** The model the request was sent with — the one the gateway retired. */
  modelId: string
  /** The current live roster, read AFTER the mark so it is already clean. */
  alternatives?: () => string[]
  /** Append the `/freeusage` pointer (free lane only — it is a free-tier report). */
  freeUsageHint?: boolean
  /** Roster-heal hook (src/register.ts): fired after the mark lands. */
  onRetired?: (modelId: string) => void
}

/**
 * Wrap a provider stream so a model-deprecation failure (a) marks the model
 * dead at runtime, (b) fires the roster heal, and (c) leaves the user-visible
 * error naming the model and its live alternatives. Both stream failure shapes
 * are handled exactly like src/region.ts handles gates: a thrown rejection
 * (the catch) and an in-stream `type: "error"` event. Everything else passes
 * through untouched — tool-call events, deltas, results, 429s, account gates.
 */
export function mapDeprecationErrors(
  source: AssistantMessageEventStream,
  options: DeprecationStreamOptions,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const noteFor = (): string =>
    retirementNote(options.modelId, {
      ...(options.alternatives ? { alternatives: options.alternatives() } : {}),
      ...(options.freeUsageHint ? { freeUsageHint: true } : {}),
    })
  const retire = (): string => {
    markModelDead(options.modelId)
    options.onRetired?.(options.modelId)
    return noteFor()
  }
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error" && isDeprecationFailure(event.error)) {
          out.push({ ...event, error: withRetirementNote(event.error, retire()) as typeof event.error })
          continue
        }
        out.push(event)
      }
      out.end(await source.result())
    } catch (error) {
      if (isDeprecationFailure(error)) out.fail(withRetirementNote(error, retire()))
      else out.fail(error)
    }
  })()
  out.forwardLocalWorkFrom(source)
  return out
}
