// `/freeusage` — what this machine has spent on the OpenCode free tier.
//
// THERE IS NO SERVER-SIDE USAGE SURFACE. The free tier is keyless (there is no
// account to query), the responses carry no quota headers, and no usage
// endpoint exists — so everything here is LOCAL accounting: the client-side
// ledger the transport writes (src/traffic.ts → trafficFile()). It answers
// "how much of my own traffic went to each free model, in the last 1h/5h/24h"
// and "is that model's rolling window currently tripped".
//
// The limits themselves are per-MODEL rolling windows, announced only when you
// trip one: a bare `429` whose `retry-after` header says how long that model
// needs (observed: `step-5-preview-free` at ~6h47m while `mimo-v2.6-flash-free`
// kept serving). The ledger records that announcement (`status`,
// `retryAfterMs`), so this report can show the cooldown instead of guessing.
//
// WHICH MODELS APPEAR: the embedded catalog snapshot goes stale — the live
// catalog today serves free models the snapshot lacks (`deepseek-v4.1-flash-free`,
// `nemotron-3.5-super-vl-free`) and the ledger already holds real free-lane rows
// for one of them — so the row set is `freeModels()` UNION every model id the
// ledger shows on the FREE lane. See `freeLaneIds` for the lane rule.

import { readFileSync } from "node:fs"
import { freeModels, OPENCODE_CATALOG } from "./models"
import { trafficFile, type TrafficEntry } from "./traffic"

/** Rolling windows, in ms. A row exactly on the boundary counts as inside. */
export const WINDOWS = { h1: 3_600_000, h5: 18_000_000, h24: 86_400_000 } as const

export type Windowed = { h1: number; h5: number; h24: number }

export type FreeModelUsage = {
  id: string
  requests: Windowed
  bytes: Windowed
  /** Timestamp of the newest request this machine sent for the model. */
  lastTs?: string
  /** Status of that newest request (absent on lines written before statuses were recorded). */
  lastStatus?: number
  /**
   * Epoch ms the model's window was announced to end at, present only while a
   * 429 with a retry hint is still in the future.
   */
  cooldownUntil?: number
}

/**
 * Tolerant ledger read: one JSON object per line, and a line that is malformed
 * (partial append) or foreign is skipped silently rather than discarding the
 * whole file. Missing ledger is an empty ledger.
 */
export function readLedger(file: string = trafficFile()): TrafficEntry[] {
  const entries: TrafficEntry[] = []
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return entries
  }
  for (const line of raw.split("\n")) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as TrafficEntry
      if (parsed && typeof parsed === "object" && typeof parsed.ts === "string") entries.push(parsed)
    } catch {
      // malformed line: skip
    }
  }
  return entries
}

/**
 * Free-lane predicate, read off the ledger's `path` — the only lane marker a
 * line carries. The Go subscription lane always stamps `/go/` in its URL (today
 * the catalog endpoint `/zen/go/v1/…`, before that the Console alias
 * `/inference/go/openai/v1/…`), so a line with no `/go/` segment is free-lane.
 * Verified against every path in the live ledger: `/inference/v1/…` (the free
 * provider's configured base, `ZEN_BASE`) and the historical
 * `/inference/openai/v1/…`, versus `/zen/go/v1/…` + `/inference/go/openai/v1/…`.
 */
export function isFreeLanePath(path: string | undefined): boolean {
  return typeof path === "string" && !path.includes("/go/")
}

/**
 * The model ids that charge for input, by the catalog's own cost rule
 * (`freeModels` is the exact complement of this over the same catalog).
 *
 * Needed on top of the path because the historical `/inference/openai/v1/…`
 * base served BOTH lanes: the live ledger holds 943 free-lane rows for
 * `step-5-preview-free` there and 104 Go-lane rows for the paid
 * `deepseek-v4.1-flash`. Path alone would promote a paid model into this
 * report, so the catalog cost settles it.
 */
function paidModelIds(): Set<string> {
  const paid = new Set<string>()
  for (const [id, model] of Object.entries(OPENCODE_CATALOG.models)) {
    const tiers = Array.isArray(model.cost) ? model.cost : [model.cost]
    if (tiers.some((tier) => Number(tier?.input ?? 0) > 0)) paid.add(id)
  }
  return paid
}

let paidIds: Set<string> | undefined

/**
 * The report's row set: the free roster plus every distinct free-lane model the
 * ledger has seen. Union rows that the snapshot does not know (a live-catalog
 * free model) still render normally; a Go-lane line and a paid catalog id never
 * become a free row.
 */
export function freeLaneIds(
  entries: TrafficEntry[],
  roster: Iterable<string> = freeModels().map((model) => model.id),
): string[] {
  paidIds ??= paidModelIds()
  const ids = new Set(roster)
  for (const entry of entries) {
    if (!entry.model || !isFreeLanePath(entry.path)) continue
    if (paidIds.has(entry.model)) continue
    ids.add(entry.model)
  }
  return [...ids]
}

type Accumulator = {
  row: FreeModelUsage
  lastAt: number
  last429At: number
  /** Retry hint on the newest 429, or undefined when that 429 carried none. */
  last429AfterMs?: number
}

/**
 * Per-free-model aggregation over the rolling windows ending at `now`.
 *
 * The row set is `freeIds` (see `freeLaneIds`), so a model with no traffic
 * renders as `idle` instead of vanishing. Ledger rows outside it — another
 * lane, another model, a malformed line — are skipped. Cooldown follows the
 * announcement on the newest 429 row: only that row's own hint counts, and only
 * while `ts + retryAfterMs` is still ahead.
 */
export function aggregateFreeUsage(
  entries: TrafficEntry[],
  options: { freeIds: Iterable<string>; now: number },
): FreeModelUsage[] {
  const { now } = options
  const accumulated = new Map<string, Accumulator>()
  for (const id of options.freeIds) {
    accumulated.set(id, {
      row: { id, requests: { h1: 0, h5: 0, h24: 0 }, bytes: { h1: 0, h5: 0, h24: 0 } },
      lastAt: Number.NEGATIVE_INFINITY,
      last429At: Number.NEGATIVE_INFINITY,
    })
  }

  for (const entry of entries) {
    const accumulator = entry.model === undefined ? undefined : accumulated.get(entry.model)
    // Only free-lane lines count: a Go-lane line never charges a free model's window.
    if (!accumulator || !isFreeLanePath(entry.path)) continue
    const at = Date.parse(entry.ts)
    if (!Number.isFinite(at)) continue
    const bytes = Number.isFinite(entry.bytes) ? entry.bytes : 0
    const { row } = accumulator
    const age = now - at
    if (age <= WINDOWS.h1) {
      row.requests.h1 += 1
      row.bytes.h1 += bytes
    }
    if (age <= WINDOWS.h5) {
      row.requests.h5 += 1
      row.bytes.h5 += bytes
    }
    if (age <= WINDOWS.h24) {
      row.requests.h24 += 1
      row.bytes.h24 += bytes
    }
    if (at >= accumulator.lastAt) {
      accumulator.lastAt = at
      row.lastTs = entry.ts
      row.lastStatus = entry.status
    }
    if (entry.status === 429 && at >= accumulator.last429At) {
      accumulator.last429At = at
      accumulator.last429AfterMs =
        typeof entry.retryAfterMs === "number" && Number.isFinite(entry.retryAfterMs) && entry.retryAfterMs > 0
          ? entry.retryAfterMs
          : undefined
    }
  }

  const rows: FreeModelUsage[] = []
  for (const accumulator of accumulated.values()) {
    const { row } = accumulator
    const endsAt = accumulator.last429AfterMs === undefined ? undefined : accumulator.last429At + accumulator.last429AfterMs
    if (endsAt !== undefined && endsAt > now) row.cooldownUntil = endsAt
    rows.push(row)
  }
  // Busiest first over the window people act on, then a stable id tiebreak.
  return rows.sort((left, right) => right.requests.h5 - left.requests.h5 || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function size(bytes: number): string {
  const value = Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

/** Compact "how long is left" (`6h47m`, `47m`, `<1m`). */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return "<1m"
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}m` : `${rest}m`
}

function clock(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

const pad = (value: number) => String(value).padStart(2, "0")

/**
 * Timestamp column: the time of day inside the 24h window, and `MM-DD HH:MM`
 * outside it — an `idle` model whose last request predates the window should not
 * read as if it had just served something.
 */
function stamp(iso: string | undefined, now: number): string {
  if (iso === undefined) return "-"
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return "-"
  const date = new Date(at)
  if (now - at <= WINDOWS.h24) return `${clock(at)}:${pad(date.getSeconds())}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(at)}`
}

const CELL = 14
const STAMP = 11
const cell = (requests: number, bytes: number): string => `${String(requests).padStart(4)} ${size(bytes).padStart(9)}`

/** State column: an announced, unexpired cooldown beats `ready`; no traffic at all is `idle`. */
export function freeUsageState(row: FreeModelUsage, now: number): string {
  if (row.cooldownUntil !== undefined) {
    return `limited (until ${clock(row.cooldownUntil)}, ~${formatRemaining(row.cooldownUntil - now)} left)`
  }
  return row.requests.h24 === 0 ? "idle" : "ready"
}

/**
 * Rendered report for `/freeusage [model-filter]` and tests.
 *
 * The window totals and the honesty note describe the WHOLE free tier; an
 * optional filter only narrows the model rows (the free roster, matched
 * case-insensitively as a substring of the model id).
 */
export function freeUsageReport(
  options: { file?: string; freeIds?: string[]; now?: number; filter?: string } = {},
): string {
  const file = options.file ?? trafficFile()
  const now = options.now ?? Date.now()
  const entries = readLedger(file)
  const ids = options.freeIds ?? freeLaneIds(entries)
  const rows = aggregateFreeUsage(entries, { freeIds: ids, now })
  const totals = rows.reduce(
    (sum, row) => ({
      h1: sum.h1 + row.requests.h1,
      h5: sum.h5 + row.requests.h5,
      h24: sum.h24 + row.requests.h24,
    }),
    { h1: 0, h5: 0, h24: 0 },
  )

  const filter = options.filter?.trim()
  const needle = filter?.toLowerCase()
  const shown = needle ? rows.filter((row) => row.id.toLowerCase().includes(needle)) : rows

  const lines = [
    `opencode free tier — LOCAL accounting: the free tier is keyless and publishes no`,
    `server-side usage (no quota headers, no usage endpoint). Ledger: ${file}`,
    `free-tier window totals: 1h ${totals.h1} req · 5h ${totals.h5} req · 24h ${totals.h24} req${
      needle ? ` · filter '${filter}'` : ""
    }`,
  ]
  if (shown.length === 0) {
    lines.push(`no free models match '${filter}'`)
  } else {
    lines.push(
      `model`.padEnd(32) +
        `1h`.padStart(CELL) +
        `5h`.padStart(CELL) +
        `24h`.padStart(CELL) +
        `last`.padStart(STAMP) +
        `st`.padStart(4) +
        `  state`,
    )
    for (const row of shown) {
      lines.push(
        row.id.padEnd(32) +
          cell(row.requests.h1, row.bytes.h1) +
          cell(row.requests.h5, row.bytes.h5) +
          cell(row.requests.h24, row.bytes.h24) +
          stamp(row.lastTs, now).padStart(STAMP) +
          (row.lastStatus === undefined ? "-" : String(row.lastStatus)).padStart(4) +
          `  ${freeUsageState(row, now)}`,
      )
    }
  }
  lines.push(`note: limits are per-MODEL rolling windows — one model can be limited while its siblings serve.`)
  lines.push(`the free tier announces a window only by tripping it (429 + retry-after).`)
  return lines.join("\n")
}
