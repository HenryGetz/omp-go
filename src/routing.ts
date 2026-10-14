// Cache-strategic account routing for the opencode-go multi-account pool.
//
// Prompt caching is per account: every request that lands on an account whose
// prompt-cache prefix is cold pays full input price, so scattering chats across
// accounts costs several times more than consolidating them. But consolidating
// blindly strands the last chats on a nearly-full account, where they build
// cache on an account about to stop serving. The policy here is the middle
// ground:
//
//   - A session pins to one account and stays there (omp's own session
//     affinity plus the explicit pin below): its prompt cache stays warm.
//   - NEW sessions join the warm leader — the account that served most
//     recently, whose shared prompt-cache prefix is live — while it has
//     headroom.
//   - Once the leader passes the spill threshold (default 90% of its worst
//     window), new sessions start on the sibling and the leader drains: live
//     sessions keep their pin (an explicit pin is never evicted by usage
//     reserve), so their warm cache keeps paying off until they finish.
//   - When every account is near-full it no longer matters: the leader still
//     wins (consolidation is never worse for cache), and hard failures rotate
//     to a healthy sibling through the existing verdict/rotation layer.
//
// The decision is enforced through omp's own public auth API
// (`discoverAuthStorage().sessions.pin(...)`): a pin made here is an explicit
// user-grade pin — ranking and account reserve never evict it, while hard
// unavailability and auth retry still route around it. That is exactly the
// drain-in-place semantics above, with no monkey-patching.
//
// Warmth ("who served last") is observed where credentials are resolved
// (getApiKey) and persisted per org so every omp process agrees on the leader.
// Usage (the spill signal) is observed from the provider's own usage polls.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { orgVerdict } from "./verdicts"
import { withStateLock } from "./state-lock"

/** The host's own AuthStorage type, derived from the extension API namespace. */
type HostAuth = Awaited<ReturnType<ExtensionAPI["pi"]["discoverAuthStorage"]>>

/** New sessions stop joining an account once its worst window is this full. */
const SPILL_AT_USED = spillAtUsed()

function spillAtUsed(): number {
  const raw = Number(process.env.OMP_GO_SPILL_PCT)
  const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 90
  return pct / 100
}

type AccountState = {
  /** When this account last served a request (the warm-cache signal). */
  lastServedAtMs?: number
  /** Worst-window used fraction (0..1) from the latest usage poll. */
  usedPct?: number
  usedPctAtMs?: number
}

/** orgId -> routing state. Persisted: leader choice must agree across processes. */
type RoutingState = Record<string, AccountState>

const STATE_MAX_ENTRIES = 200

function stateFile(): string {
  return path.join(process.env.HOME || homedir(), ".omp", "agent", "omp-go-routing.json")
}

function accountStateOf(value: unknown): AccountState {
  const state: AccountState = {}
  if (typeof value !== "object" || value === null) return state
  const lastServedAtMs = "lastServedAtMs" in value ? value.lastServedAtMs : undefined
  const usedPct = "usedPct" in value ? value.usedPct : undefined
  const usedPctAtMs = "usedPctAtMs" in value ? value.usedPctAtMs : undefined
  if (typeof lastServedAtMs === "number") state.lastServedAtMs = lastServedAtMs
  if (typeof usedPct === "number") state.usedPct = usedPct
  if (typeof usedPctAtMs === "number") state.usedPctAtMs = usedPctAtMs
  return state
}

function loadState(): RoutingState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    const state: RoutingState = {}
    for (const [orgId, entry] of Object.entries(parsed)) state[orgId] = accountStateOf(entry)
    return state
  } catch {
    return {}
  }
}

function saveState(state: RoutingState): void {
  try {
    const file = stateFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const entries = Object.entries(state)
    const trimmed = entries.length > STATE_MAX_ENTRIES ? entries.slice(entries.length - STATE_MAX_ENTRIES) : entries
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(trimmed)), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best-effort: routing state must never break a request or a login.
  }
}

function touch(orgId: string | undefined, patch: (state: AccountState) => void): void {
  if (!orgId) return
  withStateLock(() => {
    const state = loadState()
    const entry = state[orgId] ?? {}
    patch(entry)
    state[orgId] = entry
    saveState(state)
  })
}

/**
 * Record that `orgId`'s account just served a request. Called at credential
 * resolution (the serving point for every lane) so the leader is whoever's
 * prompt-cache prefix is actually warm.
 */
export function noteServedOrg(orgId: string | undefined): void {
  touch(orgId, (state) => {
    state.lastServedAtMs = Date.now()
  })
}

/**
 * Record the worst-window used fraction observed for `orgId` at a usage poll.
 * `usedPct` is max over the reported windows (0..1), monthly included: the
 * spill decision follows the account's real budget, not just the rate windows.
 */
export function noteUsageOrg(orgId: string | undefined, usedPct: number): void {
  if (!Number.isFinite(usedPct)) return
  touch(orgId, (state) => {
    state.usedPct = Math.min(1, Math.max(0, usedPct))
    state.usedPctAtMs = Date.now()
  })
}

/** One stored account as the router sees it. */
export type RoutingCandidate = {
  credentialId: number
  orgId?: string
  /** omp's own usage-health state for this credential, when measured. */
  state?: "healthy" | "reserve" | "depleted" | "unknown"
  /** Remaining quota fraction from omp's usage health (excludes display-only windows). */
  remainingFraction?: number
  /** Worst-window used fraction (0..1) from usage polls; wins over remainingFraction. */
  usedPct?: number
  lastServedAtMs?: number
}

function usedFractionOf(candidate: RoutingCandidate): number {
  if (candidate.usedPct !== undefined) return candidate.usedPct
  if (candidate.remainingFraction !== undefined) return 1 - candidate.remainingFraction
  return 0
}

/**
 * Pure routing policy: which account should a NEW session start on?
 *
 * Returns the chosen `credentialId`, or undefined when the pool cannot decide
 * (no usable accounts) and core's own ranking should take over.
 */
export function chooseAccount(
  candidates: readonly RoutingCandidate[],
  spillAtUsed: number = SPILL_AT_USED,
): number | undefined {
  const usable = candidates.filter((candidate) => candidate.state !== "depleted")
  if (usable.length === 0) return undefined
  const scored = usable.map((candidate) => ({ candidate, used: usedFractionOf(candidate) }))
  // Spill: prefer accounts that still have room. When none do ("both at 90%"),
  // it no longer matters — consolidate on the warm leader anyway.
  const withHeadroom = scored.filter((entry) => entry.used < spillAtUsed)
  const pool = withHeadroom.length > 0 ? withHeadroom : scored
  pool.sort(
    (left, right) =>
      // Warm leader first: its shared prompt-cache prefix is the live one.
      (right.candidate.lastServedAtMs ?? 0) - (left.candidate.lastServedAtMs ?? 0) ||
      // No serving history: most headroom first (longest before the next spill).
      left.used - right.used ||
      // Stable.
      left.candidate.credentialId - right.candidate.credentialId,
  )
  return pool[0]?.candidate.credentialId
}

/**
 * Pin a fresh session to the account chosen by {@link chooseAccount}.
 *
 * `api` is the extension API (its `pi` namespace reaches the host's
 * `discoverAuthStorage`). Best-effort by design: any failure returns false and
 * the session falls back to omp's default ranking.
 */
export async function pinNewSession(
  api: ExtensionAPI,
  sessionId: string | undefined,
  provider = "opencode-go",
): Promise<boolean> {
  if (!sessionId) return false
  const auth = await api.pi.discoverAuthStorage()
  const accounts = auth.oauth.accounts(provider, sessionId)
  // A resumed or inherited session already has its sticky credential: leave it
  // (drain-in-place), never re-pin over it.
  if (accounts.length === 0 || accounts.some((account) => account.active)) return false

  let health: Awaited<ReturnType<HostAuth["health"]["model"]>> | undefined
  try {
    health = await auth.health.model(provider, { reserveFraction: 0 })
  } catch {
    health = undefined
  }
  const state = loadState()
  const candidates: RoutingCandidate[] = accounts.map((account) => {
    const measured = health?.accounts.find((entry) => entry.credentialId === account.credentialId)
    const routing = account.orgId !== undefined ? state[account.orgId] : undefined
    return {
      credentialId: account.credentialId,
      orgId: account.orgId,
      // A fresh account verdict (402 funds / 403 workspace / region policy)
      // makes the account unusable for NEW sessions even though its quota
      // windows look untouched — treat it as depleted so the pin skips it.
      state: orgVerdict(account.orgId) ? "depleted" : measured?.state,
      remainingFraction: measured?.remainingFraction,
      usedPct: routing?.usedPct,
      lastServedAtMs: routing?.lastServedAtMs,
    }
  })
  const pick = chooseAccount(candidates)
  if (pick === undefined) return false
  const pinned = auth.sessions.pin(provider, sessionId, pick)
  if (pinned) {
    hostApi = api
    noteSessionPin(sessionId, candidates.find((candidate) => candidate.credentialId === pick)?.orgId, pick)
  }
  return pinned
}

// ─── Verdict-driven re-pin ─────────────────────────────────────────────────
//
// A session pinned to an account that later gets a verdict (402 funds / 403
// workspace / region policy) would keep landing on it every turn once the
// in-turn rotation has spent its retry budget — the "Retry failed: Provider
// requested …ms wait" death spiral. When the verdict lands, move those
// sessions' pins to the healthy sibling so the NEXT turn starts clean.

type PinRecord = { sessionId: string; orgId?: string; credentialId: number; at: number }

let hostApi: ExtensionAPI | undefined

function pinsFile(): string {
  return path.join(process.env.HOME || homedir(), ".omp", "agent", "omp-go-pins.json")
}

const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function loadPins(): PinRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pinsFile(), "utf8"))
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    const pins: PinRecord[] = []
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue
      const sessionId = "sessionId" in entry ? entry.sessionId : undefined
      const credentialId = "credentialId" in entry ? entry.credentialId : undefined
      const at = "at" in entry ? entry.at : undefined
      const orgId = "orgId" in entry ? entry.orgId : undefined
      if (typeof sessionId !== "string" || typeof credentialId !== "number") continue
      if (typeof at !== "number" || now - at > PIN_TTL_MS) continue
      pins.push({ sessionId, credentialId, at, ...(typeof orgId === "string" ? { orgId } : {}) })
    }
    return pins
  } catch {
    return []
  }
}

function savePins(pins: PinRecord[]): void {
  try {
    const file = pinsFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(pins), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best-effort: pin bookkeeping must never break a request.
  }
}

function noteSessionPin(sessionId: string, orgId: string | undefined, credentialId: number): void {
  withStateLock(() => {
    const pins = loadPins().filter((pin) => pin.sessionId !== sessionId)
    pins.push({ sessionId, orgId, credentialId, at: Date.now() })
    savePins(pins)
  })
}

/**
 * Move every session pinned to `verdictOrgId` onto a healthy sibling. Called
 * when an account verdict lands (src/region.ts); best-effort and fire-and-
 * forget — the in-turn rotation remains the first line of defense.
 */
export async function repinAfterVerdict(verdictOrgId: string | undefined, provider = "opencode-go"): Promise<void> {
  if (!hostApi || !verdictOrgId) return
  const pins = loadPins()
  const affected = pins.filter((pin) => pin.orgId === verdictOrgId)
  if (affected.length === 0) return
  const auth = await hostApi.pi.discoverAuthStorage()
  const accounts = auth.oauth.accounts(provider)
  if (accounts.length === 0) return
  let health: Awaited<ReturnType<HostAuth["health"]["model"]>> | undefined
  try {
    health = await auth.health.model(provider, { reserveFraction: 0 })
  } catch {
    health = undefined
  }
  const state = loadState()
  const candidates: RoutingCandidate[] = accounts
    .filter((account) => account.orgId !== verdictOrgId && !orgVerdict(account.orgId))
    .map((account) => {
      const measured = health?.accounts.find((entry) => entry.credentialId === account.credentialId)
      const routing = account.orgId !== undefined ? state[account.orgId] : undefined
      return {
        credentialId: account.credentialId,
        orgId: account.orgId,
        state: measured?.state,
        remainingFraction: measured?.remainingFraction,
        usedPct: routing?.usedPct,
        lastServedAtMs: routing?.lastServedAtMs,
      }
    })
  const pick = chooseAccount(candidates)
  if (pick === undefined) return
  const targetOrg = candidates.find((candidate) => candidate.credentialId === pick)?.orgId
  withStateLock(() => {
    const fresh = loadPins()
    for (const pin of affected) {
      if (!auth.sessions.pin(provider, pin.sessionId, pick)) continue
      const live = fresh.find((entry) => entry.sessionId === pin.sessionId)
      const target = live ?? pin
      target.credentialId = pick
      target.orgId = targetOrg
      target.at = Date.now()
      if (!live) fresh.push(target)
    }
    savePins(fresh)
  })
}
