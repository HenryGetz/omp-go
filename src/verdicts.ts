// Inference-time account verdicts, fed back into the health/ranking layer.
//
// The pooler ranks credentials by remaining quota, which makes a broken account
// with 0% usage look like the BEST pick — and the 402/403 it answers with is
// thrown away, so it keeps winning ("worked fine, then randomly stopped"). The
// request path records those verdicts here; the usage/health layer reads them
// and fails loudly, which is what demotes the account in the pool.
//
// Keyed by the bearer token itself (both sides have it; in-memory only, never
// persisted or logged). Verdicts expire so a topped-up account heals itself.

export type AccountVerdict = {
  kind: "funds" | "workspace" | "region"
  message: string
  at: number
}

const verdicts = new Map<string, AccountVerdict>()
export const VERDICT_TTL_MS = 30 * 60 * 1000

export function markAccountVerdict(token: string | undefined, verdict: AccountVerdict): void {
  if (!token) return
  verdicts.set(token, verdict)
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

/** Test hook. */
export function clearAccountVerdicts(): void {
  verdicts.clear()
}
