// Console config mirror: the harness polls GET {console}/api/v2/config every
// minute (OpencodePlugin.fetchConfig) and merges each provider's pushed
// `headers` / `settings.baseURL` into its requests. omp does the same here so
// both stay on the wire the Console dictates — today that means per-org
// `x-opencode-org-id` and the /inference/go/openai/v1 endpoint, and it keeps
// matching the harness automatically if the Console ever pushes more.
//
// The snapshot is persisted per profile (omp runs are short-lived processes,
// so an in-memory cache would serve every first request cold) with a 60s TTL:
// stale entries are served immediately while a background refresh runs, and a
// failed refresh keeps the last known config — exactly like the harness keeps
// its last snapshot.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fetchConsoleConfig, type HarnessIdentity } from "./wire"

export type ProviderOverride = {
  headers: Record<string, string>
  baseURL: string | undefined
}

export type ConsoleConfigSnapshot = {
  providers: Record<string, { headers?: Record<string, string>; settings?: { baseURL?: string } }>
  fetchedAt: number
}

const TTL_MS = 60_000
const snapshots = new Map<string, ConsoleConfigSnapshot>()

function cacheFile(): string {
  return path.join(homedir(), ".omp", "agent", "omp-go-console-config.json")
}

function loadSnapshot(key: string): ConsoleConfigSnapshot | undefined {
  const cached = snapshots.get(key)
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, ConsoleConfigSnapshot>
    // Exact org first; otherwise the freshest entry — callers without an org
    // (registration-time writes) must still see the Console-driven endpoint
    // instead of silently regressing to the catalog URL.
    const entry =
      parsed[key] ??
      Object.values(parsed)
        .filter((candidate) => candidate?.providers)
        .toSorted((a, b) => b.fetchedAt - a.fetchedAt)[0]
    if (entry?.providers) {
      snapshots.set(key, entry)
      return entry
    }
  } catch {
    // No cache yet; callers fall back to defaults and a refresh fills it.
  }
  return undefined
}

function saveSnapshot(key: string, snapshot: ConsoleConfigSnapshot): void {
  snapshots.set(key, snapshot)
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true })
    let all: Record<string, ConsoleConfigSnapshot> = {}
    try {
      all = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, ConsoleConfigSnapshot>
    } catch {
      all = {}
    }
    all[key] = snapshot
    writeFileSync(cacheFile(), JSON.stringify(all), { mode: 0o600 })
  } catch {
    // Cache persistence is best-effort; the in-memory copy still serves.
  }
}

export function providerOverride(orgId: string | undefined, providerID: string): ProviderOverride {
  const snapshot = loadSnapshot(orgId ?? "default")
  const provider = snapshot?.providers[providerID]
  return {
    headers: provider?.headers ?? {},
    baseURL: provider?.settings?.baseURL,
  }
}

/**
 * Refresh one org's config and cache the result. Callers proceed immediately;
 * the next request picks up the merge. The cache serves stale entries past the
 * TTL until a refresh lands, so a cold process never waits on the network.
 */
export function refreshConsoleConfig(input: {
  consoleBase: string
  token: string
  orgId: string | undefined
  identity?: HarnessIdentity
  cacheKey?: string
  fetch?: typeof fetch
}): Promise<void> {
  const key = input.cacheKey ?? input.orgId ?? "default"
  const previous = loadSnapshot(key)
  if (previous && Date.now() - previous.fetchedAt < TTL_MS) return Promise.resolve()
  return fetchConsoleConfig(input.consoleBase, { token: input.token, orgId: input.orgId }, {
    identity: input.identity,
    fetch: input.fetch,
  })
    .then(async (response) => {
      if (!response.ok) return
      const body = (await response.json().catch(() => undefined)) as
        | { providers?: ConsoleConfigSnapshot["providers"] }
        | undefined
      if (!body?.providers) return
      saveSnapshot(key, { providers: body.providers, fetchedAt: Date.now() })
    })
    .catch(() => undefined)
}
