// opencode-go usage/limits reporting for omp.
//
// Endpoint contract (reverse-engineered; the route is a thin proxy to the
// inference backend at packages/console/app/src/routes/zen/go/v1/usage.ts in
// github.com/anomalyco/opencode and is undocumented upstream):
//
//   GET {base}/v1/usage
//   → { "usage": {
//        "rolling": { "percent": 0-100, "status": "ok"|"rate-limited", "resetsAt": ISO },
//        "weekly":  { ... },
//        "monthly": { ... } } }
//
// Windows: rolling 5h, weekly 7d, monthly anchored on the subscription
// anniversary (deliberately no duration). `percent` is a floored, clamped
// used-fraction; `resetsAt` is computed server-side.
//
// The harness itself never calls this route (verified: no callers in
// packages/{core,cli,tui,app}); it is the surface omp's `omp usage` reads and
// the Console website displays. Errors carry `{"error":{"message":…}}`;
// 401/403 are credential problems and must fail loudly for health checks.

import type {
  UsageAmount,
  UsageFetchContext,
  UsageFetchParams,
  UsageLimit,
  UsageProvider,
  UsageReport,
  UsageStatus,
  UsageWindow,
} from "@oh-my-pi/pi-ai"
import { accountVerdict, VERDICT_TTL_MS } from "./verdicts"
import { indexTokenOrg } from "./opencode-provider"
import { noteUsageOrg } from "./routing"
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error"
import { sessionHeaders, type HarnessIdentity, type SessionIdentity } from "./wire"

export const OPENCODE_GO_PROVIDER = "opencode-go"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const WINDOWS = [
  { key: "rolling", limitId: "rolling-5h", windowId: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
  { key: "weekly", limitId: "weekly", windowId: "7d", label: "Weekly", durationMs: 7 * DAY_MS },
  // Monthly anchors on the subscription anniversary: no fixed duration.
  { key: "monthly", limitId: "monthly", windowId: "monthly", label: "Monthly", durationMs: undefined },
] as const

export type OpencodeGoUsageOptions = {
  /** Session identity emitted on the wire (x-opencode-* + client name). */
  session: SessionIdentity
  identity?: HarnessIdentity
}

type WindowPayload = { percent?: unknown; status?: unknown; resetsAt?: unknown }

function statusOf(windowStatus: unknown, usedFraction: number): UsageStatus {
  if (windowStatus === "rate-limited") return "exhausted"
  if (usedFraction >= 1) return "exhausted"
  if (usedFraction >= 0.8) return "warning"
  return "ok"
}

function windowLimit(
  descriptor: (typeof WINDOWS)[number],
  payload: unknown,
): UsageLimit | undefined {
  if (payload === null || typeof payload !== "object") return undefined
  const { percent, status, resetsAt } = payload as WindowPayload
  if (
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    (status !== "ok" && status !== "rate-limited")
  )
    return undefined
  const resetsAtMs = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN
  if (!Number.isFinite(resetsAtMs)) return undefined
  const usedFraction = percent / 100
  const window: UsageWindow = { id: descriptor.windowId, label: descriptor.label, resetsAt: resetsAtMs }
  if (descriptor.durationMs !== undefined) window.durationMs = descriptor.durationMs
  const amount: UsageAmount = {
    used: percent,
    usedFraction,
    remainingFraction: Math.max(0, 1 - usedFraction),
    unit: "percent",
  }
  return {
    id: descriptor.limitId,
    // Antigravity's convention: the shared marker rides in the label, and the
    // scope names the shared group. Go windows are one pool per account,
    // shared across every session and client of that account.
    label: `${descriptor.label} limit (shared)`,
    scope: { provider: OPENCODE_GO_PROVIDER, windowId: descriptor.windowId, shared: true },
    window,
    amount,
    status: statusOf(status, usedFraction),
  }
}

/**
 * `GET {base}/usage` with the harness fingerprint (User-Agent, x-opencode-*,
 * b3/traceparent) plus `authorization: Bearer <access|key>`.
 *
 * Note: unlike login/inference, this request has no golden harness trace —
 * the harness has no caller for this route. The header set is derived from the
 * gateway's own requirement (`x-opencode-session`, per upstream change of
 * 09/06) plus the harness conventions for gateway requests.
 */
export function opencodeGoUsageProvider(options: OpencodeGoUsageOptions): UsageProvider {
  return {
    id: OPENCODE_GO_PROVIDER,
    validatesCredentials: true,
    async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
      const token =
        params.credential.type === "api_key" ? params.credential.apiKey : params.credential.accessToken
      if (!token) return null
      // Bind token -> org here: the usage poll runs per credential and carries
      // its identity, so the request path can attribute each request to the
      // SERVING credential's own org (a cross-paired org gets "Workspace
      // access denied" from the gateway).
      indexTokenOrg(token, params.credential.orgId)
      // A recent inference-time verdict (402 funds / 403 workspace) is a
      // credential verdict even when this endpoint answers fine: fail loudly
      // so the pool demotes the account instead of preferring its "0% used"
      // quota forever.
      const verdict = accountVerdict(token)
      if (verdict) {
        throw new ProviderHttpError(
          `account verdict from inference: ${verdict.message} (re-checks automatically in ${Math.max(1, Math.round((VERDICT_TTL_MS - (Date.now() - verdict.at)) / 60_000))}m)`,
          403,
        )
      }
      // Accept both catalog spellings ("zen/go" and "zen/go/v1") like omp's built-in.
      const stripped = (params.baseUrl ?? "https://opencode.ai/zen/go").trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
      const response = await ctx.fetch(`${stripped}/v1/usage`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...sessionHeaders(options.session, options.identity),
        },
        signal: params.signal,
      })
      if (!response.ok) {
        // 401/402/403 are credential verdicts (402 = "Insufficient account
        // funds" — an account that cannot serve must not keep a healthy
        // ranking, or the pooler keeps preferring its "0% used" quota):
        // fail loudly so health checks flag the
        // credential instead of reporting unknown status.
        if (response.status === 401 || response.status === 402 || response.status === 403) {
          let detail: string | undefined
          try {
            const payload = (await response.json()) as { error?: { message?: unknown } }
            detail = typeof payload.error?.message === "string" ? payload.error.message : undefined
          } catch {
            detail = undefined
          }
          throw new ProviderHttpError(
            `OpenCode Go usage endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`,
            response.status,
          )
        }
        // Transient: serve the last good report rather than null — null reports
        // the account as "usage unavailable" and double-lists it in `omp usage`
        // until the next successful poll.
        return ctx.previousReport ?? null
      }
      const payload = (await response.json().catch(() => undefined)) as { usage?: unknown } | undefined
      if (!payload || typeof payload !== "object" || typeof payload.usage !== "object" || payload.usage === null)
        return null
      const windows = payload.usage as Record<string, unknown>
      // Decode defensively: skip malformed windows rather than failing the report.
      const limits = WINDOWS.flatMap((descriptor) => {
        const limit = windowLimit(descriptor, windows[descriptor.key])
        return limit ? [limit] : []
      })
      // Feed the cache-strategic router (src/routing.ts): the spill decision
      // follows the account's worst window, monthly included.
      noteUsageOrg(
        params.credential.orgId,
        limits.reduce((worst, limit) => Math.max(worst, limit.amount.usedFraction ?? 0), 0),
      )
      return {
        provider: OPENCODE_GO_PROVIDER,
        fetchedAt: Date.now(),
        limits,
        // Identity metadata so the usage service can match this report to its
        // credential — without it the account is listed twice ("no usage data"
        // alongside its own fresh report).
        metadata: {
          accountId: params.credential.accountId,
          email: params.credential.email,
          orgId: params.credential.orgId,
          orgName: params.credential.orgName,
        },
        raw: payload,
      }
    },
  }
}
