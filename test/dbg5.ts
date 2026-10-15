import { parseRateLimitReason, calculateRateLimitBackoffMs } from "@oh-my-pi/pi-ai/error/rate-limit"
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after"

const msg = "Upstream request failed: account member out of service (type=server_error) (This is a member verdict, not a bad login: that account cannot serve this request right now. omp rotates to a healthy account when the pool has one.)"
console.log("reason:", parseRateLimitReason(msg))
console.log("backoff:", calculateRateLimitBackoffMs(parseRateLimitReason(msg)))
for (const provider of ["opencode-go", undefined]) {
  console.log("hint", provider, extractProviderRetryHint(provider as never, msg))
  console.log("hint+json", provider, extractProviderRetryHint(provider as never, `${msg}\n${JSON.stringify({ retryAfterMs: 1732329, data: { retryAfterMs: 1732329, waitTimeMs: 1732329 } })}`))
}
const oldMsg = "Upstream request failed: Insufficient account funds (type=server_error)"
console.log("old reason:", parseRateLimitReason(oldMsg), "old backoff:", calculateRateLimitBackoffMs(parseRateLimitReason(oldMsg)))
for (let i = 0; i < 3; i++) console.log("capacity sample:", calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED"))
