// Local traffic accounting for the free tier.
//
// The free tier has no server-side usage surface: responses carry no quota
// headers and there is no usage endpoint (keyless — there is no account to
// query). The only visibility that exists is what the client records, so the
// transport appends one compact line per request here and `/egress traffic`
// aggregates them.
//
// File: ~/.omp/agent/omp-go-traffic.ndjson (override with OMP_GO_WIRE_LOG).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type TrafficEntry = {
  ts: string
  method: string
  path: string
  hop: string
  bytes: number
  model?: string
  /** HTTP status of the response this request produced (absent on lines written before 1.3.8). */
  status?: number
  /** Retry delay the gateway announced on a 429, in ms (best-effort, absent when it said nothing). */
  retryAfterMs?: number
}

function agentHome(): string {
  return process.env.HOME || homedir()
}

export function trafficFile(): string {
  return process.env.OMP_GO_WIRE_LOG || path.join(agentHome(), ".omp", "agent", "omp-go-traffic.ndjson")
}

/** Append one request record. Cheap: one line, no parsing of the payload. */
export function recordTraffic(entry: TrafficEntry): void {
  try {
    const file = trafficFile()
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    // best-effort; traffic accounting must never break a request
  }
}

/** Pull `"model":"..."` out of a request body without parsing the whole thing. */
export function modelFrom(body: string | undefined): string | undefined {
  if (!body) return undefined
  const match = /"model"\s*:\s*"([^"]+)"/.exec(body)
  return match?.[1]
}

export type TrafficSummary = {
  requests: number
  bytes: number
  byHop: Record<string, number>
  byModel: Record<string, number>
  last?: string
}

export function summarizeTraffic(entries: TrafficEntry[]): TrafficSummary {
  const summary: TrafficSummary = { requests: 0, bytes: 0, byHop: {}, byModel: {} }
  for (const entry of entries) {
    summary.requests += 1
    summary.bytes += entry.bytes
    summary.byHop[entry.hop] = (summary.byHop[entry.hop] ?? 0) + 1
    if (entry.model) summary.byModel[entry.model] = (summary.byModel[entry.model] ?? 0) + 1
    summary.last = entry.ts
  }
  return summary
}

export function readTraffic(): TrafficEntry[] {
  try {
    return readFileSync(trafficFile(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrafficEntry)
  } catch {
    return []
  }
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    const single = Array.isArray(value) ? value[0] : value
    if (typeof single === "string") return single
  }
  return undefined
}

/** A plain millisecond delta (`retry-after-ms`). */
function deltaMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.ceil(value)
}

/** `retry-after`: seconds or an HTTP-date. */
function secondsMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const text = raw.trim()
  if (!text) return undefined
  const value = Number(text)
  if (Number.isFinite(value)) return value > 0 ? Math.ceil(value * 1000) : undefined
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  const delay = date - Date.now()
  return delay > 0 ? Math.ceil(delay) : undefined
}

/** `x-ratelimit-reset[-ms]`: an absolute epoch stamp when it is one, else a delta. */
function resetMs(raw: string | undefined, unit: "ms" | "s"): number | undefined {
  if (!raw) return undefined
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return undefined
  const now = Date.now()
  // Epoch stamps arrive in seconds (1e9..1e12) or milliseconds (>1e12);
  // anything smaller is a bare delta in the header's own unit.
  if (value > 1e12 || value > 1e9) {
    const target = value > 1e12 ? value : value * 1000
    const delay = target - now
    return delay > 0 ? Math.ceil(delay) : undefined
  }
  return Math.ceil(unit === "ms" ? value : value * 1000)
}

/**
 * Best-effort retry delay (ms) out of a response's headers, mirroring the
 * precedence of the host's own hint parser (`retry-after-ms`, `retry-after`,
 * `x-ratelimit-reset-ms`, `x-ratelimit-reset`; the largest candidate wins).
 *
 * This is the ONLY place a free-tier limit is visible to us: the keyless free
 * tier answers a tripped per-model window with a plain 429 whose body is a
 * generic `FreeUsageLimitError` — the wait it wants is the header (the host's
 * error text `retry-after-ms=…` is that header, re-rendered). Never throws:
 * an unparseable or absent hint is simply `undefined`.
 */
export function retryAfterMsFromHeaders(headers: HeaderSource | undefined): number | undefined {
  if (!headers) return undefined
  try {
    const candidates = [
      deltaMs(headerValue(headers, "retry-after-ms")),
      secondsMs(headerValue(headers, "retry-after")),
      resetMs(headerValue(headers, "x-ratelimit-reset-ms"), "ms"),
      resetMs(headerValue(headers, "x-ratelimit-reset"), "s"),
    ].filter((value): value is number => value !== undefined)
    return candidates.length > 0 ? Math.max(...candidates) : undefined
  } catch {
    return undefined
  }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`

/** Rendered report for `/egress traffic` and tests. */
export function trafficReport(): string {
  const summary = summarizeTraffic(readTraffic())
  if (summary.requests === 0) return "no requests recorded yet"
  const hops = Object.entries(summary.byHop)
    .sort((a, b) => b[1] - a[1])
    .map(([hop, count]) => `  ${hop}: ${count}`)
    .join("\n")
  const models = Object.entries(summary.byModel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([model, count]) => `  ${model}: ${count}`)
    .join("\n")
  return [
    `${summary.requests} requests, ${kb(summary.bytes)} sent, last ${summary.last ?? "?"}`,
    `by hop:`,
    hops,
    `by model:`,
    models,
    `note: the free tier publishes no server-side limits — metering is per endpoint`,
    `and only announces itself when you trip it.`,
  ].join("\n")
}
