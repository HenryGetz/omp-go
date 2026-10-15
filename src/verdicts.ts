// Inference-time account verdicts, fed back into the health/ranking layer.
//
// The pooler ranks credentials by remaining quota, which makes a broken account
// with 0% usage look like the BEST pick — and the 402/403 it answers with is
// thrown away, so it keeps winning ("worked fine, then randomly stopped"). The
// request path records those verdicts here; the usage/health layer reads them
// and fails loudly, which is what demotes the account in the pool.
//
// Two copies, both TTL'd (a topped-up account must heal itself):
//   - by bearer token, in-memory: the request path has the token, never log it.
//   - by org id, persisted (omp-go-verdicts.json): every NEW omp process would
//     otherwise forget the verdict and pin fresh sessions to the broken
//     account again — its quota windows look untouched while its billing is
//     dry (`402 Insufficient account funds`). The routing layer consults this
//     copy before pinning a session.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { withStateLock } from "./state-lock"

export type AccountVerdict = {
  kind: "funds" | "workspace" | "region"
  message: string
  at: number
}

const verdicts = new Map<string, AccountVerdict>()
export const VERDICT_TTL_MS = 30 * 60 * 1000

function verdictsFile(): string {
  return path.join(process.env.HOME || homedir(), ".omp", "agent", "omp-go-verdicts.json")
}

function loadOrgVerdicts(): Record<string, AccountVerdict> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(verdictsFile(), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    const now = Date.now()
    const state: Record<string, AccountVerdict> = {}
    for (const [orgId, entry] of Object.entries(parsed)) {
      if (typeof entry !== "object" || entry === null) continue
      const at = "at" in entry ? entry.at : undefined
      const kind = "kind" in entry ? entry.kind : undefined
      const message = "message" in entry ? entry.message : undefined
      if (typeof at !== "number" || now - at > VERDICT_TTL_MS) continue
      if (kind !== "funds" && kind !== "workspace" && kind !== "region") continue
      state[orgId] = { kind, message: typeof message === "string" ? message : "", at }
    }
    return state
  } catch {
    return {}
  }
}

function saveOrgVerdicts(state: Record<string, AccountVerdict>): void {
  try {
    const file = verdictsFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best-effort: verdict bookkeeping must never break a request.
  }
}

export function markAccountVerdict(token: string | undefined, verdict: AccountVerdict, orgId?: string): void {
  // The org is the durable key: a gate failure whose bearer never resolved
  // must still poison the org for routing, or every retry walks back into it.
  if (!token && !orgId) return
  if (token) verdicts.set(token, verdict)
  if (!orgId) return
  withStateLock(() => {
    const state = loadOrgVerdicts()
    state[orgId] = verdict
    saveOrgVerdicts(state)
  })
}

/** TTL-aware read; expired verdicts delete themselves (account may have healed). */
export function accountVerdict(token: string | undefined): AccountVerdict | undefined {
  if (!token) return undefined
  const verdict = verdicts.get(token)
  if (!verdict) return undefined
  if (Date.now() - verdict.at > VERDICT_TTL_MS) {
    verdicts.delete(token)
    return undefined
  }
  return verdict
}

/** Cross-process verdict for an org: consulted before pinning new sessions. */
export function orgVerdict(orgId: string | undefined): AccountVerdict | undefined {
  if (!orgId) return undefined
  return loadOrgVerdicts()[orgId]
}

/** Test hook. */
export function clearAccountVerdicts(): void {
  verdicts.clear()
  withStateLock(() => saveOrgVerdicts({}))
}
