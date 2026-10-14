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
